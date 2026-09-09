import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";

import { scrubSentryEvent } from "@/lib/sentry-scrub";

// PII-scrubbing is a one-way door: anything we forget to mask is on its way
// to the Sentry SaaS. The tests below pin both the key-based and regex-based
// passes, plus the user-object stripping that keeps the auth id but drops
// the email.

function ev(partial: Partial<ErrorEvent>): ErrorEvent {
  return partial as ErrorEvent;
}

describe("scrubSentryEvent — key-based redaction", () => {
  it("masks values under known PII keys anywhere in the event tree", () => {
    const out = scrubSentryEvent(
      ev({
        extra: {
          email: "mira@example.com",
          password: "supersecret",
          clabe: "012180012345678901",
          phone: "+5215512345678",
          publicWhatsappE164: "+5215512345678",
          nested: { token: "abc.def.ghi", studentName: "Marco" },
        },
      }),
    );
    const extra = out.extra as Record<string, unknown>;
    expect(extra.email).toBe("[redacted]");
    expect(extra.password).toBe("[redacted]");
    expect(extra.clabe).toBe("[redacted]");
    expect(extra.phone).toBe("[redacted]");
    expect(extra.publicWhatsappE164).toBe("[redacted]");
    const nested = extra.nested as Record<string, unknown>;
    expect(nested.token).toBe("[redacted]");
    expect(nested.studentName).toBe("[redacted]");
  });

  it("preserves non-PII keys verbatim", () => {
    const out = scrubSentryEvent(
      ev({
        extra: { orderId: "ord_123", success: true, count: 7 },
      }),
    );
    expect(out.extra).toMatchObject({ orderId: "ord_123", success: true, count: 7 });
  });

  it("walks nested arrays + objects", () => {
    const out = scrubSentryEvent(
      ev({
        contexts: {
          payload: {
            users: [{ email: "a@b.com" }, { email: "c@d.com" }, "stray a@b.com note"],
          },
        } as ErrorEvent["contexts"],
      }),
    );
    const ctx = out.contexts as Record<string, Record<string, Record<string, unknown[]>>>;
    const users = ctx.payload.payload === undefined ? ctx.payload.users : [];
    // Just navigate manually:
    const flatUsers = (out.contexts as { payload: { users: unknown[] } }).payload.users;
    expect(flatUsers[0]).toEqual({ email: "[redacted]" });
    expect(flatUsers[1]).toEqual({ email: "[redacted]" });
    // String members of arrays still pass through the regex scrubber.
    expect(flatUsers[2]).toBe("stray [redacted-email] note");
    // Avoid lint warning on unused `users`.
    void users;
  });
});

describe("scrubSentryEvent — regex-based scrubbing of free text", () => {
  it("redacts emails in event.message and exception values", () => {
    const out = scrubSentryEvent(
      ev({
        message: "Boom while serving mira@example.com",
        exception: {
          values: [
            {
              type: "Error",
              value: "Could not load mira@example.com",
            },
          ],
        },
      }),
    );
    expect(out.message).toBe("Boom while serving [redacted-email]");
    expect(out.exception?.values?.[0].value).toBe("Could not load [redacted-email]");
  });

  it("redacts phone numbers (E.164 and bare 10-digit)", () => {
    const out = scrubSentryEvent(
      ev({ message: "Sent SMS to +5215512345678, fallback 5512345678" }),
    );
    expect(out.message).toBe("Sent SMS to [redacted-phone], fallback [redacted-phone]");
  });

  // D-124 opened the payout rail past Mexico, so the numeric rule covers the
  // whole 15-22 band rather than exactly 18: a CLABE (18), a Peruvian CCI
  // (20), an Argentine CBU (22) and the long domestic account numbers either
  // side of them all reach logs the same way.
  it.each([
    ["CLABE", "012180012345678901"],
    ["CCI", "00219300123456789012"],
    ["CBU", "0170099220000067797899"],
    ["a 15-digit account", "123456789012345"],
  ])("redacts %s as a whole, ahead of the phone rule", (_label, digits) => {
    const out = scrubSentryEvent(ev({ message: `Got ${digits}, sent OK.` }));
    expect(out.message).toContain("[redacted-bank-account]");
    expect(out.message).not.toContain(digits);
    expect(out.message).not.toMatch(/\d{10,}/);
  });

  // An IBAN is not all digits, so the numeric rule alone would leave its
  // country and bank prefix behind. It is matched explicitly, and BEFORE the
  // numeric rule so its trailing digits aren't eaten first.
  it("redacts an IBAN whole, including its non-numeric prefix", () => {
    const out = scrubSentryEvent(ev({ message: "payout to GB82WEST12345698765432 failed" }));
    expect(out.message).toBe("payout to [redacted-bank-account] failed");
  });

  it("treats a 23-digit run as a phone match plus a tail (band boundary)", () => {
    // Above the 22-digit ceiling the numeric bank rule stops matching and
    // PHONE_RE's 10-15 window takes the first 15 digits. This test exists so
    // we notice if the boundary behaviour ever changes.
    const out = scrubSentryEvent(ev({ message: "stray 01218001234567890123456 in logs" }));
    expect(out.message).toContain("[redacted-phone]");
    expect(out.message).not.toContain("012180012345678901");
  });

  // The whole `details` blob on a payout instrument is redacted by KEY, not
  // by pattern: its fields are per-country and open-ended (D-124), so
  // enumerating what might be inside it is the one approach guaranteed to
  // miss a country added later.
  it("redacts a payout instrument's details object wholesale", () => {
    const out = scrubSentryEvent(
      ev({
        extra: {
          instrument: { schemeId: "ng_nuban", details: { accountNumber: "0123456785" } },
        },
      }),
    );
    const instrument = (out.extra?.instrument ?? {}) as Record<string, unknown>;
    expect(instrument.details).toBe("[redacted]");
    // The scheme id is a FORMAT name, not an account — it stays, because it is
    // what makes a payout bug diagnosable at all.
    expect(instrument.schemeId).toBe("ng_nuban");
  });

  it("does not touch innocuous numeric strings shorter than 10 digits", () => {
    const out = scrubSentryEvent(ev({ message: "User id 12345 errored" }));
    expect(out.message).toBe("User id 12345 errored");
  });
});

describe("scrubSentryEvent — request, breadcrumbs, and user", () => {
  it("scrubs request.data (PII bodies) and request.query_string regex bits", () => {
    const out = scrubSentryEvent(
      ev({
        request: {
          method: "POST",
          url: "https://x/y?email=mira%40example.com",
          query_string: "email=mira@example.com",
          data: { email: "mira@example.com", note: "Call +5215512345678" },
        } as ErrorEvent["request"],
      }),
    );
    expect(out.request).toBeDefined();
    const req = out.request as Record<string, unknown>;
    const data = req.data as Record<string, unknown>;
    expect(data.email).toBe("[redacted]");
    expect(data.note).toBe("Call [redacted-phone]");
    expect(req.query_string).toBe("email=[redacted-email]");
  });

  it("scrubs each breadcrumb's message and data", () => {
    const out = scrubSentryEvent(
      ev({
        breadcrumbs: [
          {
            message: "Fetched /api/x for mira@example.com",
            data: { email: "mira@example.com" },
          },
          { message: "Plain message" },
        ],
      }),
    );
    expect(out.breadcrumbs?.[0].message).toBe("Fetched /api/x for [redacted-email]");
    expect((out.breadcrumbs?.[0].data as Record<string, unknown>).email).toBe("[redacted]");
    expect(out.breadcrumbs?.[1].message).toBe("Plain message");
  });

  it("keeps user.id and ip_address but drops email/username", () => {
    const out = scrubSentryEvent(
      ev({
        user: {
          id: "user_123",
          ip_address: "1.2.3.4",
          email: "mira@example.com",
          username: "mira",
        } as ErrorEvent["user"],
      }),
    );
    expect(out.user).toEqual({ id: "user_123", ip_address: "1.2.3.4" });
  });

  it("is a no-op when the event has no PII surfaces", () => {
    const empty: ErrorEvent = { event_id: "abc" } as ErrorEvent;
    expect(scrubSentryEvent({ ...empty })).toEqual(empty);
  });
});
