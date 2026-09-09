import { beforeEach, describe, expect, it, vi } from "vitest";

// The two Prisma-bound wrappers around `summarizeCashFlow` — one per teacher,
// one platform-wide. The pure arithmetic they delegate to is pinned in
// cashflow.test.ts; what is pinned here is how a CURRENCY reaches the summary
// from the database — the half that was missing entirely and that made every
// figure on the payments page and the dashboard render as pesos, and then the
// half that made a mixed-currency teacher's total an addition of unlike minor
// units.

const packageFindManyMock = vi.fn(async (..._: unknown[]): Promise<unknown[]> => []);
const bookingGroupByMock = vi.fn(async (..._: unknown[]): Promise<unknown[]> => []);
const bookingFindManyMock = vi.fn(async (..._: unknown[]): Promise<unknown[]> => []);
const bookingFindFirstMock = vi.fn(async (..._: unknown[]): Promise<unknown> => null);
const teacherFindUniqueMock = vi.fn(async (..._: unknown[]): Promise<unknown> => null);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    package: { findMany: (...a: unknown[]) => packageFindManyMock(...a) },
    booking: {
      groupBy: (...a: unknown[]) => bookingGroupByMock(...a),
      findMany: (...a: unknown[]) => bookingFindManyMock(...a),
      findFirst: (...a: unknown[]) => bookingFindFirstMock(...a),
    },
    teacher: { findUnique: (...a: unknown[]) => teacherFindUniqueMock(...a) },
  },
}));

const { computeTeacherCashFlow } = await import("@/lib/cashflow");
const { computePlatformDeferredRevenue } = await import("@/lib/money-metrics");

const NOW = new Date("2026-09-02T12:00:00.000Z");

function pkg(over: Record<string, unknown> = {}) {
  return {
    id: "pkg-1",
    classesTotal: 10,
    pricePaidMinorUnits: 100_000,
    currency: "MXN",
    status: "active",
    expiresAt: null,
    ...over,
  };
}

// A completed booking as the wrapper selects it: the price to derive per-lesson
// revenue, the currency to file it under the right slice.
function completedBooking(
  completedAt: string,
  currency: string,
  over: Record<string, unknown> = {},
) {
  return {
    completedAt: new Date(completedAt),
    package: { pricePaidMinorUnits: 100_000, classesTotal: 10, currency, ...over },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  packageFindManyMock.mockResolvedValue([]);
  bookingGroupByMock.mockResolvedValue([]);
  bookingFindManyMock.mockResolvedValue([]);
  bookingFindFirstMock.mockResolvedValue(null);
  teacherFindUniqueMock.mockResolvedValue(null);
});

describe("computeTeacherCashFlow — currency", () => {
  it("reports the currency the packages were actually sold in", async () => {
    packageFindManyMock.mockResolvedValue([
      pkg({ currency: "GBP" }),
      pkg({ id: "p2", currency: "GBP" }),
    ]);
    teacherFindUniqueMock.mockResolvedValue({ pricingCurrency: "GBP" });

    const cashFlow = await computeTeacherCashFlow("teacher-1", NOW);
    expect(cashFlow.primary.currency).toBe("GBP");
    expect(cashFlow.primary.totalPaidCents).toBe(200_000);
    expect(cashFlow.byCurrency).toHaveLength(1);
  });

  it("falls back to her configured currency when she has no packages yet", async () => {
    teacherFindUniqueMock.mockResolvedValue({ pricingCurrency: "EUR" });
    expect((await computeTeacherCashFlow("teacher-1", NOW)).primary.currency).toBe("EUR");
    expect(teacherFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "teacher-1" },
      select: { pricingCurrency: true },
    });
  });

  it("survives the teacher row vanishing mid-request rather than crashing a money screen", async () => {
    teacherFindUniqueMock.mockResolvedValue(null);
    expect((await computeTeacherCashFlow("teacher-1", NOW)).primary.currency).toBe("MXN");
  });

  it("still splits earned from held while carrying the currency", async () => {
    // The currency is additive to the wrapper, not a replacement for what it
    // already did — four of ten classes delivered is 40/60.
    packageFindManyMock.mockResolvedValue([pkg({ currency: "USD" })]);
    bookingGroupByMock.mockResolvedValue([{ packageId: "pkg-1", _count: { _all: 4 } }]);
    teacherFindUniqueMock.mockResolvedValue({ pricingCurrency: "USD" });

    const cashFlow = await computeTeacherCashFlow("teacher-1", NOW);
    expect(cashFlow.primary).toMatchObject({
      currency: "USD",
      earnedCents: 40_000,
      heldCents: 60_000,
    });
  });
});

describe("computeTeacherCashFlow — after she changes pricing currency", () => {
  // The only way to reach a mixed-currency teacher: `packages.currency` is
  // stamped at purchase, so old rows keep the currency they were sold in.
  beforeEach(() => {
    packageFindManyMock.mockResolvedValue([
      pkg({ currency: "MXN" }),
      pkg({ id: "p2", currency: "GBP" }),
    ]);
    teacherFindUniqueMock.mockResolvedValue({ pricingCurrency: "GBP" });
  });

  it("reports each currency exactly instead of one blended total", async () => {
    const cashFlow = await computeTeacherCashFlow("teacher-1", NOW);
    expect(cashFlow.byCurrency.map((s) => [s.currency, s.totalPaidCents])).toEqual([
      ["GBP", 100_000],
      ["MXN", 100_000],
    ]);
    // The bug this replaces: 200_000 of nothing in particular.
    expect(cashFlow.byCurrency.some((s) => s.totalPaidCents === 200_000)).toBe(false);
  });

  it("leads with the currency she prices in today", async () => {
    expect((await computeTeacherCashFlow("teacher-1", NOW)).primary.currency).toBe("GBP");
  });

  it("files each delivered lesson under the currency its package was sold in", async () => {
    bookingFindFirstMock.mockResolvedValue({ completedAt: new Date("2026-05-01T00:00:00.000Z") });
    bookingFindManyMock.mockResolvedValue([
      // 100_000 / 10 = 10_000 per lesson, in each currency's own minor units.
      completedBooking("2026-07-10T00:00:00.000Z", "GBP"),
      completedBooking("2026-07-20T00:00:00.000Z", "GBP"),
      completedBooking("2026-08-10T00:00:00.000Z", "MXN"),
    ]);

    const cashFlow = await computeTeacherCashFlow("teacher-1", NOW);
    const gbp = cashFlow.byCurrency.find((s) => s.currency === "GBP")!;
    const mxn = cashFlow.byCurrency.find((s) => s.currency === "MXN")!;
    // Steady state (first lesson in May, now September): trailing Jun/Jul/Aug.
    expect(gbp.safeMonthlySpendCents).toBe(Math.round(20_000 / 3));
    expect(mxn.safeMonthlySpendCents).toBe(Math.round(10_000 / 3));
  });
});

describe("computePlatformDeferredRevenue — currency", () => {
  it("reports the shared currency when every teacher on the platform prices alike", async () => {
    packageFindManyMock.mockResolvedValue([
      pkg({ currency: "MXN" }),
      pkg({ id: "p2", currency: "MXN" }),
    ]);
    const deferred = await computePlatformDeferredRevenue(NOW);
    expect(deferred.byCurrency).toHaveLength(1);
    expect(deferred.primary).toMatchObject({ currency: "MXN", totalPaidCents: 200_000 });
  });

  it("breaks the roll-up out per currency once teachers price differently", async () => {
    // Mixed by construction — two teachers pricing differently is the ordinary
    // case here, so this roll-up can never be a single scalar. Biggest pile
    // leads: there is no "the platform's pricing currency" to prefer.
    packageFindManyMock.mockResolvedValue([
      pkg({ currency: "GBP", pricePaidMinorUnits: 50_000 }),
      pkg({ id: "p2", currency: "JPY", pricePaidMinorUnits: 90_000 }),
    ]);
    const deferred = await computePlatformDeferredRevenue(NOW);
    expect(deferred.byCurrency.map((s) => [s.currency, s.totalPaidCents])).toEqual([
      ["JPY", 90_000],
      ["GBP", 50_000],
    ]);
    expect(deferred.primary.currency).toBe("JPY");
  });

  it("is denominated in the platform default when there is nothing at all", async () => {
    const deferred = await computePlatformDeferredRevenue(NOW);
    expect(deferred.primary).toMatchObject({ currency: "MXN", totalPaidCents: 0 });
  });
});
