import { beforeEach, describe, expect, it, vi } from "vitest";

// Admin TOTP enrolment + per-session step-up actions (D-25/D-40, TOTP-only;
// step-up added by security audit H-1). Pins: the actor gate is always called
// first, the 6-digit code validation, the ok/error mapping over
// lib/auth/admin-mfa, and that a successful verify mints the session step-up
// proof (setAdminStepUp).

const resolveAdminActor = vi.fn(async () => ({ id: "a1" }));
vi.mock("@/lib/admin", () => ({ resolveAdminActor }));

const getAuthUser = vi.fn(async () => ({ id: "a1", email: "a@b.com" }));
vi.mock("@/lib/auth", () => ({ getAuthUser }));

const setAdminStepUp = vi.fn(async () => {});
vi.mock("@/lib/auth/admin-stepup", () => ({ setAdminStepUp }));

const enrollAdminTotp = vi.fn(async () => ({
  totpURI: "otpauth://totp/SpiralClass:a@b.com?secret=SECRET&issuer=SpiralClass",
  backupCodes: ["aaaa-bbbb"],
}));
const verifyAdminTotpEnrollment = vi.fn(async () => ({
  ok: true as boolean,
  error: undefined as string | undefined,
}));
vi.mock("@/lib/auth/admin-mfa", () => ({ enrollAdminTotp, verifyAdminTotpEnrollment }));

const {
  startAdminMfaEnrollmentAction,
  verifyAdminMfaEnrollmentAction,
  verifyAdminMfaStepUpAction,
} = await import("@/app/actions/admin-mfa");

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyAdminTotpEnrollment.mockResolvedValue({ ok: true, error: undefined });
});

describe("startAdminMfaEnrollmentAction", () => {
  it("gates on the admin actor and returns the enrolment payload", async () => {
    const res = await startAdminMfaEnrollmentAction(undefined);
    expect(resolveAdminActor).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      enrolled: {
        totpURI: "otpauth://totp/SpiralClass:a@b.com?secret=SECRET&issuer=SpiralClass",
        secret: "SECRET",
      },
    });
  });

  it("surfaces an enrolment error as a message", async () => {
    enrollAdminTotp.mockRejectedValueOnce(new Error("better-auth down"));
    const res = await startAdminMfaEnrollmentAction(undefined);
    expect(res).toEqual({ error: "better-auth down" });
  });

  it("propagates an actor-gate rejection (not swallowed)", async () => {
    resolveAdminActor.mockRejectedValueOnce(new Error("forbidden"));
    await expect(startAdminMfaEnrollmentAction(undefined)).rejects.toThrow("forbidden");
    expect(enrollAdminTotp).not.toHaveBeenCalled();
  });
});

describe("verifyAdminMfaEnrollmentAction", () => {
  it("rejects a non-6-digit code without calling the core", async () => {
    const res = await verifyAdminMfaEnrollmentAction(undefined, form({ code: "123" }));
    expect(res).toHaveProperty("error");
    expect(verifyAdminTotpEnrollment).not.toHaveBeenCalled();
  });

  it("verifies a good code, reports verified, and mints the step-up proof", async () => {
    const res = await verifyAdminMfaEnrollmentAction(undefined, form({ code: "123456" }));
    expect(res).toEqual({ verified: true });
    expect(verifyAdminTotpEnrollment).toHaveBeenCalledWith("123456");
    expect(setAdminStepUp).toHaveBeenCalledWith("a1");
  });

  it("returns the core error on a bad code and does NOT mint a proof", async () => {
    verifyAdminTotpEnrollment.mockResolvedValueOnce({ ok: false, error: "Código incorrecto." });
    const res = await verifyAdminMfaEnrollmentAction(undefined, form({ code: "000000" }));
    expect(res).toEqual({ error: "Código incorrecto." });
    expect(setAdminStepUp).not.toHaveBeenCalled();
  });
});

describe("verifyAdminMfaStepUpAction", () => {
  it("rejects a non-6-digit code without calling the core", async () => {
    const res = await verifyAdminMfaStepUpAction(undefined, form({ code: "12" }));
    expect(res).toHaveProperty("error");
    expect(verifyAdminTotpEnrollment).not.toHaveBeenCalled();
    expect(setAdminStepUp).not.toHaveBeenCalled();
  });

  it("verifies a good code and mints the step-up proof for the session user", async () => {
    const res = await verifyAdminMfaStepUpAction(undefined, form({ code: "654321" }));
    expect(res).toEqual({ verified: true });
    expect(verifyAdminTotpEnrollment).toHaveBeenCalledWith("654321");
    expect(setAdminStepUp).toHaveBeenCalledWith("a1");
  });

  it("returns the core error on a bad code and does NOT mint a proof", async () => {
    verifyAdminTotpEnrollment.mockResolvedValueOnce({ ok: false, error: "Código incorrecto." });
    const res = await verifyAdminMfaStepUpAction(undefined, form({ code: "000000" }));
    expect(res).toEqual({ error: "Código incorrecto." });
    expect(setAdminStepUp).not.toHaveBeenCalled();
  });

  it("propagates an actor-gate rejection (not swallowed)", async () => {
    resolveAdminActor.mockRejectedValueOnce(new Error("forbidden"));
    await expect(verifyAdminMfaStepUpAction(undefined, form({ code: "654321" }))).rejects.toThrow(
      "forbidden",
    );
    expect(verifyAdminTotpEnrollment).not.toHaveBeenCalled();
  });
});
