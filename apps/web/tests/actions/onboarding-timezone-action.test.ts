import { beforeEach, describe, expect, it, vi } from "vitest";

// saveTimezoneAction (web onboarding step 1) — parity check with the mobile
// route (tests/mobile/onboarding-timezone-route.test.ts): the phone is
// normalized using the country submitted in the same form, falling back to
// the teacher's existing country when the form omits it.

class RedirectError extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent: vi.fn(), flushAnalytics: vi.fn() }));
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateTemplateSet: vi.fn(),
  upgradeNudge: vi.fn(),
}));

const state: {
  teacher: {
    id: "t1";
    country: string;
    stripeAccountId?: string;
    // Absent/null = untouched starter availability, the state the re-stamp
    // applies to. Optional so the cases that predate it stay as they were.
    availabilityTouchedAt?: Date | null;
  };
} = {
  teacher: { id: "t1", country: "MX" },
};

vi.mock("@/lib/auth", () => ({ requireTeacher: vi.fn(async () => state.teacher) }));

const teacherUpdate = vi.fn(async (_arg: { data: Record<string, unknown> }) => ({}));
const availabilityRuleUpdateMany = vi.fn(async () => ({ count: 5 }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: { update: teacherUpdate },
    availabilityRule: { updateMany: availabilityRuleUpdateMany },
  },
}));

const ensureTeacherFocusTags = vi.fn(async () => {});
vi.mock("@/lib/focus-tags", () => ({ ensureTeacherFocusTags }));

const { saveTimezoneAction } = await import("@/app/actions/onboarding");

// `targetLanguage` is required as of D-112, so every case that isn't about the
// language supplies one by default rather than repeating it. Pass an explicit
// "" to exercise the missing case.
function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  const withLanguage = { targetLanguage: "es", ...entries };
  for (const [k, v] of Object.entries(withLanguage)) f.set(k, v);
  return f;
}

async function run(f: FormData) {
  try {
    return await saveTimezoneAction(undefined, f);
  } catch (err) {
    if (err instanceof RedirectError) return { redirectTo: err.url };
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.teacher = { id: "t1", country: "MX" };
});

describe("saveTimezoneAction", () => {
  it("resolves a bare national number using the country submitted in the same form", async () => {
    const res = await run(
      fd({ timezone: "Europe/London", phoneE164: "7911123456", country: "GB" }),
    );
    expect(res).toEqual({ redirectTo: "/onboarding/availability" });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phoneE164: "+447911123456", country: "GB" }),
      }),
    );
  });

  it("uses the submitted phoneCountry over the payout country — the two are never locked together", async () => {
    // A teacher based in the UK (payout country) with a US phone number —
    // the phone-country chip is independent of the general "Country" field.
    const res = await run(
      fd({
        timezone: "Europe/London",
        phoneE164: "4155550123",
        country: "GB",
        phoneCountry: "US",
      }),
    );
    expect(res).toEqual({ redirectTo: "/onboarding/availability" });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phoneE164: "+14155550123", country: "GB" }),
      }),
    );
  });

  it("falls back to the teacher's existing country when the form omits one", async () => {
    state.teacher = { id: "t1", country: "US" };
    const res = await run(fd({ timezone: "America/Mexico_City", phoneE164: "4155550123" }));
    expect(res).toEqual({ redirectTo: "/onboarding/availability" });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ phoneE164: "+14155550123" }) }),
    );
  });

  it("persists the submitted pricing currency (D-64)", async () => {
    const res = await run(
      fd({
        timezone: "Europe/London",
        phoneE164: "7911123456",
        country: "GB",
        pricingCurrency: "GBP",
      }),
    );
    expect(res).toEqual({ redirectTo: "/onboarding/availability" });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ pricingCurrency: "GBP" }) }),
    );
  });

  it("rejects a pricing currency outside the curated list", async () => {
    const res = await run(
      fd({ timezone: "America/Mexico_City", phoneE164: "5512345678", pricingCurrency: "ISK" }),
    );
    expect(res).toEqual({ error: "Invalid currency" });
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("refuses a country change once a live Stripe account exists", async () => {
    state.teacher = { id: "t1", country: "GB", stripeAccountId: "acct_1" };
    const res = await run(
      fd({ timezone: "America/Mexico_City", phoneE164: "5512345678", country: "MX" }),
    );
    expect(res).toHaveProperty("error");
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("still allows re-saving the SAME country once a Stripe account exists", async () => {
    state.teacher = { id: "t1", country: "GB", stripeAccountId: "acct_1" };
    const res = await run(
      fd({ timezone: "Europe/London", phoneE164: "7911123456", country: "GB" }),
    );
    expect(res).toEqual({ redirectTo: "/onboarding/availability" });
    expect(teacherUpdate).toHaveBeenCalled();
  });
});

// D-112: the teaching language is asked at step 1 rather than left to Settings,
// and seeded there, because `getTeacherFocusTags` self-seeds on the first empty
// read — a null language writes the generic pack permanently, and D-20 seeding
// is additive, so a language set afterwards stacks its pack on top instead of
// replacing it.
describe("saveTimezoneAction — teaching language (D-112)", () => {
  it("persists the submitted teaching language", async () => {
    const res = await run(
      fd({ timezone: "America/Mexico_City", phoneE164: "5512345678", targetLanguage: "fr" }),
    );
    expect(res).toEqual({ redirectTo: "/onboarding/availability" });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ targetLanguage: "fr" }) }),
    );
  });

  it("seeds the focus-tag pack for that language in the same step", async () => {
    await run(
      fd({ timezone: "America/Mexico_City", phoneE164: "5512345678", targetLanguage: "fr" }),
    );
    expect(ensureTeacherFocusTags).toHaveBeenCalledWith("t1", "fr", "en");
  });

  it("rejects a blank teaching language and writes nothing", async () => {
    const res = await run(
      fd({ timezone: "America/Mexico_City", phoneE164: "5512345678", targetLanguage: "" }),
    );
    expect(res).toEqual({ error: "Pick the language you teach." });
    expect(teacherUpdate).not.toHaveBeenCalled();
    expect(ensureTeacherFocusTags).not.toHaveBeenCalled();
  });

  it("rejects a code outside the language registry", async () => {
    const res = await run(
      fd({ timezone: "America/Mexico_City", phoneE164: "5512345678", targetLanguage: "zzz" }),
    );
    expect(res).toEqual({ error: "Unknown language" });
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("does not let a failed seed block onboarding — the picker self-heals on read", async () => {
    ensureTeacherFocusTags.mockRejectedValueOnce(new Error("db down"));
    const res = await run(
      fd({ timezone: "America/Mexico_City", phoneE164: "5512345678", targetLanguage: "es" }),
    );
    expect(res).toEqual({ redirectTo: "/onboarding/availability" });
  });
});

// Provisioning seeds the starter availability rows before anything is known
// about where she is (FALLBACK_TIMEZONE), and step 2 only rewrites them when
// she submits the availability form. Without this re-stamp a teacher who
// completed step 1 and skipped step 2 had her bookable slots computed against
// a wall clock that was not hers.
describe("saveTimezoneAction — starter availability", () => {
  it("re-stamps untouched starter rules with the zone she just declared", async () => {
    state.teacher = { id: "t1", country: "MX", availabilityTouchedAt: null };
    await run(fd({ timezone: "Europe/Madrid", phoneE164: "612345678", country: "ES" }));
    expect(availabilityRuleUpdateMany).toHaveBeenCalledWith({
      where: { teacherId: "t1" },
      data: { timezone: "Europe/Madrid" },
    });
  });

  it("leaves rules alone once she has submitted real hours (D-53 freeze)", async () => {
    state.teacher = {
      id: "t1",
      country: "MX",
      availabilityTouchedAt: new Date("2026-08-01T00:00:00Z"),
    };
    await run(fd({ timezone: "Europe/Madrid", phoneE164: "612345678", country: "ES" }));
    expect(availabilityRuleUpdateMany).not.toHaveBeenCalled();
  });
});
