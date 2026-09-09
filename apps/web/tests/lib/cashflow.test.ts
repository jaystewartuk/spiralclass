import { describe, expect, it } from "vitest";
import {
  summarizeCashFlow,
  summarizeOneCurrency,
  type CashFlowPackage,
  type CompletedLesson,
} from "@/lib/cashflow";

// Fixed "now" so the trailing-window math is deterministic. The 3 full months
// before this are Feb, Mar, Apr 2026; May is the current (excluded) month.
const NOW = new Date("2026-05-15T12:00:00.000Z");

function pkg(over: Partial<CashFlowPackage> = {}): CashFlowPackage {
  return {
    classesTotal: 10,
    pricePaidMinorUnits: 100_000, // 10 classes @ 100.00 MXN each
    currency: "MXN",
    status: "active",
    expiresAt: null,
    deliveredLessons: 0,
    ...over,
  };
}

describe("summarizeOneCurrency — earned vs held split", () => {
  it("splits a half-delivered active package pro-rata", () => {
    const s = summarizeOneCurrency([pkg({ deliveredLessons: 4 })], [], null, NOW, "MXN");
    expect(s.totalPaidCents).toBe(100_000);
    // 4 of 10 delivered → 40_000 earned, 6 undelivered → 60_000 held
    expect(s.earnedCents).toBe(40_000);
    expect(s.heldCents).toBe(60_000);
    expect(s.heldLessons).toBe(6);
  });

  it("counts a no-show as delivered (forfeited time is earned, not held)", () => {
    // deliveredLessons already folds completed + no_show together upstream.
    const s = summarizeOneCurrency([pkg({ deliveredLessons: 10 })], [], null, NOW, "MXN");
    expect(s.earnedCents).toBe(100_000);
    expect(s.heldCents).toBe(0);
    expect(s.heldLessons).toBe(0);
  });

  it("treats an expired package as fully earned — nothing is owed anymore", () => {
    const s = summarizeOneCurrency(
      [pkg({ status: "expired", deliveredLessons: 3 })],
      [],
      null,
      NOW,
      "MXN",
    );
    // 7 lessons unused, but expired → no held liability, all earned.
    expect(s.earnedCents).toBe(100_000);
    expect(s.heldCents).toBe(0);
    expect(s.heldLessons).toBe(0);
  });

  it("treats a past-expiry active package as fully earned too", () => {
    const s = summarizeOneCurrency(
      [
        pkg({
          deliveredLessons: 2,
          expiresAt: new Date("2026-04-01T00:00:00.000Z"), // before NOW
        }),
      ],
      [],
      null,
      NOW,
      "MXN",
    );
    expect(s.heldCents).toBe(0);
    expect(s.earnedCents).toBe(100_000);
  });

  it("still holds a paused package within its expiry window", () => {
    const s = summarizeOneCurrency(
      [
        pkg({
          status: "paused",
          deliveredLessons: 1,
          expiresAt: new Date("2026-09-01T00:00:00.000Z"), // after NOW
        }),
      ],
      [],
      null,
      NOW,
      "MXN",
    );
    expect(s.earnedCents).toBe(10_000);
    expect(s.heldCents).toBe(90_000);
    expect(s.heldLessons).toBe(9);
  });

  it("earned + held always reconciles to total received", () => {
    const pkgs = [
      pkg({ deliveredLessons: 4 }),
      pkg({ status: "expired", deliveredLessons: 1 }),
      pkg({ pricePaidMinorUnits: 33_333, classesTotal: 7, deliveredLessons: 2 }),
    ];
    const s = summarizeOneCurrency(pkgs, [], null, NOW, "MXN");
    expect(s.earnedCents + s.heldCents).toBe(s.totalPaidCents);
  });

  it("guards against a zero-class package (no divide-by-zero)", () => {
    const s = summarizeOneCurrency(
      [pkg({ classesTotal: 0, pricePaidMinorUnits: 5_000 })],
      [],
      null,
      NOW,
      "MXN",
    );
    expect(s.totalPaidCents).toBe(5_000);
    expect(s.heldCents).toBe(0);
    expect(s.earnedCents).toBe(5_000);
  });

  it("is empty for a teacher with no paid packages", () => {
    const s = summarizeOneCurrency([], [], null, NOW, "MXN");
    expect(s).toMatchObject({
      totalPaidCents: 0,
      earnedCents: 0,
      heldCents: 0,
      heldLessons: 0,
      safeMonthlySpendCents: 0,
    });
  });
});

const lesson = (iso: string, cents: number, currency = "MXN"): CompletedLesson => ({
  completedAt: new Date(iso),
  pricePerLessonMinorUnits: cents,
  currency,
});

describe("summarizeOneCurrency — safe monthly spend (steady state)", () => {
  // First delivered in Feb → 4 months of history at NOW (May) → steady state.
  const firstInFeb = new Date("2026-02-01T00:00:00Z");

  it("averages delivered revenue over the 3 full prior months once history ≥ 3 months", () => {
    const lessons = [
      lesson("2026-02-10T00:00:00Z", 10_000),
      lesson("2026-03-10T00:00:00Z", 10_000),
      lesson("2026-03-20T00:00:00Z", 20_000),
      lesson("2026-04-10T00:00:00Z", 30_000),
    ];
    // Total in-window = 70_000 over 3 months → ~23,333.
    const s = summarizeOneCurrency([], lessons, firstInFeb, NOW, "MXN");
    expect(s.safeMonthlySpendCents).toBe(Math.round(70_000 / 3));
    expect(s.provisionalMonths).toBe(0);
  });

  it("excludes the current partial month and anything older than the window", () => {
    const lessons = [
      lesson("2026-01-31T23:59:59Z", 99_999), // older than window (Jan)
      lesson("2026-05-10T00:00:00Z", 99_999), // current partial month (May)
      lesson("2026-03-15T00:00:00Z", 30_000), // in window
    ];
    const s = summarizeOneCurrency([], lessons, firstInFeb, NOW, "MXN");
    expect(s.safeMonthlySpendCents).toBe(Math.round(30_000 / 3));
    expect(s.provisionalMonths).toBe(0);
  });
});

describe("summarizeOneCurrency — safe monthly spend (warm-up)", () => {
  it("month 1: divides by 1 and includes the current partial month", () => {
    // First (and only) lesson is this month → non-zero from week one.
    const lessons = [lesson("2026-05-08T00:00:00Z", 40_000)];
    const s = summarizeOneCurrency([], lessons, new Date("2026-05-08T00:00:00Z"), NOW, "MXN");
    expect(s.safeMonthlySpendCents).toBe(40_000);
    expect(s.provisionalMonths).toBe(1);
  });

  it("month 2: divides by 2 across last month and the current partial month", () => {
    const lessons = [
      lesson("2026-04-10T00:00:00Z", 30_000),
      lesson("2026-05-09T00:00:00Z", 50_000), // current month still counts
    ];
    const s = summarizeOneCurrency([], lessons, new Date("2026-04-10T00:00:00Z"), NOW, "MXN");
    expect(s.safeMonthlySpendCents).toBe(Math.round(80_000 / 2));
    expect(s.provisionalMonths).toBe(2);
  });

  it("month 3: divides by 3, current month included, still provisional", () => {
    const lessons = [
      lesson("2026-03-05T00:00:00Z", 30_000),
      lesson("2026-04-05T00:00:00Z", 30_000),
      lesson("2026-05-05T00:00:00Z", 30_000),
    ];
    const s = summarizeOneCurrency([], lessons, new Date("2026-03-05T00:00:00Z"), NOW, "MXN");
    expect(s.safeMonthlySpendCents).toBe(30_000);
    expect(s.provisionalMonths).toBe(3);
  });

  it("never delivered: $0 and not flagged provisional", () => {
    const s = summarizeOneCurrency([], [], null, NOW, "MXN");
    expect(s.safeMonthlySpendCents).toBe(0);
    expect(s.provisionalMonths).toBe(0);
  });
});

describe("summarizeOneCurrency — current month actuals", () => {
  const firstInFeb = new Date("2026-02-01T00:00:00Z");

  it("sums only lessons completed in the current calendar month", () => {
    const lessons = [
      lesson("2026-04-10T00:00:00Z", 30_000), // prior month — excluded
      lesson("2026-05-03T00:00:00Z", 10_000), // current month
      lesson("2026-05-12T00:00:00Z", 20_000), // current month
    ];
    const s = summarizeOneCurrency([], lessons, firstInFeb, NOW, "MXN");
    expect(s.currentMonthEarnedCents).toBe(30_000);
    expect(s.currentMonthLessons).toBe(2);
  });

  it("is zero when nothing has been taught this month yet", () => {
    const lessons = [lesson("2026-04-10T00:00:00Z", 30_000)];
    const s = summarizeOneCurrency([], lessons, firstInFeb, NOW, "MXN");
    expect(s.currentMonthEarnedCents).toBe(0);
    expect(s.currentMonthLessons).toBe(0);
  });
});

describe("summarizeCashFlow — one currency (every teacher today)", () => {
  it("returns exactly one slice, and it is the primary", () => {
    const cf = summarizeCashFlow([pkg({ currency: "GBP", deliveredLessons: 4 })], [], null, NOW, {
      fallbackCurrency: "GBP",
      preferCurrency: "GBP",
    });
    expect(cf.byCurrency).toHaveLength(1);
    expect(cf.byCurrency[0]).toBe(cf.primary);
    expect(cf.primary).toMatchObject({
      currency: "GBP",
      totalPaidCents: 100_000,
      earnedCents: 40_000,
      heldCents: 60_000,
    });
  });

  it("falls back to the configured currency when there is no money at all", () => {
    const cf = summarizeCashFlow([], [], null, NOW, { fallbackCurrency: "EUR" });
    expect(cf.byCurrency).toHaveLength(1);
    expect(cf.primary).toMatchObject({ currency: "EUR", totalPaidCents: 0 });
  });
});

describe("summarizeCashFlow — more than one currency", () => {
  it("keeps unlike minor units apart instead of adding them", () => {
    // The case that made the old single-scalar version indefensible: 20,000 JPY
    // is 0-decimal and £200.00 is 2-decimal, so both are the integer 20000 and
    // the old sum reported 40000 — an error not even proportional to an FX
    // rate. Two slices, each exact, and no figure anywhere is 40000.
    const cf = summarizeCashFlow(
      [
        pkg({ currency: "JPY", pricePaidMinorUnits: 20_000, deliveredLessons: 10 }),
        pkg({ currency: "GBP", pricePaidMinorUnits: 20_000, deliveredLessons: 10 }),
      ],
      [],
      null,
      NOW,
      { fallbackCurrency: "GBP", preferCurrency: "GBP" },
    );
    expect(cf.byCurrency.map((s) => [s.currency, s.totalPaidCents])).toEqual([
      ["GBP", 20_000],
      ["JPY", 20_000],
    ]);
    expect(cf.byCurrency.every((s) => s.totalPaidCents === 20_000)).toBe(true);
  });

  it("splits earned, held and the monthly average per currency", () => {
    const firstInFeb = new Date("2026-02-01T00:00:00Z");
    const cf = summarizeCashFlow(
      [
        // Old GBP money, half delivered.
        pkg({ currency: "GBP", deliveredLessons: 5 }),
        // New EUR money, nothing delivered yet.
        pkg({ currency: "EUR", pricePaidMinorUnits: 60_000, deliveredLessons: 0 }),
      ],
      [
        lesson("2026-03-10T00:00:00Z", 30_000, "GBP"),
        lesson("2026-04-10T00:00:00Z", 60_000, "EUR"),
      ],
      firstInFeb,
      NOW,
      { fallbackCurrency: "EUR", preferCurrency: "EUR" },
    );
    const gbp = cf.byCurrency.find((s) => s.currency === "GBP")!;
    const eur = cf.byCurrency.find((s) => s.currency === "EUR")!;
    expect(gbp).toMatchObject({
      totalPaidCents: 100_000,
      earnedCents: 50_000,
      heldCents: 50_000,
      heldLessons: 5,
      safeMonthlySpendCents: 10_000, // 30_000 over 3 months
    });
    expect(eur).toMatchObject({
      totalPaidCents: 60_000,
      earnedCents: 0,
      heldCents: 60_000,
      heldLessons: 10,
      safeMonthlySpendCents: 20_000, // 60_000 over 3 months
    });
  });

  it("leads with the currency she prices in now, not the biggest pile", () => {
    // She moved to euros; the pounds are history. "Safe to spend" is a claim
    // about what she is selling in today, so that is the hero.
    const cf = summarizeCashFlow(
      [
        pkg({ currency: "GBP", pricePaidMinorUnits: 900_000 }),
        pkg({ currency: "EUR", pricePaidMinorUnits: 10_000 }),
      ],
      [],
      null,
      NOW,
      { fallbackCurrency: "EUR", preferCurrency: "EUR" },
    );
    expect(cf.primary.currency).toBe("EUR");
    expect(cf.byCurrency.map((s) => s.currency)).toEqual(["EUR", "GBP"]);
  });

  it("leads with the biggest pile when nothing is preferred (the platform roll-up)", () => {
    const cf = summarizeCashFlow(
      [
        pkg({ currency: "GBP", pricePaidMinorUnits: 10_000 }),
        pkg({ currency: "MXN", pricePaidMinorUnits: 900_000 }),
      ],
      [],
      null,
      NOW,
      { fallbackCurrency: "MXN" },
    );
    expect(cf.primary.currency).toBe("MXN");
    expect(cf.byCurrency.map((s) => s.currency)).toEqual(["MXN", "GBP"]);
  });

  it("leads with the biggest pile when the preferred currency holds nothing", () => {
    // She has switched to yen but has not sold anything in it yet: an empty
    // slice would be noise, so the money she does have leads.
    const cf = summarizeCashFlow([pkg({ currency: "GBP" })], [], null, NOW, {
      fallbackCurrency: "JPY",
      preferCurrency: "JPY",
    });
    expect(cf.byCurrency.map((s) => s.currency)).toEqual(["GBP"]);
  });

  it("keeps a refunded package's delivered lessons in their own currency", () => {
    // A refunded package is out of `packages` but its completed lessons still
    // count toward the monthly average, exactly as before the split — so the
    // currency set has to come from the lessons too, or that revenue lands in
    // the wrong slice.
    const cf = summarizeCashFlow(
      [pkg({ currency: "MXN" })],
      [lesson("2026-03-10T00:00:00Z", 30_000, "USD")],
      new Date("2026-02-01T00:00:00Z"),
      NOW,
      { fallbackCurrency: "MXN", preferCurrency: "MXN" },
    );
    const usd = cf.byCurrency.find((s) => s.currency === "USD")!;
    expect(usd.safeMonthlySpendCents).toBe(10_000);
    expect(usd.totalPaidCents).toBe(0);
    expect(cf.byCurrency.find((s) => s.currency === "MXN")!.safeMonthlySpendCents).toBe(0);
  });

  it("dates warm-up from her first lesson ever, not the slice's first", () => {
    // Four months of history means steady state in BOTH currencies. Dating the
    // retired currency's slice from its own last lesson would divide its
    // near-zero recent revenue by one month and call it a monthly income.
    const cf = summarizeCashFlow(
      [pkg({ currency: "GBP" }), pkg({ currency: "EUR" })],
      [lesson("2026-05-10T00:00:00Z", 30_000, "GBP")],
      new Date("2026-02-01T00:00:00Z"),
      NOW,
      { fallbackCurrency: "EUR", preferCurrency: "EUR" },
    );
    for (const slice of cf.byCurrency) {
      expect(slice.provisionalMonths).toBe(0);
      // The one lesson is in the current partial month, which steady state
      // excludes — so nothing is averaged into a monthly figure anywhere.
      expect(slice.safeMonthlySpendCents).toBe(0);
    }
  });
});
