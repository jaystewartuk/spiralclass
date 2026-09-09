import { describe, expect, it } from "vitest";

import { signOAuthState, verifyOAuthState, emailFromIdToken } from "@/lib/calendar/google/oauth";
import { parseFreeBusy } from "@/lib/calendar/google/freebusy";

const SECRET = "test-session-secret-at-least-16-chars";
const TEACHER = "11111111-1111-1111-1111-111111111111";

describe("OAuth state token", () => {
  it("round-trips the teacher id", () => {
    const state = signOAuthState(TEACHER, SECRET);
    const result = verifyOAuthState(state, SECRET);
    expect(result).toEqual({ ok: true, teacherId: TEACHER });
  });

  it("rejects a tampered payload", () => {
    const state = signOAuthState(TEACHER, SECRET);
    const [, sig] = state.split(".");
    const forged = `${Buffer.from(JSON.stringify({ t: "evil", e: Math.floor(Date.now() / 1000) }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}.${sig}`;
    expect(verifyOAuthState(forged, SECRET).ok).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const state = signOAuthState(TEACHER, SECRET);
    expect(verifyOAuthState(state, "another-secret-at-least-16chars").ok).toBe(false);
  });

  it("rejects an expired token", () => {
    const old = new Date(Date.now() - 60 * 60 * 1000); // 1h ago, TTL is 15m
    const state = signOAuthState(TEACHER, SECRET, old);
    const result = verifyOAuthState(state, SECRET);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects malformed input", () => {
    expect(verifyOAuthState("nonsense", SECRET).ok).toBe(false);
  });
});

describe("emailFromIdToken", () => {
  it("extracts the email claim from an id_token payload", () => {
    const payload = Buffer.from(JSON.stringify({ email: "mira@example.com", sub: "123" }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const idToken = `header.${payload}.signature`;
    expect(emailFromIdToken(idToken)).toBe("mira@example.com");
  });

  it("returns null for missing or malformed tokens", () => {
    expect(emailFromIdToken(null)).toBeNull();
    expect(emailFromIdToken("not-a-jwt")).toBeNull();
  });
});

describe("parseFreeBusy", () => {
  it("maps primary calendar busy blocks to intervals", () => {
    const intervals = parseFreeBusy({
      calendars: {
        primary: {
          busy: [
            { start: "2026-06-15T16:00:00Z", end: "2026-06-15T17:00:00Z" },
            { start: "2026-06-16T09:00:00Z", end: "2026-06-16T10:30:00Z" },
          ],
        },
      },
    });
    expect(intervals).toHaveLength(2);
    expect(intervals[0].startsAt.toISOString()).toBe("2026-06-15T16:00:00.000Z");
    expect(intervals[0].endsAt.toISOString()).toBe("2026-06-15T17:00:00.000Z");
  });

  it("drops invalid or zero-length intervals and handles an empty calendar", () => {
    expect(parseFreeBusy({})).toEqual([]);
    expect(parseFreeBusy({ calendars: { primary: { busy: [] } } })).toEqual([]);
    const intervals = parseFreeBusy({
      calendars: {
        primary: {
          busy: [
            { start: "bad", end: "2026-06-15T17:00:00Z" },
            { start: "2026-06-15T18:00:00Z", end: "2026-06-15T18:00:00Z" }, // zero-length
          ],
        },
      },
    });
    expect(intervals).toEqual([]);
  });
});
