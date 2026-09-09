import { describe, expect, it } from "vitest";
import {
  gateAddStudent,
  gateAddTemplate,
  gateProFeature,
  gateTemplateSet,
  upgradeNudge,
} from "@/lib/subscriptions/enforce";
import { FREE_MAX_ACTIVE_STUDENTS } from "@/lib/subscriptions/config";
import { makeFakePrisma, type FakeSub } from "./_fake-prisma";

function freeSub(teacherId: string): FakeSub {
  return {
    teacherId,
    plan: "free",
    status: "free",
    lockedPriceMinorUnits: null,
    currency: "MXN",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    comped: false,
  };
}

function proSub(teacherId: string): FakeSub {
  return { ...freeSub(teacherId), plan: "monthly", status: "active" };
}

describe("gateAddStudent (Free cap = 3 active)", () => {
  it("blocks once at the cap", async () => {
    const fake = makeFakePrisma({ subs: [freeSub("t1")], activeStudents: 3 });
    expect(await gateAddStudent("t1", fake.db)).toEqual({
      ok: false,
      limit: "students",
      cap: 3,
    });
  });
  it("allows below the cap", async () => {
    const fake = makeFakePrisma({ subs: [freeSub("t1")], activeStudents: 2 });
    expect(await gateAddStudent("t1", fake.db)).toEqual({ ok: true });
  });
  it("Pro is unlimited", async () => {
    const fake = makeFakePrisma({ subs: [proSub("t1")], activeStudents: 999 });
    expect(await gateAddStudent("t1", fake.db)).toEqual({ ok: true });
  });
});

describe("gateAddTemplate (Free cap = 1)", () => {
  it("blocks at the cap", async () => {
    const fake = makeFakePrisma({ subs: [freeSub("t1")], activeTemplates: 1 });
    expect(await gateAddTemplate("t1", fake.db)).toMatchObject({ ok: false, limit: "templates" });
  });
  it("Pro is unlimited", async () => {
    const fake = makeFakePrisma({ subs: [proSub("t1")], activeTemplates: 50 });
    expect(await gateAddTemplate("t1", fake.db)).toEqual({ ok: true });
  });
});

describe("gateTemplateSet (replace-set, grandfathered)", () => {
  it("blocks raising past the cap on Free", async () => {
    const fake = makeFakePrisma({ subs: [freeSub("t1")] });
    expect(await gateTemplateSet("t1", 2, 1, fake.db)).toMatchObject({ ok: false });
  });
  it("grandfathers an already-over-cap teacher (not increasing)", async () => {
    const fake = makeFakePrisma({ subs: [freeSub("t1")] });
    // Had 3 active (grandfathered), keeping 3 → allowed; raising to 4 → blocked.
    expect(await gateTemplateSet("t1", 3, 3, fake.db)).toEqual({ ok: true });
    expect(await gateTemplateSet("t1", 4, 3, fake.db)).toMatchObject({ ok: false });
  });
});

describe("gateProFeature (materials + custom price + lesson_notes)", () => {
  it("Free is blocked, Pro allowed", async () => {
    const free = makeFakePrisma({ subs: [freeSub("t1")] });
    const pro = makeFakePrisma({ subs: [proSub("t2")] });
    expect(await gateProFeature("t1", "materials", free.db)).toMatchObject({ ok: false });
    expect(await gateProFeature("t1", "custom_price", free.db)).toMatchObject({ ok: false });
    expect(await gateProFeature("t2", "materials", pro.db)).toEqual({ ok: true });
    expect(await gateProFeature("t2", "custom_price", pro.db)).toEqual({ ok: true });
  });

  it("gates live-notes present mode the same way (D-15: authoring free, live Pro)", async () => {
    const free = makeFakePrisma({ subs: [freeSub("t1")] });
    const pro = makeFakePrisma({ subs: [proSub("t2")] });
    expect(await gateProFeature("t1", "lesson_notes", free.db)).toMatchObject({
      ok: false,
      limit: "lesson_notes",
    });
    expect(await gateProFeature("t2", "lesson_notes", pro.db)).toEqual({ ok: true });
  });
});

// The message a teacher gets at the moment she hits a wall — which is the
// moment she decides whether to pay us. It had no test at all, which is how
// both defects below survived.
describe("upgradeNudge", () => {
  it("quotes the cap from config rather than a number written into the prose", () => {
    expect(upgradeNudge("students", "en")).toContain(String(FREE_MAX_ACTIVE_STUDENTS));
    // The old copy spelled "3" and "1" into four strings while the real caps
    // lived in subscriptions-config, so raising one would have left this
    // quoting the old number. It also wrote its own plurals as "plantilla(s)".
    expect(upgradeNudge("students", "en")).not.toContain("(s)");
    expect(upgradeNudge("templates", "en")).not.toContain("(s)");
  });

  // The same two-branch `locale === "en" ? english : spanish` shape that put
  // "Pro Mensual" on a French teacher's plan card was here too, on all seven.
  it("speaks French rather than falling through to Spanish", () => {
    const fr = upgradeNudge("students", "fr");
    expect(fr).toContain("élèves");
    expect(fr).not.toBe(upgradeNudge("students", "es-MX"));
    expect(upgradeNudge("materials", "fr")).not.toBe(upgradeNudge("materials", "es-MX"));
    expect(upgradeNudge("homework_review", "fr")).not.toBe(
      upgradeNudge("homework_review", "es-MX"),
    );
  });

  it("returns a distinct, real sentence for every gated limit in every locale", () => {
    const limits = [
      "students",
      "templates",
      "materials",
      "class_content",
      "custom_price",
      "lesson_notes",
      "homework_review",
    ] as const;
    for (const locale of ["en", "es-MX", "fr"] as const) {
      const messages = limits.map((l) => upgradeNudge(l, locale));
      expect(messages.every((m) => m.length > 0)).toBe(true);
      // A missing catalog key resolves to the key itself, which would surface
      // as a dot-namespaced string where a sentence belongs.
      expect(messages.some((m) => m.startsWith("billing."))).toBe(false);
      expect(new Set(messages).size).toBe(limits.length);
    }
  });
});
