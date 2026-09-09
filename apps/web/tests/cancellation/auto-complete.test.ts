import { describe, expect, it } from "vitest";
import { maybeCompleteBooking, type AutoCompleteClient } from "@/lib/cancellation/auto-complete";

const TEACHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOKING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PACKAGE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-04-30T18:00:00Z");

type BookingRow = {
  id: string;
  teacherId: string;
  status:
    | "scheduled"
    | "completed"
    | "canceled_by_student"
    | "canceled_by_teacher"
    | "no_show"
    | "rescheduled";
  completedAt: Date | null;
};
type PackageRow = {
  id: string;
  classesUsed: number;
  classesTotal: number;
};

function buildClient(state: {
  bookings: Map<string, BookingRow>;
  packages: Map<string, PackageRow>;
}): AutoCompleteClient {
  return {
    $transaction: async (fn) =>
      fn({
        booking: {
          updateMany: async ({ where, data }) => {
            const b = state.bookings.get(where.id);
            if (!b) return { count: 0 };
            if (b.teacherId !== where.teacherId) return { count: 0 };
            if (b.status !== where.status) return { count: 0 };
            b.status = data.status as BookingRow["status"];
            b.completedAt = data.completedAt;
            return { count: 1 };
          },
        },
      }),
  };
}

function freshState(bookingStatus: BookingRow["status"] = "scheduled") {
  return {
    bookings: new Map<string, BookingRow>([
      [
        BOOKING_ID,
        {
          id: BOOKING_ID,
          teacherId: TEACHER_ID,
          status: bookingStatus,
          completedAt: null,
        },
      ],
    ]),
    packages: new Map<string, PackageRow>([
      [PACKAGE_ID, { id: PACKAGE_ID, classesUsed: 2, classesTotal: 10 }],
    ]),
  };
}

describe("maybeCompleteBooking", () => {
  it("transitions scheduled → completed without changing classes_used (Model B: committed at reservation)", async () => {
    const state = freshState();
    const result = await maybeCompleteBooking(
      { bookingId: BOOKING_ID, teacherId: TEACHER_ID, packageId: PACKAGE_ID, now: NOW },
      buildClient(state),
    );
    expect(result).toEqual({ completed: true });
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("completed");
    expect(state.bookings.get(BOOKING_ID)?.completedAt).toEqual(NOW);
    // Completion is quota-neutral — the class was already counted when booked.
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(2);
  });

  it("is idempotent on retry — second invocation noops", async () => {
    const state = freshState();
    const client = buildClient(state);
    const a = await maybeCompleteBooking(
      { bookingId: BOOKING_ID, teacherId: TEACHER_ID, packageId: PACKAGE_ID, now: NOW },
      client,
    );
    const b = await maybeCompleteBooking(
      { bookingId: BOOKING_ID, teacherId: TEACHER_ID, packageId: PACKAGE_ID, now: NOW },
      client,
    );
    expect(a).toEqual({ completed: true });
    expect(b).toEqual({ completed: false, reason: "not-scheduled" });
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(2);
  });

  it("noops when booking was canceled before the timer fired", async () => {
    const state = freshState("canceled_by_student");
    const result = await maybeCompleteBooking(
      { bookingId: BOOKING_ID, teacherId: TEACHER_ID, packageId: PACKAGE_ID, now: NOW },
      buildClient(state),
    );
    expect(result).toEqual({ completed: false, reason: "not-scheduled" });
    expect(state.packages.get(PACKAGE_ID)?.classesUsed).toBe(2);
  });

  it("noops when booking was rescheduled (the new booking owns the timer now)", async () => {
    const state = freshState("rescheduled");
    const result = await maybeCompleteBooking(
      { bookingId: BOOKING_ID, teacherId: TEACHER_ID, packageId: PACKAGE_ID, now: NOW },
      buildClient(state),
    );
    expect(result).toEqual({ completed: false, reason: "not-scheduled" });
  });

  it("filters by teacher_id (tenant isolation) — wrong teacher noops", async () => {
    const state = freshState();
    const result = await maybeCompleteBooking(
      {
        bookingId: BOOKING_ID,
        teacherId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        packageId: PACKAGE_ID,
        now: NOW,
      },
      buildClient(state),
    );
    expect(result).toEqual({ completed: false, reason: "not-scheduled" });
    expect(state.bookings.get(BOOKING_ID)?.status).toBe("scheduled");
  });
});
