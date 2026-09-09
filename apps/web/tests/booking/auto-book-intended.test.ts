import { beforeEach, describe, expect, it, vi } from "vitest";

// autoBookIntendedSlot is the pay-at-reservation completion step: once a
// payment lands (payment.paid), it turns the slot the student chose at checkout
// into a booking. Since D-111 that covers multi-class packages too ("pick your
// first class"), which is what the idempotency tests below are really about —
// the cheap balance check is exact only for a 1-class package. These tests pin
// the guards (no intent, not-active, both idempotency paths) and the graceful
// fallback when the slot was taken before payment cleared — the credit must
// survive.

const bookPackageSlot = vi.fn();
vi.mock("@/lib/booking/book-package-slot", () => ({ bookPackageSlot }));

const findUnique = vi.fn();
const findFirst = vi.fn();
const deps = {
  prisma: { package: { findUnique }, booking: { findFirst } },
  emit: vi.fn(),
} as unknown as Parameters<typeof autoBookIntendedSlot>[0];

const { autoBookIntendedSlot } = await import("@/lib/booking/auto-book-intended");

const start = new Date("2026-07-01T17:00:00.000Z");

function pkg(over: Record<string, unknown> = {}) {
  return {
    id: "pkg1",
    teacherId: "t1",
    studentId: "s1",
    classesUsed: 0,
    classesTotal: 1,
    classDurationMin: 50,
    expiresAt: null,
    status: "active",
    intendedStartUtc: start,
    teacher: { timezone: "America/Mexico_City", bufferMin: 10, minAdvanceH: 2, maxAdvanceDays: 30 },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: nothing booked into the intended slot yet.
  findFirst.mockResolvedValue(null);
});

describe("autoBookIntendedSlot", () => {
  it("books the chosen slot via the booking core", async () => {
    findUnique.mockResolvedValue(pkg());
    bookPackageSlot.mockResolvedValue({ code: "ok", bookingId: "bk1" });

    const res = await autoBookIntendedSlot(deps, "pkg1");

    expect(res).toEqual({ code: "booked", bookingId: "bk1" });
    const call = bookPackageSlot.mock.calls[0][1];
    expect(call.startUtc).toEqual(start);
    expect(call.pkg.id).toBe("pkg1");
    expect(call.notifyTeacher).toBe(true);
  });

  it("no-ops when the package has no intended slot (ordinary purchase)", async () => {
    findUnique.mockResolvedValue(pkg({ intendedStartUtc: null }));
    const res = await autoBookIntendedSlot(deps, "pkg1");
    expect(res).toEqual({ code: "no-intent" });
    expect(bookPackageSlot).not.toHaveBeenCalled();
  });

  it("no-ops when the package isn't active yet", async () => {
    findUnique.mockResolvedValue(pkg({ status: "pending" }));
    const res = await autoBookIntendedSlot(deps, "pkg1");
    expect(res).toEqual({ code: "not-active" });
    expect(bookPackageSlot).not.toHaveBeenCalled();
  });

  it("is idempotent for a single class: a re-delivered event finds the credit spent", async () => {
    findUnique.mockResolvedValue(pkg({ classesUsed: 1, classesTotal: 1 }));
    const res = await autoBookIntendedSlot(deps, "pkg1");
    expect(res).toEqual({ code: "already-booked" });
    expect(bookPackageSlot).not.toHaveBeenCalled();
  });

  // The regression D-111 named: on a 4-class package the balance check reads
  // 1 >= 4 → false after the first booking, so a re-delivered payment.paid
  // would fall through to the booking core without this second guard.
  it("is idempotent for a package: a re-delivered event finds the intended slot booked", async () => {
    findUnique.mockResolvedValue(pkg({ classesUsed: 1, classesTotal: 4 }));
    findFirst.mockResolvedValue({ id: "bk1" });

    const res = await autoBookIntendedSlot(deps, "pkg1");

    expect(res).toEqual({ code: "already-booked" });
    expect(bookPackageSlot).not.toHaveBeenCalled();
    // Matched on this student + teacher AND this start — classes booked from
    // the balance at other times must not read as the intended one.
    const where = findFirst.mock.calls[0][0].where;
    expect(where.teacherId).toBe("t1");
    expect(where.studentId).toBe("s1");
    expect(where.scheduledStart).toEqual(start);
  });

  // The booking core spends the soonest-to-expire credit across ALL of the
  // student's active packages with the teacher, so a top-up bought while an
  // older package is still live lands its first class on the OLDER package: the
  // paid package keeps classesUsed 0 and owns no booking row at the intended
  // start. A packageId-scoped guard missed that and re-ran the booking core on
  // every redelivery (reconcile-paid re-emits hourly for days). The guard must
  // therefore NOT key on the package.
  it("recognises the intent as honoured when the class landed on an older package's credit", async () => {
    findUnique.mockResolvedValue(pkg({ id: "pkg-topup", classesUsed: 0, classesTotal: 4 }));
    // The booking exists for this student+teacher at the intended start, but it
    // is bound to the older package.
    findFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      where.packageId === undefined ? { id: "bk-old-pkg" } : null,
    );

    const res = await autoBookIntendedSlot(deps, "pkg-topup");

    expect(res).toEqual({ code: "already-booked" });
    expect(bookPackageSlot).not.toHaveBeenCalled();
    const where = findFirst.mock.calls[0][0].where;
    expect(where.packageId).toBeUndefined();
  });

  it("still books the first class of a package with headroom left", async () => {
    findUnique.mockResolvedValue(pkg({ classesUsed: 0, classesTotal: 4 }));
    bookPackageSlot.mockResolvedValue({ code: "ok", bookingId: "bk1" });

    const res = await autoBookIntendedSlot(deps, "pkg1");

    expect(res).toEqual({ code: "booked", bookingId: "bk1" });
    // Only the first class — the other 3 credits stay bookable from the portal.
    expect(bookPackageSlot).toHaveBeenCalledTimes(1);
    expect(bookPackageSlot.mock.calls[0][1].startUtc).toEqual(start);
  });

  // Only genuinely-cancelled rows are excluded. A rescheduled booking keeps its
  // original scheduledStart and is just flagged `rescheduled`, so it must stay
  // inside the guard — the intent was already honoured once, and re-booking the
  // vacated original time would spend a second credit.
  it("excludes only cancelled bookings from the guard, not rescheduled ones", async () => {
    findUnique.mockResolvedValue(pkg({ classesUsed: 0, classesTotal: 4 }));
    bookPackageSlot.mockResolvedValue({ code: "ok", bookingId: "bk2" });

    await autoBookIntendedSlot(deps, "pkg1");

    const status = findFirst.mock.calls[0][0].where.status;
    expect(status).toEqual({ notIn: ["canceled_by_student", "canceled_by_teacher"] });
    expect(status.notIn).not.toContain("rescheduled");
  });

  it("leaves the credit bookable when the slot was taken before payment cleared", async () => {
    findUnique.mockResolvedValue(pkg());
    bookPackageSlot.mockResolvedValue({ code: "slot-taken" });
    const res = await autoBookIntendedSlot(deps, "pkg1");
    // Non-error outcome — the student keeps a 1-class credit to re-book.
    expect(res).toEqual({ code: "slot-unavailable" });
  });

  it("treats an unavailable/past slot as the same recoverable fallback", async () => {
    findUnique.mockResolvedValue(pkg());
    bookPackageSlot.mockResolvedValue({ code: "slot-unavailable" });
    const res = await autoBookIntendedSlot(deps, "pkg1");
    expect(res).toEqual({ code: "slot-unavailable" });
  });
});
