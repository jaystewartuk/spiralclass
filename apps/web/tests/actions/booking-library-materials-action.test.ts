import { beforeEach, describe, expect, it, vi } from "vitest";

// Gap G3 (docs/features/library-materials.md) — attaching an existing
// library item onto a reserved class. Covers: the Pro gate (same as a fresh
// per-class upload), tenant scoping on both the booking and the
// library item, the upsert-on-re-attach behavior, immediate-send-if-elapsed
// only for file/link items (never for native-content items, which have
// nothing to push over WhatsApp/email), and detach scoping.

const TEACHER_ID = "t1";
const OTHER_TEACHER_ID = "t2";
const STUDENT_ID = "s1";
const BOOKING_ID = "b1";

type BookingRow = {
  id: string;
  teacherId: string;
  studentId: string;
  scheduledStart: Date;
  status: string;
};
type MaterialRow = {
  id: string;
  teacherId: string;
  storagePath: string | null;
  linkUrl: string | null;
  archived: boolean;
};

const state: {
  pro: boolean;
  bookings: Map<string, BookingRow>;
  materials: Map<string, MaterialRow>;
  attachments: Array<{ bookingId: string; libraryMaterialId: string; sendTiming: string }>;
} = { pro: true, bookings: new Map(), materials: new Map(), attachments: [] };

const enqueueMaterialsSendMock = vi.fn(async () => "notif-1");
const emitNotificationQueuedMock = vi.fn(async () => {});
const revalidatePathMock = vi.fn();
const trackEventMock = vi.fn();

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: TEACHER_ID })),
}));
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: vi.fn(async () => (state.pro ? { ok: true } : { ok: false, limit: "materials" })),
  upgradeNudge: vi.fn(() => "UPGRADE"),
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: trackEventMock,
  flushAnalytics: vi.fn(),
}));
vi.mock("@/lib/notifications/enqueue", () => ({ enqueueMaterialsSend: enqueueMaterialsSendMock }));
vi.mock("@/lib/notifications/events", () => ({
  emitNotificationQueued: emitNotificationQueuedMock,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findFirst: vi.fn(async ({ where }: any) => {
        const b = state.bookings.get(where.id);
        if (!b || b.teacherId !== where.teacherId) return null;
        return { ...b };
      }),
    },
    libraryMaterial: {
      findFirst: vi.fn(async ({ where }: any) => {
        const m = state.materials.get(where.id);
        if (!m || m.teacherId !== where.teacherId) return null;
        if (where.archived === false && m.archived) return null;
        return { ...m };
      }),
      // Multi-select attach reads `id: { in: [...] }`.
      findMany: vi.fn(async ({ where }: any) => {
        const ids: string[] = where.id?.in ?? [];
        return ids
          .map((id) => state.materials.get(id))
          .filter(
            (m) =>
              m && m.teacherId === where.teacherId && !(where.archived === false && m.archived),
          )
          .map((m) => ({ ...m }));
      }),
    },
    bookingLibraryMaterial: {
      upsert: vi.fn(async ({ create }: any) => {
        state.attachments = state.attachments.filter(
          (a) =>
            !(a.bookingId === create.bookingId && a.libraryMaterialId === create.libraryMaterialId),
        );
        state.attachments.push(create);
        return create;
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = state.attachments.length;
        state.attachments = state.attachments.filter(
          (a) =>
            !(a.bookingId === where.bookingId && a.libraryMaterialId === where.libraryMaterialId),
        );
        return { count: before - state.attachments.length };
      }),
    },
  },
}));

const { attachLibraryMaterialToBookingAction, detachLibraryMaterialFromBookingAction } =
  await import("@/app/actions/booking-library-materials");

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.pro = true;
  state.attachments = [];
  state.bookings = new Map([
    [
      BOOKING_ID,
      {
        id: BOOKING_ID,
        teacherId: TEACHER_ID,
        studentId: STUDENT_ID,
        scheduledStart: new Date(Date.now() + 10 * 24 * 3600_000), // 10 days out
        status: "scheduled",
      },
    ],
  ]);
  state.materials = new Map([
    [
      "file-mat",
      {
        id: "file-mat",
        teacherId: TEACHER_ID,
        storagePath: "t1/library/x.pdf",
        linkUrl: null,
        archived: false,
      },
    ],
    [
      "content-mat",
      {
        id: "content-mat",
        teacherId: TEACHER_ID,
        storagePath: null,
        linkUrl: null,
        archived: false,
      },
    ],
  ]);
});

describe("attachLibraryMaterialToBookingAction", () => {
  it("blocks a Free teacher with the upgrade nudge and writes nothing", async () => {
    state.pro = false;
    const result = await attachLibraryMaterialToBookingAction(
      undefined,
      form({ bookingId: BOOKING_ID, libraryMaterialId: "file-mat", sendTiming: "t_24h" }),
    );
    expect(result).toEqual({ error: "UPGRADE" });
    expect(state.attachments).toHaveLength(0);
  });

  it("rejects a booking that doesn't belong to this teacher", async () => {
    state.bookings.set(BOOKING_ID, {
      ...state.bookings.get(BOOKING_ID)!,
      teacherId: OTHER_TEACHER_ID,
    });
    const result = await attachLibraryMaterialToBookingAction(
      undefined,
      form({ bookingId: BOOKING_ID, libraryMaterialId: "file-mat", sendTiming: "t_24h" }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.attachments).toHaveLength(0);
  });

  it("rejects a library item that belongs to another teacher", async () => {
    state.materials.set("file-mat", {
      ...state.materials.get("file-mat")!,
      teacherId: OTHER_TEACHER_ID,
    });
    const result = await attachLibraryMaterialToBookingAction(
      undefined,
      form({ bookingId: BOOKING_ID, libraryMaterialId: "file-mat", sendTiming: "t_24h" }),
    );
    expect(result?.error).toBeTruthy();
    expect(state.attachments).toHaveLength(0);
  });

  it("attaches a file item and does NOT send immediately when the timing hasn't elapsed", async () => {
    const result = await attachLibraryMaterialToBookingAction(
      undefined,
      form({ bookingId: BOOKING_ID, libraryMaterialId: "file-mat", sendTiming: "t_24h" }),
    );
    expect(result).toEqual({ ok: true });
    expect(state.attachments).toEqual([
      { bookingId: BOOKING_ID, libraryMaterialId: "file-mat", sendTiming: "t_24h" },
    ]);
    expect(enqueueMaterialsSendMock).not.toHaveBeenCalled();
  });

  it("revalidates the class page it was invoked from, and only that (D-174)", async () => {
    await attachLibraryMaterialToBookingAction(
      undefined,
      form({ bookingId: BOOKING_ID, libraryMaterialId: "file-mat", sendTiming: "t_24h" }),
    );
    // A second revalidation would cost the form its own result — the write
    // lands and the client discards the response. The class lists this used to
    // revalidate are dynamic routes that refetch on navigation anyway.
    expect(revalidatePathMock.mock.calls.map((c) => c[0])).toEqual([
      `/dashboard/classes/${BOOKING_ID}`,
    ]);
  });

  it("sends immediately when attaching with 'confirmation' timing (always elapsed)", async () => {
    await attachLibraryMaterialToBookingAction(
      undefined,
      form({ bookingId: BOOKING_ID, libraryMaterialId: "file-mat", sendTiming: "confirmation" }),
    );
    expect(enqueueMaterialsSendMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        teacherId: TEACHER_ID,
        studentId: STUDENT_ID,
        bookingId: BOOKING_ID,
      }),
    );
    expect(emitNotificationQueuedMock).toHaveBeenCalled();
  });

  it("never enqueues a send for a native-content item (nothing to push)", async () => {
    await attachLibraryMaterialToBookingAction(
      undefined,
      form({ bookingId: BOOKING_ID, libraryMaterialId: "content-mat", sendTiming: "confirmation" }),
    );
    expect(enqueueMaterialsSendMock).not.toHaveBeenCalled();
    expect(state.attachments).toHaveLength(1);
  });

  it("re-attaching the same item updates the send timing instead of duplicating", async () => {
    await attachLibraryMaterialToBookingAction(
      undefined,
      form({ bookingId: BOOKING_ID, libraryMaterialId: "file-mat", sendTiming: "t_24h" }),
    );
    await attachLibraryMaterialToBookingAction(
      undefined,
      form({ bookingId: BOOKING_ID, libraryMaterialId: "file-mat", sendTiming: "t_5d" }),
    );
    expect(state.attachments).toHaveLength(1);
    expect(state.attachments[0].sendTiming).toBe("t_5d");
  });

  it("attaches multiple selected items in one submit (multi-select)", async () => {
    const fd = new FormData();
    fd.set("bookingId", BOOKING_ID);
    fd.set("sendTiming", "t_24h");
    fd.append("libraryMaterialId", "file-mat");
    fd.append("libraryMaterialId", "content-mat");
    const result = await attachLibraryMaterialToBookingAction(undefined, fd);
    expect(result).toEqual({ ok: true });
    expect(state.attachments).toEqual([
      { bookingId: BOOKING_ID, libraryMaterialId: "file-mat", sendTiming: "t_24h" },
      { bookingId: BOOKING_ID, libraryMaterialId: "content-mat", sendTiming: "t_24h" },
    ]);
  });
});

describe("detachLibraryMaterialFromBookingAction", () => {
  it("removes the attachment when it belongs to this teacher's booking", async () => {
    await attachLibraryMaterialToBookingAction(
      undefined,
      form({ bookingId: BOOKING_ID, libraryMaterialId: "file-mat", sendTiming: "t_24h" }),
    );
    await detachLibraryMaterialFromBookingAction(
      form({ bookingId: BOOKING_ID, libraryMaterialId: "file-mat" }),
    );
    expect(state.attachments).toHaveLength(0);
  });

  it("revalidates the class page it was invoked from, and only that (D-174)", async () => {
    await detachLibraryMaterialFromBookingAction(
      form({ bookingId: BOOKING_ID, libraryMaterialId: "file-mat" }),
    );
    expect(revalidatePathMock.mock.calls.map((c) => c[0])).toEqual([
      `/dashboard/classes/${BOOKING_ID}`,
    ]);
  });
});
