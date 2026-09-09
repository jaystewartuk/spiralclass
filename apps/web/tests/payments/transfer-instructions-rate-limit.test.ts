import { beforeEach, describe, expect, it, vi } from "vitest";
import { createT } from "@spiralclass/shared";

// Security audit M-8. /b/[slug]/buy/transfer/[ref] renders the teacher's payee
// details — an account-holder name and email, or (since D-113) a CLABE, which
// is a bank account number. The slug half of that URL is public by design, so
// the only thing standing between a prober and that PII is the reference's
// entropy — which is why it was widened to 48 bits, and why
// lib/payments/reference.ts notes the instructions route "additionally
// rate-limits lookups". That claim did not hold for this page, which ran
// unthrottled, making it an oracle for the same data.
//
// The property under test is not merely "a limit exists" but that it is
// enforced BEFORE the database is touched — a limiter that runs after the
// lookup still lets an attacker distinguish a live reference from a dead one
// by timing, which is most of what enumeration needs.

const findFirst = vi.fn();
const rateLimit = vi.fn();
const clientIp = vi.fn(async () => "203.0.113.7");

vi.mock("@/lib/prisma", () => ({ prisma: { payment: { findFirst } } }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit, clientIp }));
// The funnel renders in the TEACHER's locale, not the request's — see
// publicFunnelLocaleFor. Which locale is not what this test is about, and its
// resolver is a DB lookup the prisma mock above deliberately doesn't carry.
vi.mock("@/lib/i18n", () => ({ getPublicFunnelT: () => createT("en") }));
vi.mock("@/lib/booking/funnel-locale", () => ({ funnelLocaleForSlug: async () => "en" }));
vi.mock("@/app/actions/transfer-mark-sent", () => ({ markTransferPaymentSentAction: vi.fn() }));
vi.mock("@/components/copy-link-button", () => ({ CopyLinkButton: () => null }));

class NotFoundError extends Error {}
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundError("NEXT_NOT_FOUND");
  },
}));

const { default: TransferInstructionsPage } =
  await import("@/app/b/[slug]/buy/transfer/[ref]/page");

function render() {
  return TransferInstructionsPage({
    params: Promise.resolve({ slug: "alicia-moreno", ref: "AGP-0123456789AB" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(null);
  rateLimit.mockResolvedValue({ ok: true });
});

describe("transfer instructions page — reference-enumeration throttle", () => {
  it("throttles by client IP under the shared transfer-instructions scope", async () => {
    await expect(render()).rejects.toBeInstanceOf(NotFoundError);
    expect(clientIp).toHaveBeenCalled();
    // Same scope as api/mobile/public/checkout/[slug]/wise/[ref] on purpose:
    // separate scopes would hand one attacker double the budget for free by
    // alternating between the web page and the mobile endpoint.
    // The numbers are deployment configuration (RATE_LIMIT_* — see
    // lib/rate-limit.ts), so assert the key and the scope rather than the
    // values a given environment happens to enforce.
    expect(rateLimit).toHaveBeenCalledWith(
      "203.0.113.7",
      expect.objectContaining({ scope: "transfer-instructions-ip" }),
    );
    const [, opts] = rateLimit.mock.calls[0]!;
    expect(opts.limit).toBeGreaterThan(0);
    expect(opts.windowMs).toBeGreaterThan(0);
  });

  it("never reaches the database once throttled", async () => {
    rateLimit.mockResolvedValue({ ok: false });
    await expect(render()).rejects.toBeInstanceOf(NotFoundError);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("answers a throttled request identically to an unknown reference", async () => {
    // Not a distinct 429: "slow down" on a real reference and "no such
    // reference" must be indistinguishable, or the throttle itself becomes
    // the oracle it was added to close.
    rateLimit.mockResolvedValue({ ok: false });
    const throttled = await render().catch((e: unknown) => e);

    rateLimit.mockResolvedValue({ ok: true });
    findFirst.mockResolvedValue(null);
    const unknownRef = await render().catch((e: unknown) => e);

    expect(throttled).toBeInstanceOf(NotFoundError);
    expect(unknownRef).toBeInstanceOf(NotFoundError);
    expect((throttled as Error).message).toBe((unknownRef as Error).message);
  });

  it("proceeds to the lookup when within budget", async () => {
    await expect(render()).rejects.toBeInstanceOf(NotFoundError);
    expect(findFirst).toHaveBeenCalledTimes(1);
    const where = findFirst.mock.calls[0]?.[0]?.where;
    // Scoped to the Wise rail and to this teacher's slug — a reference alone
    // is not enough to read another teacher's payee details.
    expect(where).toMatchObject({
      provider: "manual_transfer",
      paymentReference: "AGP-0123456789AB",
      package: { teacher: { bookingSlug: "alicia-moreno" } },
    });
  });
});
