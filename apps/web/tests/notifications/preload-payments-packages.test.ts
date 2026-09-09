import { describe, expect, it, vi } from "vitest";
import {
  buildVariables,
  packageCacheKey,
  packageIdFromNotificationMetadata,
  packageRefFromBookingCache,
  paymentCacheKey,
  preloadPackages,
  preloadPayments,
  bookingCacheKey,
} from "@/lib/notifications/dispatcher";

// Perf follow-up #3: the inbox's per-row buildVariables used to fire a
// separate payment/package query for every payment/package-templated row
// (payment.findFirst / package.findFirst), even though the booking preload
// already collapsed its own N+1. These mirror preload-bookings.test.ts for
// the two new batched caches.

const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";
const P1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PKG1 = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PKG2 = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function paymentRow(id: string, teacherId: string) {
  return {
    id,
    amountMinorUnits: 50000,
    currency: "MXN",
    paymentReference: null,
    package: {
      id: PKG1,
      teacherId,
      template: { name: "Paquete 10 clases" },
      student: { name: "Mira" },
      teacher: { bookingSlug: "profe-mira" },
    },
  };
}

function packageRow(id: string, teacherId: string) {
  return {
    id,
    teacherId,
    studentId: "stu-1",
    classesTotal: 10,
    classesUsed: 2,
    expiresAt: null,
    template: { name: "Paquete 10 clases" },
    teacher: { bookingSlug: "profe-mira" },
    student: { name: "Mira" },
  };
}

describe("preloadPayments", () => {
  it("collapses many payment refs into a single IN query", async () => {
    const findMany = vi.fn(async () => [paymentRow(P1, T1), paymentRow(P2, T1)]);
    const prisma = { payment: { findMany } } as any;

    const cache = await preloadPayments(prisma, [
      { teacherId: T1, paymentId: P1 },
      { teacherId: T1, paymentId: P2 },
      { teacherId: T1, paymentId: P1 }, // duplicate id → deduped
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    const [args] = findMany.mock.calls[0] as unknown as [{ where: unknown }];
    expect(args.where).toEqual({ id: { in: [P1, P2] } });
    expect(cache.get(paymentCacheKey(T1, P1))?.id).toBe(P1);
    expect(cache.get(paymentCacheKey(T1, P2))?.id).toBe(P2);
  });

  it("scopes by teacher — a payment owned by another teacher resolves to null", async () => {
    const prisma = { payment: { findMany: vi.fn(async () => [paymentRow(P1, T1)]) } } as any;
    const cache = await preloadPayments(prisma, [{ teacherId: T2, paymentId: P1 }]);
    expect(cache.get(paymentCacheKey(T2, P1))).toBeNull();
  });

  it("no refs → no query", async () => {
    const findMany = vi.fn();
    const prisma = { payment: { findMany } } as any;
    const cache = await preloadPayments(prisma, []);
    expect(findMany).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });

  it("buildVariables reads a hit from the cache instead of querying", async () => {
    const findFirst = vi.fn();
    const prisma = { payment: { findFirst } } as any;
    const cache = new Map([[paymentCacheKey(T1, P1), paymentRow(P1, T1)]]);

    const res = await buildVariables(prisma, {
      templateName: "payment_received",
      notification: { id: "n1", teacherId: T1, bookingId: null, paymentId: P1, metadata: null },
      teacherName: "Mira",
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "es-MX",
      storage: null,
      paymentCache: cache,
    });

    expect(res.ok).toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("preloadPackages", () => {
  it("collapses many package refs into a single IN query", async () => {
    const findMany = vi.fn(async () => [packageRow(PKG1, T1), packageRow(PKG2, T1)]);
    const prisma = { package: { findMany } } as any;

    const cache = await preloadPackages(prisma, [
      { teacherId: T1, packageId: PKG1 },
      { teacherId: T1, packageId: PKG2 },
      { teacherId: T1, packageId: PKG1 }, // duplicate id → deduped
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    const [args] = findMany.mock.calls[0] as unknown as [{ where: unknown }];
    expect(args.where).toEqual({ id: { in: [PKG1, PKG2] } });
    expect(cache.get(packageCacheKey(T1, PKG1))?.id).toBe(PKG1);
    expect(cache.get(packageCacheKey(T1, PKG2))?.id).toBe(PKG2);
  });

  it("scopes by teacher — a package owned by another teacher resolves to null", async () => {
    const prisma = { package: { findMany: vi.fn(async () => [packageRow(PKG1, T1)]) } } as any;
    const cache = await preloadPackages(prisma, [{ teacherId: T2, packageId: PKG1 }]);
    expect(cache.get(packageCacheKey(T2, PKG1))).toBeNull();
  });

  it("no refs → no query", async () => {
    const findMany = vi.fn();
    const prisma = { package: { findMany } } as any;
    const cache = await preloadPackages(prisma, []);
    expect(findMany).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });

  it("buildVariables reads a hit from the cache instead of querying (package_expiry_nudge)", async () => {
    const findFirst = vi.fn();
    const prisma = { package: { findFirst } } as any;
    const pkg = { ...packageRow(PKG1, T1), expiresAt: new Date("2027-01-01T00:00:00Z") };
    const cache = new Map([[packageCacheKey(T1, PKG1), pkg]]);

    const res = await buildVariables(prisma, {
      templateName: "package_expiry_nudge",
      notification: {
        id: "n1",
        teacherId: T1,
        bookingId: null,
        paymentId: null,
        metadata: { packageId: PKG1 },
      },
      teacherName: "Mira",
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "es-MX",
      storage: null,
      packageCache: cache,
    });

    expect(res.ok).toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("buildVariables reads booking_confirmation's classesRemaining from the package cache", async () => {
    const findFirst = vi.fn();
    const prisma = { package: { findFirst } } as any;
    const packageCache = new Map([[packageCacheKey(T1, PKG1), packageRow(PKG1, T1)]]);
    const bookingCache = new Map([
      [
        bookingCacheKey(T1, "book-1"),
        {
          id: "book-1",
          packageId: PKG1,
          scheduledStart: new Date("2027-01-01T15:00:00Z"),
          scheduledEnd: new Date("2027-01-01T16:00:00Z"),
          status: "scheduled",
        },
      ],
    ]);

    const res = await buildVariables(prisma, {
      templateName: "booking_confirmation",
      notification: {
        id: "n1",
        teacherId: T1,
        bookingId: "book-1",
        paymentId: null,
        metadata: null,
      },
      teacherName: "Mira",
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "es-MX",
      storage: null,
      bookingCache,
      packageCache,
    });

    expect(res.ok).toBe(true);
    if (res.ok && "classesRemaining" in res.variables) {
      expect(res.variables.classesRemaining).toBe("8"); // 10 total - 2 used
    }
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("packageRefFromBookingCache", () => {
  it("resolves the packageId from an already-preloaded booking", () => {
    const bookingCache = new Map([
      [
        bookingCacheKey(T1, "book-1"),
        {
          id: "book-1",
          packageId: PKG1,
          scheduledStart: new Date(),
          scheduledEnd: new Date(),
          status: "scheduled",
        },
      ],
    ]);
    expect(packageRefFromBookingCache(T1, "book-1", bookingCache)).toEqual({
      teacherId: T1,
      packageId: PKG1,
    });
  });

  it("returns null when the booking isn't in the cache", () => {
    expect(packageRefFromBookingCache(T1, "missing", new Map())).toBeNull();
  });
});

describe("packageIdFromNotificationMetadata", () => {
  it.each([
    ["package_expiry_nudge", { packageId: PKG1 }, PKG1],
    ["package_consumed_student", { packageId: PKG1 }, PKG1],
    ["package_consumed_teacher", { packageId: PKG1 }, PKG1],
    ["payment_received", { packageId: PKG1 }, null],
    ["package_expiry_nudge", null, null],
  ])("%s → %s", (templateName, metadata, expected) => {
    expect(packageIdFromNotificationMetadata(templateName, metadata as never)).toBe(expected);
  });
});
