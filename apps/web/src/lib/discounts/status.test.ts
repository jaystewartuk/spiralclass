import { describe, expect, it } from "vitest";
import {
  EXPIRING_SOON_DAYS,
  expiryInstant,
  REJECTION_FOR_STATE,
  RUNNING_OUT_USES,
  compareForList,
  daysUntilExpiry,
  discountState,
  discountUrgency,
  totalsByCode,
  totalsByCurrency,
  usesLeft,
  type RedemptionFact,
} from "./status";

const NOW = new Date("2026-09-02T12:00:00.000Z");

// The stored shape: a chosen YYYY-MM-DD pinned to end-of-day UTC.
const endOfDay = (ymd: string) => new Date(`${ymd}T23:59:59.999Z`);

const code = (over: Partial<Parameters<typeof discountState>[0]> = {}) => ({
  active: true,
  expiresAt: null,
  maxRedemptions: null,
  usedCount: 0,
  ...over,
});

describe("expiryInstant", () => {
  it("pins a picked date to the end of that UTC day", () => {
    // The one definition of the convention: the writer stores it, the create
    // action validates against it, and daysUntilExpiry reads it back. It lived
    // as a literal inside the writer, where nothing else could see it.
    expect(expiryInstant("2026-09-30").toISOString()).toBe("2026-09-30T23:59:59.999Z");
  });

  it("agrees with the end-of-day the fixture builder assumes", () => {
    expect(expiryInstant("2026-09-02").getTime()).toBe(endOfDay("2026-09-02").getTime());
  });
});

describe("discountState", () => {
  it("is live when active, unexpired and under the cap", () => {
    expect(discountState(code(), NOW)).toBe("live");
    expect(
      discountState(
        code({ expiresAt: endOfDay("2026-12-31"), maxRedemptions: 10, usedCount: 9 }),
        NOW,
      ),
    ).toBe("live");
  });

  it("is paused when the teacher deactivated it", () => {
    expect(discountState(code({ active: false }), NOW)).toBe("paused");
  });

  it("is expired once the stored end-of-day has passed", () => {
    expect(discountState(code({ expiresAt: endOfDay("2026-09-01") }), NOW)).toBe("expired");
    // The last day is still a working day right up to 23:59:59.999Z.
    expect(discountState(code({ expiresAt: endOfDay("2026-09-02") }), NOW)).toBe("live");
  });

  it("is usedUp once live redemptions reach the cap", () => {
    expect(discountState(code({ maxRedemptions: 3, usedCount: 3 }), NOW)).toBe("usedUp");
    expect(discountState(code({ maxRedemptions: 3, usedCount: 2 }), NOW)).toBe("live");
    // An uncapped code never reaches this state, however popular.
    expect(discountState(code({ usedCount: 999 }), NOW)).toBe("live");
  });

  it("resolves a code that is several kinds of dead in the checkout's own order", () => {
    // This is the property that keeps the badge and the student's error the
    // same sentence: resolveAndValidateDiscount tests inactive, then expired,
    // then the cap, and returns the FIRST that hits.
    const everything = code({
      active: false,
      expiresAt: endOfDay("2026-01-01"),
      maxRedemptions: 1,
      usedCount: 5,
    });
    expect(discountState(everything, NOW)).toBe("paused");
    expect(discountState({ ...everything, active: true }, NOW)).toBe("expired");
    expect(discountState({ ...everything, active: true, expiresAt: null }, NOW)).toBe("usedUp");
  });

  it("maps every non-live state onto the rejection a student would see", () => {
    expect(REJECTION_FOR_STATE).toEqual({
      paused: "inactive",
      expired: "expired",
      usedUp: "max_redemptions",
    });
  });
});

describe("usesLeft", () => {
  it("is null when uncapped", () => {
    expect(usesLeft({ maxRedemptions: null, usedCount: 4 })).toBeNull();
  });

  it("never goes below zero, even if a cap was lowered under the count", () => {
    expect(usesLeft({ maxRedemptions: 10, usedCount: 4 })).toBe(6);
    expect(usesLeft({ maxRedemptions: 2, usedCount: 7 })).toBe(0);
  });
});

describe("daysUntilExpiry", () => {
  it("counts whole UTC calendar days, with today as 0", () => {
    expect(daysUntilExpiry(endOfDay("2026-09-02"), NOW)).toBe(0);
    expect(daysUntilExpiry(endOfDay("2026-09-03"), NOW)).toBe(1);
    expect(daysUntilExpiry(endOfDay("2026-09-09"), NOW)).toBe(7);
  });

  it("is null with no expiry, or one already passed", () => {
    expect(daysUntilExpiry(null, NOW)).toBeNull();
    expect(daysUntilExpiry(endOfDay("2026-09-01"), NOW)).toBeNull();
  });

  it("does not round a late-in-the-day 'today' up to tomorrow", () => {
    // 23:00Z on the last day: still today, and the naive (expiry - now) / day
    // arithmetic this replaced would have reported 1.
    expect(daysUntilExpiry(endOfDay("2026-09-02"), new Date("2026-09-02T23:00:00.000Z"))).toBe(0);
  });
});

describe("discountUrgency", () => {
  it("says nothing about a code that is not live", () => {
    expect(
      discountUrgency(code({ active: false, maxRedemptions: 5, usedCount: 4 }), NOW),
    ).toBeNull();
  });

  it("says nothing about a code with room at both ends", () => {
    expect(
      discountUrgency(code({ expiresAt: endOfDay("2026-12-31"), maxRedemptions: 50 }), NOW),
    ).toBeNull();
  });

  it("flags an expiry inside the window", () => {
    expect(discountUrgency(code({ expiresAt: endOfDay("2026-09-05") }), NOW)).toEqual({
      kind: "expiring",
      days: 3,
    });
    // A month out is not news.
    expect(discountUrgency(code({ expiresAt: endOfDay("2026-09-30") }), NOW)).toBeNull();
  });

  it("flags a cap the code is about to hit", () => {
    expect(discountUrgency(code({ maxRedemptions: 10, usedCount: 8 }), NOW)).toEqual({
      kind: "runningOut",
      left: 2,
    });
  });

  it("shows one warning, not two, and prefers the cap", () => {
    // Both ends are in sight. The cap can be reached this afternoon by people
    // who already hold the code; the date arrives on a schedule.
    expect(
      discountUrgency(
        code({ expiresAt: endOfDay("2026-09-04"), maxRedemptions: 10, usedCount: 9 }),
        NOW,
      ),
    ).toEqual({ kind: "runningOut", left: 1 });
  });

  it("uses the published thresholds", () => {
    expect(
      discountUrgency(code({ maxRedemptions: 20, usedCount: 20 - RUNNING_OUT_USES }), NOW),
    ).toEqual({ kind: "runningOut", left: RUNNING_OUT_USES });
    const lastDayInWindow = new Date(NOW.getTime() + EXPIRING_SOON_DAYS * 86_400_000);
    expect(discountUrgency(code({ expiresAt: lastDayInWindow }), NOW)).toEqual({
      kind: "expiring",
      days: EXPIRING_SOON_DAYS,
    });
  });
});

describe("totalsByCode", () => {
  const fact = (over: Partial<RedemptionFact> = {}): RedemptionFact => ({
    discountCodeId: "c1",
    amountMinorUnits: 1000,
    currency: "GBP",
    paidMinorUnits: 8000,
    paidCurrency: "GBP",
    ...over,
  });

  it("counts uses and sums the discount given, per code", () => {
    const totals = totalsByCode([
      fact(),
      fact(),
      fact({ discountCodeId: "c2", amountMinorUnits: 250 }),
    ]);
    expect(totals.get("c1")).toEqual({ used: 2, givenMinorUnits: 2000, salesMinorUnits: 16000 });
    expect(totals.get("c2")).toEqual({ used: 1, givenMinorUnits: 250, salesMinorUnits: 8000 });
  });

  it("omits a code with no live redemptions entirely", () => {
    expect(totalsByCode([]).get("c1")).toBeUndefined();
  });

  it("counts an unsettled purchase as a use but not as a sale", () => {
    // The manual-transfer rail creates the package the moment the student
    // commits. Its use is spent; its money has not arrived.
    const totals = totalsByCode([fact({ paidMinorUnits: null, paidCurrency: null })]);
    expect(totals.get("c1")).toEqual({ used: 1, givenMinorUnits: 1000, salesMinorUnits: 0 });
  });

  it("refuses to add a sale denominated in another currency", () => {
    const totals = totalsByCode([fact({ paidMinorUnits: 200000, paidCurrency: "MXN" })]);
    expect(totals.get("c1")).toEqual({ used: 1, givenMinorUnits: 1000, salesMinorUnits: 0 });
  });
});

describe("totalsByCurrency", () => {
  it("keeps each currency apart and leads with the largest", () => {
    const rows: RedemptionFact[] = [
      {
        discountCodeId: "a",
        amountMinorUnits: 500,
        currency: "GBP",
        paidMinorUnits: 4000,
        paidCurrency: "GBP",
      },
      {
        discountCodeId: "b",
        amountMinorUnits: 20000,
        currency: "MXN",
        paidMinorUnits: 150000,
        paidCurrency: "MXN",
      },
      {
        discountCodeId: "c",
        amountMinorUnits: 700,
        currency: "GBP",
        paidMinorUnits: null,
        paidCurrency: null,
      },
    ];
    expect(totalsByCurrency(rows)).toEqual([
      { currency: "MXN", givenMinorUnits: 20000, salesMinorUnits: 150000 },
      { currency: "GBP", givenMinorUnits: 1200, salesMinorUnits: 4000 },
    ]);
  });

  it("is empty when nothing has been redeemed", () => {
    expect(totalsByCurrency([])).toEqual([]);
  });
});

describe("compareForList", () => {
  it("puts live codes first, newest first within each half", () => {
    const rows = [
      { id: "old-live", state: "live" as const, createdAt: new Date("2026-01-01") },
      { id: "new-dead", state: "expired" as const, createdAt: new Date("2026-08-01") },
      { id: "new-live", state: "live" as const, createdAt: new Date("2026-06-01") },
      { id: "old-dead", state: "paused" as const, createdAt: new Date("2026-02-01") },
    ];
    expect([...rows].sort(compareForList).map((r) => r.id)).toEqual([
      "new-live",
      "old-live",
      "new-dead",
      "old-dead",
    ]);
  });
});
