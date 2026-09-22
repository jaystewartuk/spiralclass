import { describe, expect, it } from "vitest";
import {
  EMPTY_POSTHOG_IDENTITY,
  parsePostHogCookie,
  posthogCookieName,
} from "@/lib/analytics/posthog-cookie";

// Reads posthog-js's own persistence cookie server-side so a Server Component
// event (booking_page_viewed) lands on the SAME person as the browser's
// $pageview and session recording. Get this wrong and every funnel spanning
// the server and client halves of the visit reports zero conversion — while
// looking perfectly healthy.

function cookieValue(obj: unknown): string {
  return encodeURIComponent(JSON.stringify(obj));
}

describe("posthogCookieName", () => {
  it("derives the name posthog-js actually writes", () => {
    expect(posthogCookieName("phc_abc123")).toBe("ph_phc_abc123_posthog");
  });
});

describe("parsePostHogCookie", () => {
  it("extracts the distinct id and the session id from $sesid", () => {
    // $sesid is [lastActivityTs, sessionId, sessionStartTs] — the session id
    // is index 1, not 0.
    const raw = cookieValue({
      distinct_id: "0190-person",
      $sesid: [1719000000000, "0190-session", 1719000000000],
    });
    expect(parsePostHogCookie(raw)).toEqual({
      distinctId: "0190-person",
      sessionId: "0190-session",
    });
  });

  it("reads a cookie that isn't URI-encoded", () => {
    const raw = JSON.stringify({ distinct_id: "plain-person" });
    expect(parsePostHogCookie(raw).distinctId).toBe("plain-person");
  });

  it("returns the distinct id even when no session is active", () => {
    expect(parsePostHogCookie(cookieValue({ distinct_id: "p1" }))).toEqual({
      distinctId: "p1",
      sessionId: null,
    });
  });

  it("ignores a malformed $sesid rather than mis-reading a timestamp as a session", () => {
    // A numeric index 1 must not be coerced into a session id string.
    expect(
      parsePostHogCookie(cookieValue({ distinct_id: "p1", $sesid: [1, 2, 3] })).sessionId,
    ).toBeNull();
    expect(
      parsePostHogCookie(cookieValue({ distinct_id: "p1", $sesid: "nope" })).sessionId,
    ).toBeNull();
    expect(parsePostHogCookie(cookieValue({ distinct_id: "p1", $sesid: [] })).sessionId).toBeNull();
  });

  it("survives every shape a blocked, cleared or corrupted cookie can take", () => {
    // An ad-blocker or a partial write must degrade to "unknown visitor", not
    // an exception in the middle of rendering the booking page.
    for (const raw of [null, undefined, "", "not-json", "%E0%A4%A", "[]", "null", '"str"']) {
      expect(parsePostHogCookie(raw)).toEqual(EMPTY_POSTHOG_IDENTITY);
    }
  });

  it("ignores non-string identity fields", () => {
    expect(parsePostHogCookie(cookieValue({ distinct_id: 42 })).distinctId).toBeNull();
  });
});
