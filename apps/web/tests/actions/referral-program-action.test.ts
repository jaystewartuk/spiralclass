import { beforeEach, describe, expect, it, vi } from "vitest";

// The teacher-facing referral program form (slice 2b). The core save is covered
// in tests/lib/referrals-manage.test.ts; what was never covered — and what broke
// in production — is this action's parsing of the FormData the form actually
// sends.
//
// RewardFields renders EITHER the percent input OR the pesos input, never both,
// so the side that is not rendered is absent from the FormData and
// formData.get() returns null for it. Pin that null is treated as "not
// supplied" rather than coerced to 0 and failed as out of range.

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

// The action reports through the shared catalog, so the real `createT`
// resolves the messages asserted below — a stub returning the key would
// have let a missing catalog entry pass.
vi.mock("@/lib/i18n", async () => {
  const { createT } = await import("@spiralclass/shared");
  return { getPreferredLocale: vi.fn(async () => "en"), getT: vi.fn(async () => createT("en")) };
});

const saveReferralProgramCore = vi.fn(async () => undefined);
vi.mock("@/lib/referrals/manage", () => ({
  saveReferralProgram: saveReferralProgramCore,
}));

const { saveReferralProgram } = await import("@/app/actions/referrals");

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveReferralProgram", () => {
  it("saves a percent/percent program — the pesos fields are simply not in the form", async () => {
    const res = await saveReferralProgram(
      undefined,
      fd({
        enabled: "true",
        referredKind: "percent",
        referredPercent: "15",
        referrerKind: "percent",
        referrerPercent: "15",
        rewardExpiryDays: "",
      }),
    );

    expect(res).toEqual({ ok: true });
    expect(saveReferralProgramCore).toHaveBeenCalledWith("t1", {
      enabled: true,
      referred: { kind: "percent", percent: 15 },
      referrer: { kind: "percent", percent: 15 },
      rewardExpiryDays: null,
    });
  });

  it("saves a fixed/fixed program — the percent fields are the ones absent", async () => {
    const res = await saveReferralProgram(
      undefined,
      fd({
        enabled: "true",
        referredKind: "fixed",
        referredAmountPesos: "100",
        referrerKind: "fixed",
        referrerAmountPesos: "100",
        rewardExpiryDays: "90",
      }),
    );

    expect(res).toEqual({ ok: true });
    expect(saveReferralProgramCore).toHaveBeenCalledWith("t1", {
      enabled: true,
      referred: { kind: "fixed", amountPesos: 100 },
      referrer: { kind: "fixed", amountPesos: 100 },
      rewardExpiryDays: 90,
    });
  });

  it("saves a mixed program — percent to the friend, pesos to the referrer", async () => {
    const res = await saveReferralProgram(
      undefined,
      fd({
        enabled: "true",
        referredKind: "percent",
        referredPercent: "15",
        referrerKind: "fixed",
        referrerAmountPesos: "200",
      }),
    );

    expect(res).toEqual({ ok: true });
    expect(saveReferralProgramCore).toHaveBeenCalledWith("t1", {
      enabled: true,
      referred: { kind: "percent", percent: 15 },
      referrer: { kind: "fixed", amountPesos: 200 },
      rewardExpiryDays: null,
    });
  });

  it("flags the side left blank, and only that side", async () => {
    const res = await saveReferralProgram(
      undefined,
      fd({
        enabled: "true",
        referredKind: "percent",
        referredPercent: "",
        referrerKind: "percent",
        referrerPercent: "15",
      }),
    );

    expect(res?.fields?.referred).toBe("Enter a whole number between 1 and 100.");
    expect(res?.fields?.referrer).toBeUndefined();
    expect(res?.fields?.expiry).toBeUndefined();
    expect(res?.error).toBe("Check the highlighted fields.");
    expect(saveReferralProgramCore).not.toHaveBeenCalled();
  });

  it("still rejects a percent outside 1–100", async () => {
    const res = await saveReferralProgram(
      undefined,
      fd({
        enabled: "true",
        referredKind: "percent",
        referredPercent: "150",
        referrerKind: "percent",
        referrerPercent: "15",
      }),
    );

    expect(res?.fields?.referred).toBe("Enter a whole number between 1 and 100.");
    expect(saveReferralProgramCore).not.toHaveBeenCalled();
  });

  it("names the fixed side's own range rather than the percent one", async () => {
    const res = await saveReferralProgram(
      undefined,
      fd({
        enabled: "true",
        referredKind: "percent",
        referredPercent: "15",
        referrerKind: "fixed",
        referrerAmountPesos: "0",
      }),
    );

    expect(res?.fields?.referrer).toBe("Enter an amount greater than zero.");
    expect(saveReferralProgramCore).not.toHaveBeenCalled();
  });

  // The regression this replaces: an out-of-range expiry parsed unsuccessfully
  // and fell through to `null`, so the form said "Saved." and silently
  // switched the reward to never expiring — the opposite of what was typed.
  it("rejects an out-of-range expiry instead of silently saving no expiry", async () => {
    const res = await saveReferralProgram(
      undefined,
      fd({
        enabled: "true",
        referredKind: "percent",
        referredPercent: "15",
        referrerKind: "percent",
        referrerPercent: "15",
        rewardExpiryDays: "99999",
      }),
    );

    expect(res?.fields?.expiry).toBe(
      "Enter a whole number of days between 1 and 3650, or leave it blank.",
    );
    expect(saveReferralProgramCore).not.toHaveBeenCalled();
  });

  it("saves with the program switched off, so a teacher can pause without losing her numbers", async () => {
    const res = await saveReferralProgram(
      undefined,
      fd({
        referredKind: "percent",
        referredPercent: "15",
        referrerKind: "percent",
        referrerPercent: "15",
      }),
    );

    expect(res).toEqual({ ok: true });
    expect(saveReferralProgramCore).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ enabled: false }),
    );
  });
});
