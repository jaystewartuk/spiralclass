import { describe, expect, it } from "vitest";
import {
  PAYMENTS_SCOPE_STATUSES,
  PAYMENT_SEARCH_MAX_LENGTH,
  TRANSFER_OVERDUE_HOURS,
  groupPaymentsByMonth,
  monthKey,
  nextMonthKey,
  normalizePaymentSearch,
  paymentsHref,
  paymentsQuery,
  receivedByMonth,
  resolvePaymentsScope,
  transferState,
  transferWaitLabel,
  type LedgerEntry,
} from "@/lib/payments-list";

const NOW = new Date("2026-09-02T15:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("resolvePaymentsScope", () => {
  it("accepts the four known views", () => {
    expect(resolvePaymentsScope("all")).toBe("all");
    expect(resolvePaymentsScope("pending")).toBe("pending");
    expect(resolvePaymentsScope("paid")).toBe("paid");
    expect(resolvePaymentsScope("refunded")).toBe("refunded");
  });

  it("falls back to the ledger for anything else", () => {
    // A view preference, not a resource: a stale bookmark or a hand-edited URL
    // should still show her the money rather than an error.
    expect(resolvePaymentsScope(undefined)).toBe("all");
    expect(resolvePaymentsScope("")).toBe("all");
    expect(resolvePaymentsScope("PAID")).toBe("all");
    expect(resolvePaymentsScope("failed")).toBe("all");
    expect(resolvePaymentsScope("../../etc/passwd")).toBe("all");
  });

  it("takes the first value when the parameter is repeated", () => {
    expect(resolvePaymentsScope(["paid", "refunded"])).toBe("paid");
  });
});

describe("PAYMENTS_SCOPE_STATUSES", () => {
  it("leaves the ledger unfiltered so failed payments stay reachable", () => {
    // The one place a failed payment appears — there is no `failed` view on
    // purpose, so `all` has to keep showing them.
    expect(PAYMENTS_SCOPE_STATUSES.all).toBeNull();
  });

  it("maps each named view to exactly its own status", () => {
    expect(PAYMENTS_SCOPE_STATUSES.pending).toEqual(["pending"]);
    expect(PAYMENTS_SCOPE_STATUSES.paid).toEqual(["paid"]);
    expect(PAYMENTS_SCOPE_STATUSES.refunded).toEqual(["refunded"]);
  });
});

describe("normalizePaymentSearch", () => {
  it("returns an empty string for no search", () => {
    expect(normalizePaymentSearch(undefined)).toBe("");
    expect(normalizePaymentSearch("   ")).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizePaymentSearch("  AGP-1A2B3C4D ")).toBe("AGP-1A2B3C4D");
  });

  it("caps the term so a `contains` filter cannot be handed an essay", () => {
    const long = "a".repeat(PAYMENT_SEARCH_MAX_LENGTH + 40);
    expect(normalizePaymentSearch(long)).toHaveLength(PAYMENT_SEARCH_MAX_LENGTH);
  });

  it("takes the first value when the parameter is repeated", () => {
    expect(normalizePaymentSearch(["Mira", "Bea"])).toBe("Mira");
  });
});

describe("paymentsHref", () => {
  it("omits the default view, so the canonical ledger has a bare URL", () => {
    expect(paymentsHref("all")).toBe("/payments");
  });

  it("omits page 1, which is the default and would split the history entry", () => {
    expect(paymentsHref("all", "", 1)).toBe("/payments");
    expect(paymentsHref("paid", "", 1)).toBe("/payments?show=paid");
  });

  it("carries the view, the search and the page together", () => {
    expect(paymentsHref("pending", "Mira", 3)).toBe("/payments?show=pending&q=Mira&page=3");
  });

  it("encodes a term that would otherwise break the query string", () => {
    expect(paymentsHref("all", "a&b=c")).toBe("/payments?q=a%26b%3Dc");
  });
});

describe("paymentsQuery", () => {
  it("is empty for the canonical view, so the export href has no query at all", () => {
    expect(paymentsQuery("all")).toBe("");
  });

  it("describes the same selection the page links to", () => {
    // The CSV export points at a different path but must select the same rows;
    // that only holds while both are built here.
    expect(paymentsHref("paid", "Mira")).toBe(`/payments${paymentsQuery("paid", "Mira")}`);
  });
});

describe("transferState", () => {
  it("is not a job until the student says they sent the money", () => {
    // She cannot confirm a transfer that has not been made; surfacing it as an
    // action is what trains someone to ignore the action list.
    expect(transferState(null, NOW)).toEqual({ state: "awaiting_student" });
    expect(transferState(undefined, NOW)).toEqual({ state: "awaiting_student" });
  });

  it("becomes hers to confirm the moment the student marks it sent", () => {
    expect(transferState(hoursAgo(3), NOW)).toEqual({ state: "ready", hoursWaiting: 3 });
  });

  it("goes overdue on the same threshold the reminder cron nags at", () => {
    expect(transferState(hoursAgo(TRANSFER_OVERDUE_HOURS - 1), NOW).state).toBe("ready");
    expect(transferState(hoursAgo(TRANSFER_OVERDUE_HOURS), NOW).state).toBe("overdue");
  });

  it("floors the wait rather than rounding it up", () => {
    expect(transferState(new Date(NOW.getTime() - 119 * 60_000), NOW)).toEqual({
      state: "ready",
      hoursWaiting: 1,
    });
  });

  it("clamps a future timestamp to zero instead of counting backwards", () => {
    // Clock skew between the student's browser and the server is real; "-1
    // hours ago" is not a thing to render.
    expect(transferState(new Date(NOW.getTime() + 60_000), NOW)).toEqual({
      state: "ready",
      hoursWaiting: 0,
    });
  });
});

describe("transferWaitLabel", () => {
  it("says nothing while the ball is still in the student's court", () => {
    expect(transferWaitLabel({ state: "awaiting_student" })).toBeNull();
  });

  it("reads 'just now' under the hour rather than '0 hours ago'", () => {
    expect(transferWaitLabel(transferState(new Date(NOW.getTime() - 60_000), NOW))).toEqual({
      key: "web.payments.wait.justNow",
    });
  });

  it("counts hours below the overdue threshold and days above it", () => {
    expect(transferWaitLabel(transferState(hoursAgo(5), NOW))).toEqual({
      key: "web.payments.wait.hours",
      vars: { count: 5 },
    });
    expect(transferWaitLabel(transferState(hoursAgo(50), NOW))).toEqual({
      key: "web.payments.wait.days",
      vars: { count: 2 },
    });
  });
});

describe("groupPaymentsByMonth", () => {
  const entry = (iso: string, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    createdAt: new Date(iso),
    status: "paid",
    amountMinorUnits: 100_00,
    currency: "MXN",
    ...over,
  });

  it("keeps the caller's order and returns one bucket per month", () => {
    const months = groupPaymentsByMonth(
      [entry("2026-09-02T10:00:00Z"), entry("2026-08-20T10:00:00Z"), entry("2026-08-02T10:00:00Z")],
      "UTC",
    );
    expect(months.map((m) => m.key)).toEqual(["2026-09", "2026-08"]);
    expect(months[1].entries).toHaveLength(2);
  });

  it("files a payment by the TEACHER's calendar month, not UTC's", () => {
    // 7pm on 31 August in Mexico City is 1 September in UTC. Filing it under
    // September puts it on the wrong side of the line she does her books by.
    const months = groupPaymentsByMonth([entry("2026-09-01T01:00:00Z")], "America/Mexico_City");
    expect(months[0].key).toBe("2026-08");
  });

  it("dates the heading at midday so a zone behind UTC still reads the right month", () => {
    const [september] = groupPaymentsByMonth([entry("2026-09-15T10:00:00Z")], "UTC");
    expect(
      new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "long" }).format(
        september.date,
      ),
    ).toBe("September");
  });

  it("reports no months for an empty page", () => {
    expect(groupPaymentsByMonth([], "UTC")).toEqual([]);
  });
});

describe("monthKey", () => {
  it("is the teacher's calendar month, not the UTC one", () => {
    expect(monthKey(new Date("2026-09-01T01:00:00Z"), "America/Mexico_City")).toBe("2026-08");
    expect(monthKey(new Date("2026-09-01T01:00:00Z"), "UTC")).toBe("2026-09");
  });
});

describe("nextMonthKey", () => {
  it("advances within a year", () => {
    expect(nextMonthKey("2026-08")).toBe("2026-09");
  });

  it("rolls the year over at December, zero-padding the month", () => {
    expect(nextMonthKey("2026-12")).toBe("2027-01");
    expect(nextMonthKey("2026-09")).toBe("2026-10");
  });
});

describe("receivedByMonth", () => {
  const entry = (iso: string, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    createdAt: new Date(iso),
    status: "paid",
    amountMinorUnits: 100_00,
    currency: "MXN",
    ...over,
  });

  it("subtotals only money that actually landed", () => {
    const totals = receivedByMonth(
      [
        entry("2026-09-02T10:00:00Z"),
        entry("2026-09-01T10:00:00Z", { status: "pending" }),
        entry("2026-09-01T09:00:00Z", { status: "refunded" }),
        entry("2026-09-01T08:00:00Z", { status: "failed" }),
      ],
      "UTC",
    );
    expect(totals.get("2026-09")).toEqual([{ currency: "MXN", cents: 100_00 }]);
  });

  it("keeps currencies apart rather than adding minor units across them", () => {
    const totals = receivedByMonth(
      [
        entry("2026-09-02T10:00:00Z", { currency: "GBP", amountMinorUnits: 7_99 }),
        entry("2026-09-01T10:00:00Z", { currency: "MXN", amountMinorUnits: 500_00 }),
        entry("2026-09-01T09:00:00Z", { currency: "GBP", amountMinorUnits: 2_01 }),
      ],
      "UTC",
    );
    expect(totals.get("2026-09")).toEqual([
      { currency: "GBP", cents: 10_00 },
      { currency: "MXN", cents: 500_00 },
    ]);
  });

  it("separates months and omits one with nothing received", () => {
    const totals = receivedByMonth(
      [
        entry("2026-09-02T10:00:00Z", { amountMinorUnits: 300_00 }),
        entry("2026-08-02T10:00:00Z", { status: "refunded" }),
      ],
      "UTC",
    );
    expect(totals.get("2026-09")).toEqual([{ currency: "MXN", cents: 300_00 }]);
    expect(totals.has("2026-08")).toBe(false);
  });

  it("is independent of how the ledger happens to be paginated", () => {
    // The whole reason this is separate from `groupPaymentsByMonth`: the page
    // shows 25 rows, the month total must be the month's.
    const august = [
      entry("2026-08-20T10:00:00Z", { amountMinorUnits: 100_00 }),
      entry("2026-08-10T10:00:00Z", { amountMinorUnits: 250_00 }),
      entry("2026-08-01T10:00:00Z", { amountMinorUnits: 75_00 }),
    ];
    expect(receivedByMonth(august.slice(0, 1), "UTC").get("2026-08")).toEqual([
      { currency: "MXN", cents: 100_00 },
    ]);
    expect(receivedByMonth(august, "UTC").get("2026-08")).toEqual([
      { currency: "MXN", cents: 425_00 },
    ]);
  });
});
