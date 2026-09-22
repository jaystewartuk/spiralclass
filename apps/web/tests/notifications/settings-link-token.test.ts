import { describe, expect, it } from "vitest";
import {
  signNotificationSettingsToken,
  verifyNotificationSettingsToken,
} from "@/lib/notifications/settings-link-token";
import { signEmailOptOutToken } from "@/lib/email/opt-out-token";

const SECRET = "this-is-a-test-session-secret-with-enough-length";
const RECIPIENT_ID = "11111111-1111-4111-8111-111111111111";
const TEACHER_ID = "22222222-2222-4222-8222-222222222222";

describe("notification-settings link token signing", () => {
  it("round-trip: sign then verify returns the original payload (student)", () => {
    const t = signNotificationSettingsToken(
      { recipientId: RECIPIENT_ID, recipientType: "student", teacherId: TEACHER_ID },
      SECRET,
    );
    const r = verifyNotificationSettingsToken(t, SECRET);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.payload).toEqual({
      recipientId: RECIPIENT_ID,
      recipientType: "student",
      teacherId: TEACHER_ID,
    });
  });

  it("round-trip works for teacher recipients too", () => {
    const t = signNotificationSettingsToken(
      { recipientId: TEACHER_ID, recipientType: "teacher", teacherId: TEACHER_ID },
      SECRET,
    );
    const r = verifyNotificationSettingsToken(t, SECRET);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error();
    expect(r.payload.recipientType).toBe("teacher");
  });

  it("rejects a token with the wrong secret", () => {
    const t = signNotificationSettingsToken(
      { recipientId: RECIPIENT_ID, recipientType: "student", teacherId: TEACHER_ID },
      SECRET,
    );
    const r = verifyNotificationSettingsToken(t, "different-secret-of-equal-length-yes-yes");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad-signature");
  });

  it("rejects a token whose payload was tampered with", () => {
    const t = signNotificationSettingsToken(
      { recipientId: RECIPIENT_ID, recipientType: "student", teacherId: TEACHER_ID },
      SECRET,
    );
    const [enc, sig] = t.split(".");
    const tampered = `${enc.slice(0, 5)}A${enc.slice(6)}.${sig}`;
    const r = verifyNotificationSettingsToken(tampered, SECRET);
    expect(r.ok).toBe(false);
  });

  it("rejects a malformed token (no separator)", () => {
    const r = verifyNotificationSettingsToken("nodot", SECRET);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("malformed");
  });

  it("rejects an expired token (>90 days old)", () => {
    const issued = new Date("2026-01-01T00:00:00Z");
    const future = new Date("2026-04-15T00:00:00Z"); // ~104 days later
    const t = signNotificationSettingsToken(
      { recipientId: RECIPIENT_ID, recipientType: "student", teacherId: TEACHER_ID },
      SECRET,
      issued,
    );
    const r = verifyNotificationSettingsToken(t, SECRET, future);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("expired");
  });

  it("rejects a validly-signed token minted by the unrelated opt-out module", () => {
    // Different `k` discriminator — an opt-out token (same secret, same HMAC
    // scheme) must not be accepted here even though it verifies cleanly on
    // its own module.
    const optOutToken = signEmailOptOutToken(
      { studentId: RECIPIENT_ID, teacherId: TEACHER_ID },
      SECRET,
    );
    const r = verifyNotificationSettingsToken(optOutToken, SECRET);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error();
    expect(r.reason).toBe("bad-payload");
  });
});
