import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { isSlotConflictError } from "@/lib/booking/slot-conflict";

// isSlotConflictError is the single place that maps "the DB refused this
// booking write because of another scheduled class" into the friendly
// slot-taken outcome, across all three DB-level guards.

describe("isSlotConflictError", () => {
  it("recognizes the exact-start unique index (P2002)", () => {
    const err = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
    expect(isSlotConflictError(err)).toBe(true);
  });

  it("recognizes the plain interval-overlap EXCLUDE constraint", () => {
    const err = new Error(
      'insert or update on table "bookings" violates exclusion constraint "bookings_no_overlap_active"',
    );
    expect(isSlotConflictError(err)).toBe(true);
  });

  it("recognizes the buffer-aware EXCLUDE constraint (bookings_no_overlap_buffered)", () => {
    const err = new Error(
      'insert or update on table "bookings" violates exclusion constraint "bookings_no_overlap_buffered"',
    );
    expect(isSlotConflictError(err)).toBe(true);
  });

  it("recognizes a raw Postgres 23P01 code without a matching constraint name", () => {
    const err = new Error("ERROR: 23P01: conflicting key value");
    expect(isSlotConflictError(err)).toBe(true);
  });

  it("does not misclassify an unrelated error", () => {
    expect(isSlotConflictError(new Error("network timeout"))).toBe(false);
    expect(isSlotConflictError(null)).toBe(false);
  });
});
