import { beforeEach, describe, expect, it, vi } from "vitest";

// Teacher account self-service actions (src/app/actions/teacher-account.ts):
//   * updateMyTeacherContactAction — name / phone / time zone, normalizing
//     the number and tracking only the fields that actually changed.
//   * saveTeacherNotificationPrefsAction — checkbox-presence → category map.
//   * requestTeacherEmailChangeAction — rate-limited, refuses disabled
//     accounts, delegates to the (separately tested) email-change lib.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";

const state = {
  teacher: {
    id: TEACHER_ID,
    email: "old@example.com",
    name: "Mira",
    phoneE164: null as string | null,
    timezone: "America/Mexico_City",
    country: "MX",
    stripeAccountId: null as string | null,
    locale: "en",
    disabledAt: null as Date | null,
    notificationPrefs: null as unknown,
  },
};

const trackServerEvent = vi.fn();
const teacherUpdate = vi.fn(
  async (_args: { where: unknown; data: Record<string, unknown> }) => ({}),
);
// D-53: updateMyTeacherContactAction looks for availability rules left in a
// different zone after a zone change, to warn the teacher. Defaults to "none".
const availabilityRuleFindFirst = vi.fn(async () => null as { timezone: string } | null);
const rateLimit = vi.fn(async () => ({ ok: true }));
const requestTeacherEmailChange = vi.fn(async () => ({
  ok: true,
  pendingEmail: "new@example.com",
}));
const revalidatePath = vi.fn();

vi.mock("@/lib/auth", () => ({ requireTeacher: vi.fn(async () => state.teacher) }));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "en") }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacher: { update: teacherUpdate },
    availabilityRule: { findFirst: availabilityRuleFindFirst },
  },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit }));
vi.mock("@/lib/teachers/email-change", () => ({ requestTeacherEmailChange }));
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent, flushAnalytics: vi.fn() }));

const {
  updateMyTeacherContactAction,
  updateMyTeacherCountryAction,
  saveTeacherNotificationPrefsAction,
  saveDashboardTilesAction,
  requestTeacherEmailChangeAction,
} = await import("@/app/actions/teacher-account");

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.teacher = {
    id: TEACHER_ID,
    email: "old@example.com",
    name: "Mira",
    phoneE164: null,
    timezone: "America/Mexico_City",
    country: "MX",
    stripeAccountId: null,
    locale: "en",
    disabledAt: null,
    notificationPrefs: null,
  };
});

describe("updateMyTeacherContactAction", () => {
  it("normalizes the phone number, saves, and tracks the changed fields", async () => {
    const res = await updateMyTeacherContactAction(
      undefined,
      fd({ name: "Alicia Moreno", phone: "+52 55 1234 5678", timezone: "America/Mexico_City" }),
    );
    expect(res).toEqual({ ok: "Details saved." });
    expect(teacherUpdate).toHaveBeenCalledWith({
      where: { id: TEACHER_ID },
      data: { name: "Alicia Moreno", phoneE164: "+525512345678", timezone: "America/Mexico_City" },
    });
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "teacher_contact_updated",
        properties: expect.objectContaining({ fields: ["name", "phone"] }),
      }),
    );
  });

  it("resolves a bare national number using the teacher's own country", async () => {
    state.teacher.country = "US";
    const res = await updateMyTeacherContactAction(
      undefined,
      fd({ name: "Mira", phone: "4155550123", timezone: "America/Mexico_City" }),
    );
    expect(res).toEqual({ ok: "Details saved." });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ phoneE164: "+14155550123" }) }),
    );
  });

  it("uses the submitted phoneCountry over the teacher's own payout country — the two are never locked together", async () => {
    // The teacher is based in Mexico (payout country) but her phone carries
    // a US number — the phone-country chip is independent of the "Country"
    // card/action, so this must resolve with the submitted phoneCountry.
    state.teacher.country = "MX";
    const res = await updateMyTeacherContactAction(
      undefined,
      fd({ name: "Mira", phone: "4155550123", phoneCountry: "US" }),
    );
    expect(res).toEqual({ ok: "Details saved." });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ phoneE164: "+14155550123" }) }),
    );
  });

  it("an empty phone field clears the number", async () => {
    state.teacher.phoneE164 = "+525512345678";
    const res = await updateMyTeacherContactAction(undefined, fd({ name: "Mira", phone: "" }));
    expect(res).toEqual({ ok: "Details saved." });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ phoneE164: null }) }),
    );
  });

  it("rejects an empty name without writing", async () => {
    const res = await updateMyTeacherContactAction(undefined, fd({ name: "", phone: "" }));
    expect(res).toHaveProperty("error");
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("warns when a zone change leaves working hours frozen in the old zone (D-53)", async () => {
    // Teacher relocates: current zone is Mexico City, they pick Madrid. Their
    // availability rules were written in (and stay in) Mexico City — the action
    // must save the new zone AND tell them their hours haven't moved.
    availabilityRuleFindFirst.mockResolvedValueOnce({ timezone: "America/Mexico_City" });
    const res = await updateMyTeacherContactAction(
      undefined,
      fd({ name: "Mira", phone: "", timezone: "Europe/Madrid" }),
    );
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ timezone: "Europe/Madrid" }) }),
    );
    // Only rules NOT already in the new zone count as stale.
    expect(availabilityRuleFindFirst).toHaveBeenCalledWith({
      where: { teacherId: TEACHER_ID, timezone: { not: "Europe/Madrid" } },
      select: { timezone: true },
    });
    expect(res?.ok).toContain("America/Mexico_City");
    expect(res?.ok).toContain("working hours");
  });

  it("does not warn when the zone is unchanged (no stale-rule lookup)", async () => {
    const res = await updateMyTeacherContactAction(
      undefined,
      fd({ name: "Mira", phone: "", timezone: "America/Mexico_City" }),
    );
    expect(availabilityRuleFindFirst).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: "Details saved." });
  });

  it("does not warn when the zone changed but all rules already match it", async () => {
    // A teacher who re-saved availability after moving has no stale rules.
    availabilityRuleFindFirst.mockResolvedValueOnce(null);
    const res = await updateMyTeacherContactAction(
      undefined,
      fd({ name: "Mira", phone: "", timezone: "Europe/Madrid" }),
    );
    expect(availabilityRuleFindFirst).toHaveBeenCalled();
    expect(res).toEqual({ ok: "Details saved." });
  });
});

describe("updateMyTeacherCountryAction", () => {
  it("saves a new country (uppercased) and tracks the change when no Stripe account is linked", async () => {
    const res = await updateMyTeacherCountryAction(undefined, fd({ country: "br" }));
    expect(res).toEqual({ ok: "Country saved." });
    expect(teacherUpdate).toHaveBeenCalledWith({
      where: { id: TEACHER_ID },
      data: { country: "BR" },
    });
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "teacher_contact_updated",
        properties: expect.objectContaining({ fields: ["country"] }),
      }),
    );
  });

  it("refuses to change country once Stripe is linked, and never writes", async () => {
    // Stripe fixes the connected account's country at creation — changing the
    // DB value would desync it. The guard must block before any write.
    state.teacher.stripeAccountId = "acct_123";
    const res = await updateMyTeacherCountryAction(undefined, fd({ country: "BR" }));
    expect(res).toHaveProperty("error");
    expect(teacherUpdate).not.toHaveBeenCalled();
  });

  it("is a no-op write when the country is unchanged", async () => {
    const res = await updateMyTeacherCountryAction(undefined, fd({ country: "MX" }));
    expect(res).toEqual({ ok: "Country saved." });
    expect(teacherUpdate).not.toHaveBeenCalled();
    expect(trackServerEvent).not.toHaveBeenCalled();
  });

  it("rejects an unknown / malformed country code without writing", async () => {
    expect(await updateMyTeacherCountryAction(undefined, fd({ country: "ZZ" }))).toHaveProperty(
      "error",
    );
    expect(await updateMyTeacherCountryAction(undefined, fd({ country: "Mexico" }))).toHaveProperty(
      "error",
    );
    expect(teacherUpdate).not.toHaveBeenCalled();
  });
});

describe("saveTeacherNotificationPrefsAction", () => {
  it("turns checkbox presence into a full category map (absent = off)", async () => {
    // Only class_activity is checked; the others are absent → off.
    const res = await saveTeacherNotificationPrefsAction(undefined, fd({ class_activity: "on" }));
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate).toHaveBeenCalledWith({
      where: { id: TEACHER_ID },
      data: {
        notificationPrefs: {
          class_reminders: false,
          class_activity: true,
          student_progress: false,
          subscription: false,
          growth: false,
          messages: false,
        },
        emailOptIn: false,
        pushOptIn: false,
      },
    });
  });
});

describe("saveDashboardTilesAction", () => {
  it("saves a valid reordered/hidden tile list", async () => {
    const tiles = [
      { key: "payments", hidden: false },
      { key: "classes", hidden: true },
    ];
    const res = await saveDashboardTilesAction(undefined, fd({ tiles: JSON.stringify(tiles) }));
    expect(res).toEqual({ ok: true });
    const call = teacherUpdate.mock.calls[0]?.[0];
    expect(call.where).toEqual({ id: TEACHER_ID });
    const saved = call.data.dashboardTileOrder as { key: string; hidden: boolean }[];
    expect(saved[0]).toEqual({ key: "payments", hidden: false });
    expect(saved[1]).toEqual({ key: "classes", hidden: true });
    // Re-validated + merged against the full default set server-side.
    expect(saved.length).toBeGreaterThan(2);
  });

  it("drops unknown keys instead of persisting them", async () => {
    const tiles = [{ key: "not-a-real-key", hidden: false }];
    const res = await saveDashboardTilesAction(undefined, fd({ tiles: JSON.stringify(tiles) }));
    expect(res).toEqual({ ok: true });
    const call = teacherUpdate.mock.calls[0]?.[0];
    const saved = call.data.dashboardTileOrder as { key: string; hidden: boolean }[];
    expect(saved.some((t) => t.key === "not-a-real-key")).toBe(false);
  });

  it("rejects malformed payloads without writing", async () => {
    const res = await saveDashboardTilesAction(undefined, fd({ tiles: "not json" }));
    expect(res).toHaveProperty("error");
    expect(teacherUpdate).not.toHaveBeenCalled();
  });
});

describe("requestTeacherEmailChangeAction", () => {
  it("delegates to the email-change lib and returns the pending address", async () => {
    const res = await requestTeacherEmailChangeAction(
      undefined,
      fd({ newEmail: "new@example.com" }),
    );
    expect(res).toEqual({ pendingEmail: "new@example.com" });
    expect(requestTeacherEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ newEmail: "new@example.com" }),
    );
  });

  it("refuses a disabled account before sending anything", async () => {
    state.teacher.disabledAt = new Date();
    const res = await requestTeacherEmailChangeAction(
      undefined,
      fd({ newEmail: "new@example.com" }),
    );
    expect(res).toHaveProperty("error");
    expect(requestTeacherEmailChange).not.toHaveBeenCalled();
  });

  it("surfaces a rate-limit hit", async () => {
    rateLimit.mockResolvedValueOnce({ ok: false });
    const res = await requestTeacherEmailChangeAction(
      undefined,
      fd({ newEmail: "new@example.com" }),
    );
    expect(res).toHaveProperty("error");
    expect(requestTeacherEmailChange).not.toHaveBeenCalled();
  });

  it("rejects an invalid email", async () => {
    const res = await requestTeacherEmailChangeAction(undefined, fd({ newEmail: "not-an-email" }));
    expect(res).toHaveProperty("error");
    expect(requestTeacherEmailChange).not.toHaveBeenCalled();
  });
});
