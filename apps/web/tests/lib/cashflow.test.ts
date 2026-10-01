import { describe, expect, it } from "vitest";
import {
  EARNINGS_HISTORY_MONTHS,
  apportion,
  summarizeCashFlow,
  summarizeOneCurrency,
  type BookedLesson,
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
    const s = summarizeOneCurrency([pkg({ deliveredLessons: 4 })], [], null, NOW, "MXN", "UTC");
    expect(s.totalPaidCents).toBe(100_000);
    // 4 of 10 delivered → 40_000 earned, 6 undelivered → 60_000 held
    expect(s.earnedCents).toBe(40_000);
    expect(s.heldCents).toBe(60_000);
    expect(s.heldLessons).toBe(6);
  });

  it("counts a no-show as delivered (forfeited time is earned, not held)", () => {
    // deliveredLessons already folds completed + no_show together upstream.
    const s = summarizeOneCurrency([pkg({ deliveredLessons: 10 })], [], null, NOW, "MXN", "UTC");
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
      "UTC",
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
      "UTC",
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
      "UTC",
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
    const s = summarizeOneCurrency(pkgs, [], null, NOW, "MXN", "UTC");
    expect(s.earnedCents + s.heldCents).toBe(s.totalPaidCents);
  });

  it("guards against a zero-class package (no divide-by-zero)", () => {
    const s = summarizeOneCurrency(
      [pkg({ classesTotal: 0, pricePaidMinorUnits: 5_000 })],
      [],
      null,
      NOW,
      "MXN",
      "UTC",
    );
    expect(s.totalPaidCents).toBe(5_000);
    expect(s.heldCents).toBe(0);
    expect(s.earnedCents).toBe(5_000);
  });

  it("is empty for a teacher with no paid packages", () => {
    const s = summarizeOneCurrency([], [], null, NOW, "MXN", "UTC");
    expect(s).toMatchObject({
      totalPaidCents: 0,
      earnedCents: 0,
      heldCents: 0,
      heldLessons: 0,
      currentMonthEarnedCents: 0,
      months: [],
      typicalMonth: null,
    });
  });
});

const lesson = (
  iso: string,
  cents: number,
  currency = "MXN",
  student: { id: string; name: string } = { id: "s-farid", name: "Farid" },
): CompletedLesson => ({
  taughtAt: new Date(iso),
  pricePerLessonMinorUnits: cents,
  currency,
  studentId: student.id,
  studentName: student.name,
});

describe("summarizeOneCurrency — a typical month, stated as a fact", () => {
  const firstInFeb = new Date("2026-02-10T00:00:00Z");

  it("averages her complete months and names the lowest — not this month, not her first", () => {
    const lessons = [
      lesson("2026-02-10T00:00:00Z", 10_000), // her first month: she started part-way
      lesson("2026-03-10T00:00:00Z", 30_000),
      lesson("2026-04-10T00:00:00Z", 10_000),
      lesson("2026-05-10T00:00:00Z", 99_000), // this month: not over yet
    ];
    const s = summarizeOneCurrency([], lessons, firstInFeb, NOW, "MXN", "UTC");
    expect(s.typicalMonth).toEqual({
      averageCents: 20_000,
      lowest: { month: "2026-04", earnedCents: 10_000 },
      months: 2,
    });
  });

  it("counts a month she taught nothing in — it is the one to budget from", () => {
    const lessons = [
      lesson("2026-01-10T00:00:00Z", 30_000),
      lesson("2026-03-10T00:00:00Z", 30_000),
      lesson("2026-04-10T00:00:00Z", 30_000),
    ];
    const s = summarizeOneCurrency(
      [],
      lessons,
      new Date("2026-01-10T00:00:00Z"),
      NOW,
      "MXN",
      "UTC",
    );
    expect(s.typicalMonth).toEqual({
      averageCents: 20_000,
      lowest: { month: "2026-02", earnedCents: 0 },
      months: 3,
    });
  });

  it("says nothing until two complete months exist", () => {
    const lessons = [
      lesson("2026-03-10T00:00:00Z", 30_000),
      lesson("2026-04-10T00:00:00Z", 30_000),
    ];
    const s = summarizeOneCurrency(
      [],
      lessons,
      new Date("2026-03-10T00:00:00Z"),
      NOW,
      "MXN",
      "UTC",
    );
    // March is her first month and May is not over: April alone is not "typical".
    expect(s.typicalMonth).toBeNull();
  });

  it("is null for a teacher who has never taught", () => {
    expect(summarizeOneCurrency([], [], null, NOW, "MXN", "UTC").typicalMonth).toBeNull();
  });

  it("still names the current month for a teacher who has been paid but not yet taught", () => {
    // `months` is empty for her, and the booked line ("…for the rest of
    // October") once read "…for the rest of" with nothing after it.
    const s = summarizeOneCurrency([pkg()], [], null, NOW, "MXN", "America/Mexico_City", [
      booked("2026-05-20T15:00:00Z", 10_000),
    ]);
    expect(s.months).toEqual([]);
    expect(s.currentMonth).toBe("2026-05");
    expect(s.bookedRestOfMonthLessons).toBe(1);
  });
});

const booked = (iso: string, cents: number, currency = "MXN"): BookedLesson => ({
  startsAt: new Date(iso),
  pricePerLessonMinorUnits: cents,
  currency,
});

describe("summarizeOneCurrency — the rest of this month, as booked", () => {
  const firstInFeb = new Date("2026-02-01T00:00:00Z");

  it("adds only classes still to come before her month ends", () => {
    const s = summarizeOneCurrency([], [], firstInFeb, NOW, "MXN", "UTC", [
      booked("2026-05-20T15:00:00Z", 30_000), // later this month
      booked("2026-05-28T15:00:00Z", 30_000), // later this month
      booked("2026-05-15T11:00:00Z", 30_000), // already started (NOW is 12:00)
      booked("2026-06-02T15:00:00Z", 30_000), // next month
    ]);
    expect(s.bookedRestOfMonthCents).toBe(60_000);
    expect(s.bookedRestOfMonthLessons).toBe(2);
  });

  it("cuts the month on her calendar", () => {
    // 8pm on 30 September in Mexico City; a 9pm class that evening is still
    // September's, though it is 1 October in UTC.
    const s = summarizeOneCurrency(
      [],
      [],
      firstInFeb,
      new Date("2026-10-01T02:00:00Z"),
      "MXN",
      "America/Mexico_City",
      [booked("2026-10-01T03:00:00Z", 30_000)],
    );
    expect(s.months[0].month).toBe("2026-09");
    expect(s.bookedRestOfMonthLessons).toBe(1);
  });
});

describe("summarizeOneCurrency — the year so far", () => {
  it("adds this calendar year's months and nothing from last year", () => {
    const lessons = [
      lesson("2025-12-10T00:00:00Z", 50_000),
      lesson("2026-01-10T00:00:00Z", 10_000),
      lesson("2026-03-10T00:00:00Z", 20_000),
      lesson("2026-05-10T00:00:00Z", 5_000),
    ];
    const s = summarizeOneCurrency(
      [],
      lessons,
      new Date("2025-12-10T00:00:00Z"),
      NOW,
      "MXN",
      "UTC",
    );
    expect(s.yearToDateCents).toBe(35_000);
  });
});

describe("summarizeOneCurrency — a month, student by student", () => {
  const firstInFeb = new Date("2026-02-01T00:00:00Z");
  const sofia = { id: "s-sofia", name: "Sofía" };

  it("groups a month by student, largest first, adding up to the month exactly", () => {
    // 100.00 over three classes is 33.333… each. Rounded one by one, two
    // classes and one class print 66.67 + 33.33 — fine here — but three
    // students at a third each would print 99.99 under a 100.00 total.
    const third = 10_000 / 3;
    const lessons = [
      lesson("2026-05-02T00:00:00Z", third, "MXN", sofia),
      lesson("2026-05-03T00:00:00Z", third),
      lesson("2026-05-04T00:00:00Z", third),
    ];
    const s = summarizeOneCurrency([], lessons, firstInFeb, NOW, "MXN", "UTC");
    expect(s.months[0].byStudent).toEqual([
      { studentId: "s-farid", name: "Farid", earnedCents: 6_667, lessons: 2 },
      { studentId: "s-sofia", name: "Sofía", earnedCents: 3_333, lessons: 1 },
    ]);
    const sum = s.months[0].byStudent.reduce((a, st) => a + st.earnedCents, 0);
    expect(sum).toBe(s.months[0].earnedCents);
  });

  it("is empty for a month she taught nothing in", () => {
    const s = summarizeOneCurrency(
      [],
      [lesson("2026-03-10T00:00:00Z", 10_000)],
      firstInFeb,
      NOW,
      "MXN",
      "UTC",
    );
    expect(s.months.find((m) => m.month === "2026-04")!.byStudent).toEqual([]);
  });
});

describe("apportion", () => {
  it("splits a total into integers that add up to it exactly", () => {
    expect(apportion(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(apportion(10_000, [2, 1])).toEqual([6_667, 3_333]);
  });

  it("handles nothing to split and nothing to split by", () => {
    expect(apportion(0, [])).toEqual([]);
    expect(apportion(500, [0, 0])).toEqual([0, 0]);
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
    const s = summarizeOneCurrency([], lessons, firstInFeb, NOW, "MXN", "UTC");
    expect(s.currentMonthEarnedCents).toBe(30_000);
    expect(s.currentMonthLessons).toBe(2);
  });

  it("is zero when nothing has been taught this month yet", () => {
    const lessons = [lesson("2026-04-10T00:00:00Z", 30_000)];
    const s = summarizeOneCurrency([], lessons, firstInFeb, NOW, "MXN", "UTC");
    expect(s.currentMonthEarnedCents).toBe(0);
    expect(s.currentMonthLessons).toBe(0);
  });
});

describe("summarizeOneCurrency — months are hers, and a lesson is filed where it was taught", () => {
  // A teacher in Mexico City (UTC−6, no DST since 2022). Her last class of
  // September starts at 6pm on the 30th — midnight on 1 October in UTC.
  const MX = "America/Mexico_City";
  const lastClassOfSeptember = "2026-10-01T00:00:00Z";
  const firstInJune = new Date("2026-06-03T15:00:00Z");

  it("keeps an evening class on the last day of the month in that month", () => {
    // Read at 8pm on 30 September, her time, straight after the class. Cut in
    // UTC this was already October: "this month" read as one class, and the
    // September she was closing was nowhere on screen.
    const evening = new Date("2026-10-01T02:00:00Z");
    const lessons = [lesson("2026-09-10T15:00:00Z", 50_000), lesson(lastClassOfSeptember, 50_000)];
    const s = summarizeOneCurrency([], lessons, firstInJune, evening, "MXN", MX);
    expect(s.currentMonthEarnedCents).toBe(100_000);
    expect(s.currentMonthLessons).toBe(2);
    expect(s.months[0]).toMatchObject({ month: "2026-09", earnedCents: 100_000, lessons: 2 });
  });

  it("still shows the month she just closed once the new one starts", () => {
    // The morning of 1 October, her time: this month is empty, and September
    // is right there — on the tile and at the head of the history.
    const nextMorning = new Date("2026-10-01T15:00:00Z");
    const lessons = [lesson("2026-09-10T15:00:00Z", 50_000), lesson(lastClassOfSeptember, 50_000)];
    const s = summarizeOneCurrency([], lessons, firstInJune, nextMorning, "MXN", MX);
    expect(s.currentMonthEarnedCents).toBe(0);
    expect(s.previousMonthEarnedCents).toBe(100_000);
    expect(s.previousMonthLessons).toBe(2);
    expect(s.months.slice(0, 2)).toMatchObject([
      { month: "2026-10", earnedCents: 0, lessons: 0 },
      { month: "2026-09", earnedCents: 100_000, lessons: 2 },
    ]);
  });

  it("files every month of the history on her calendar", () => {
    // Cut in UTC, the 6pm class on 31 July was August's.
    const midNovember = new Date("2026-11-15T15:00:00Z");
    const lessons = [
      lesson("2026-08-01T00:00:00Z", 90_000), // 6pm 31 July, her time
      lesson(lastClassOfSeptember, 30_000), // 6pm 30 September, her time
    ];
    const s = summarizeOneCurrency([], lessons, firstInJune, midNovember, "MXN", MX);
    const earned = Object.fromEntries(s.months.map((m) => [m.month, m.earnedCents]));
    expect(earned).toMatchObject({ "2026-07": 90_000, "2026-08": 0, "2026-09": 30_000 });
  });
});

describe("summarizeOneCurrency — earnings history", () => {
  const firstInFeb = new Date("2026-02-01T00:00:00Z");

  it("lists every month since her first, newest first, a quiet month as zero", () => {
    const lessons = [
      lesson("2026-02-10T00:00:00Z", 10_000),
      // Nothing in March: she was away. The month is listed, not skipped.
      lesson("2026-04-10T00:00:00Z", 20_000),
      lesson("2026-04-20T00:00:00Z", 20_000),
      lesson("2026-05-03T00:00:00Z", 5_000),
    ];
    const s = summarizeOneCurrency([], lessons, firstInFeb, NOW, "MXN", "UTC");
    expect(s.months).toMatchObject([
      { month: "2026-05", earnedCents: 5_000, lessons: 1 },
      { month: "2026-04", earnedCents: 40_000, lessons: 2 },
      { month: "2026-03", earnedCents: 0, lessons: 0 },
      { month: "2026-02", earnedCents: 10_000, lessons: 1 },
    ]);
  });

  it("reaches back a year at most, across the turn of the year", () => {
    const s = summarizeOneCurrency(
      [],
      [lesson("2025-06-10T00:00:00Z", 10_000), lesson("2025-06-10T00:00:00Z", 10_000)],
      new Date("2024-01-10T00:00:00Z"),
      NOW,
      "MXN",
      "UTC",
    );
    expect(s.months).toHaveLength(EARNINGS_HISTORY_MONTHS);
    expect(s.months[0].month).toBe("2026-05");
    expect(s.months.at(-1)!.month).toBe("2025-06");
    expect(s.months.at(-1)!.earnedCents).toBe(20_000);
  });

  it("is empty for a teacher who has never taught", () => {
    const s = summarizeOneCurrency([], [], null, NOW, "MXN", "UTC");
    expect(s.months).toEqual([]);
    expect(s.previousMonthEarnedCents).toBe(0);
  });

  it("rounds a month once, not each fractional lesson", () => {
    // 100.00 over three classes is 33.333… a lesson. Three of them are the
    // whole 100.00, which per-lesson rounding would print as 99.99.
    const third = 10_000 / 3;
    const lessons = [
      lesson("2026-05-02T00:00:00Z", third),
      lesson("2026-05-03T00:00:00Z", third),
      lesson("2026-05-04T00:00:00Z", third),
    ];
    const s = summarizeOneCurrency([], lessons, firstInFeb, NOW, "MXN", "UTC");
    expect(s.currentMonthEarnedCents).toBe(10_000);
    expect(s.months[0].earnedCents).toBe(10_000);
  });
});

describe("summarizeCashFlow — one currency (every teacher today)", () => {
  it("returns exactly one slice, and it is the primary", () => {
    const cf = summarizeCashFlow([pkg({ currency: "GBP", deliveredLessons: 4 })], [], null, NOW, {
      fallbackCurrency: "GBP",
      preferCurrency: "GBP",
      timeZone: "UTC",
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
    const cf = summarizeCashFlow([], [], null, NOW, { fallbackCurrency: "EUR", timeZone: "UTC" });
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
      { fallbackCurrency: "GBP", preferCurrency: "GBP", timeZone: "UTC" },
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
      { fallbackCurrency: "EUR", preferCurrency: "EUR", timeZone: "UTC" },
    );
    const gbp = cf.byCurrency.find((s) => s.currency === "GBP")!;
    const eur = cf.byCurrency.find((s) => s.currency === "EUR")!;
    expect(gbp).toMatchObject({
      totalPaidCents: 100_000,
      earnedCents: 50_000,
      heldCents: 50_000,
      heldLessons: 5,
    });
    expect(eur).toMatchObject({
      totalPaidCents: 60_000,
      earnedCents: 0,
      heldCents: 60_000,
      heldLessons: 10,
    });
    const earnedIn = (slice: typeof gbp, month: string) =>
      slice.months.find((m) => m.month === month)!.earnedCents;
    expect([earnedIn(gbp, "2026-03"), earnedIn(gbp, "2026-04")]).toEqual([30_000, 0]);
    expect([earnedIn(eur, "2026-03"), earnedIn(eur, "2026-04")]).toEqual([0, 60_000]);
  });

  it("leads with the currency she prices in now, not the biggest pile", () => {
    // She moved to euros; the pounds are history. The hero is about what she
    // is selling in today.
    const cf = summarizeCashFlow(
      [
        pkg({ currency: "GBP", pricePaidMinorUnits: 900_000 }),
        pkg({ currency: "EUR", pricePaidMinorUnits: 10_000 }),
      ],
      [],
      null,
      NOW,
      { fallbackCurrency: "EUR", preferCurrency: "EUR", timeZone: "UTC" },
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
      { fallbackCurrency: "MXN", timeZone: "UTC" },
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
      timeZone: "UTC",
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
      { fallbackCurrency: "MXN", preferCurrency: "MXN", timeZone: "UTC" },
    );
    const usd = cf.byCurrency.find((s) => s.currency === "USD")!;
    expect(usd.months.find((m) => m.month === "2026-03")!.earnedCents).toBe(30_000);
    expect(usd.totalPaidCents).toBe(0);
    const mxn = cf.byCurrency.find((s) => s.currency === "MXN")!;
    expect(mxn.months.every((m) => m.earnedCents === 0)).toBe(true);
  });

  it("starts every currency's history at her first lesson ever, not the slice's first", () => {
    // Dating a slice from its own first lesson would hide the months it was
    // quiet, and call a currency she barely used "typical".
    const cf = summarizeCashFlow(
      [pkg({ currency: "GBP" }), pkg({ currency: "EUR" })],
      [lesson("2026-05-10T00:00:00Z", 30_000, "GBP")],
      new Date("2026-02-01T00:00:00Z"),
      NOW,
      { fallbackCurrency: "EUR", preferCurrency: "EUR", timeZone: "UTC" },
    );
    for (const slice of cf.byCurrency) {
      expect(slice.months.map((m) => m.month)).toEqual([
        "2026-05",
        "2026-04",
        "2026-03",
        "2026-02",
      ]);
    }
    expect(cf.byCurrency.find((s) => s.currency === "GBP")!.currentMonthEarnedCents).toBe(30_000);
  });
});
