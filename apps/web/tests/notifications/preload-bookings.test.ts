import { describe, expect, it, vi } from "vitest";
import { bookingCacheKey, buildVariables, preloadBookings } from "@/lib/notifications/dispatcher";

const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";
const B1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function bookingRow(id: string, teacherId: string) {
  return {
    id,
    teacherId,
    packageId: "pkg-1",
    scheduledStart: new Date("2026-07-01T15:00:00Z"),
    scheduledEnd: new Date("2026-07-01T16:00:00Z"),
    status: "scheduled",
  };
}

describe("preloadBookings", () => {
  it("collapses many booking refs into a single IN query", async () => {
    const findMany = vi.fn(async () => [bookingRow(B1, T1), bookingRow(B2, T1)]);
    const prisma = { booking: { findMany } } as any;

    const cache = await preloadBookings(prisma, [
      { teacherId: T1, bookingId: B1 },
      { teacherId: T1, bookingId: B2 },
      { teacherId: T1, bookingId: B1 }, // duplicate id → deduped
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    const firstCallArgs = findMany.mock.calls[0] as unknown as [{ where: unknown }];
    expect(firstCallArgs[0].where).toEqual({ id: { in: [B1, B2] } });
    expect(cache.get(bookingCacheKey(T1, B1))?.id).toBe(B1);
    expect(cache.get(bookingCacheKey(T1, B2))?.id).toBe(B2);
  });

  it("scopes by teacher — a booking owned by another teacher resolves to null", async () => {
    // The row exists but belongs to T1; a ref claiming T2 must not match it.
    const prisma = { booking: { findMany: vi.fn(async () => [bookingRow(B1, T1)]) } } as any;
    const cache = await preloadBookings(prisma, [{ teacherId: T2, bookingId: B1 }]);
    expect(cache.get(bookingCacheKey(T2, B1))).toBeNull();
  });

  it("no refs → no query", async () => {
    const findMany = vi.fn();
    const prisma = { booking: { findMany } } as any;
    const cache = await preloadBookings(prisma, []);
    expect(findMany).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });

  it("buildVariables reads a hit from the cache instead of querying", async () => {
    const findFirst = vi.fn();
    const prisma = { booking: { findFirst } } as any;
    const cache = new Map([[bookingCacheKey(T1, B1), bookingRow(B1, T1)]]);

    const res = await buildVariables(prisma, {
      templateName: "reminder_24h",
      notification: { id: "n1", teacherId: T1, bookingId: B1, paymentId: null, metadata: null },
      teacherName: "Mira",
      recipientTimezone: "America/Mexico_City",
      recipientLocale: "es-MX",
      storage: null,
      bookingCache: cache,
    });

    expect(res.ok).toBe(true);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
