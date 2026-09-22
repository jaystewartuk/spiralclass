import { beforeEach, describe, expect, it, vi } from "vitest";

// The materials notifications module now imports ./events (for the
// account-level assign notifier), which pulls in the Inngest client and its
// env validation at import time — stub both so this unit suite stays env-free.
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued: vi.fn() }));

import { enqueueMaterialsForTiming } from "@/lib/notifications/materials";

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const BOOKING_ID = "33333333-3333-4333-8333-333333333333";

type MaterialRow = {
  id: string;
  bookingId: string;
  linkUrl: string | null;
  storagePath: string | null;
  sendTiming: "confirmation" | "t_5d" | "t_24h" | "t_1h";
};
type NotificationRow = {
  id: string;
  teacherId: string;
  bookingId: string | null;
  templateName: string;
  metadata: unknown;
};

type FakeState = {
  materials: MaterialRow[];
  notifications: NotificationRow[];
};

function freshState(): FakeState {
  return {
    materials: [],
    notifications: [],
  };
}

function buildFakeTx(state: FakeState) {
  return {
    libraryMaterial: {
      findMany: vi.fn(async ({ where }: any) =>
        state.materials.filter(
          (m) => m.bookingId === where.bookingId && m.sendTiming === where.sendTiming,
        ),
      ),
    },
    notification: {
      findMany: vi.fn(async ({ where }: any) =>
        state.notifications.filter(
          (n) =>
            n.teacherId === where.teacherId &&
            n.bookingId === where.bookingId &&
            n.templateName === where.templateName,
        ),
      ),
      create: vi.fn(async ({ data, select }: any) => {
        const id = `notif-${state.notifications.length + 1}`;
        state.notifications.push({
          id,
          teacherId: data.teacherId,
          bookingId: data.bookingId ?? null,
          templateName: data.templateName,
          metadata: data.metadata,
        });
        return select?.id ? { id } : { id, ...data };
      }),
    },
  } as any;
}

function material(overrides: Partial<MaterialRow>): MaterialRow {
  return {
    id: "m",
    bookingId: BOOKING_ID,
    linkUrl: null,
    storagePath: null,
    sendTiming: "t_24h",
    ...overrides,
  };
}

describe("enqueueMaterialsForTiming", () => {
  let state: FakeState;

  beforeEach(() => {
    state = freshState();
  });

  it("enqueues one materials_send per matching material at the requested timing", async () => {
    state.materials = [
      material({ id: "m1", storagePath: "t/b/a.pdf" }),
      material({ id: "m2", linkUrl: "https://drive/b" }),
      material({ id: "m3", linkUrl: "https://drive/c", sendTiming: "t_1h" }),
    ];
    const tx = buildFakeTx(state);

    const ids = await enqueueMaterialsForTiming(tx, {
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      bookingId: BOOKING_ID,
      timing: "t_24h",
    });

    expect(ids).toHaveLength(2);
    expect(state.notifications).toHaveLength(2);
    expect(state.notifications.every((n) => n.templateName === "materials_send")).toBe(true);
  });

  it("emits zero notifications when no matching timing exists", async () => {
    state.materials = [material({ id: "m1", linkUrl: "https://drive/c", sendTiming: "t_1h" })];
    const tx = buildFakeTx(state);

    const ids = await enqueueMaterialsForTiming(tx, {
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      bookingId: BOOKING_ID,
      timing: "t_24h",
    });

    expect(ids).toHaveLength(0);
    expect(state.notifications).toHaveLength(0);
  });

  it("carries storage_path forward in metadata", async () => {
    state.materials = [
      material({
        id: "m1",
        storagePath: "teacher/booking/file.pdf",
        linkUrl: null,
      }),
    ];
    const tx = buildFakeTx(state);

    await enqueueMaterialsForTiming(tx, {
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      bookingId: BOOKING_ID,
      timing: "t_24h",
    });

    expect(state.notifications[0].metadata).toMatchObject({
      storagePath: "teacher/booking/file.pdf",
      materialsUrl: null,
    });
  });

  it("uses linkUrl as materialsUrl fallback for URL-only attachments", async () => {
    state.materials = [
      material({ id: "m1", linkUrl: "https://drive/x" }),
      material({ id: "m2", linkUrl: "https://drive/y" }),
    ];
    const tx = buildFakeTx(state);

    await enqueueMaterialsForTiming(tx, {
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      bookingId: BOOKING_ID,
      timing: "t_24h",
    });

    expect(state.notifications[0].metadata).toMatchObject({
      storagePath: null,
      materialsUrl: "https://drive/x",
    });
    expect(state.notifications[1].metadata).toMatchObject({
      storagePath: null,
      materialsUrl: "https://drive/y",
    });
  });

  it("skips materials with no storage_path and no linkUrl (bad data)", async () => {
    state.materials = [material({ id: "m1" }), material({ id: "m2", storagePath: "t/b/a.pdf" })];
    const tx = buildFakeTx(state);

    const ids = await enqueueMaterialsForTiming(tx, {
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      bookingId: BOOKING_ID,
      timing: "t_24h",
    });

    expect(ids).toHaveLength(1);
  });

  it("filters strictly by booking_id (no cross-booking leakage)", async () => {
    state.materials = [
      material({ id: "m1", storagePath: "t/b/a.pdf" }),
      material({ id: "m2", bookingId: "other-booking", storagePath: "t/b/b.pdf" }),
    ];
    const tx = buildFakeTx(state);

    const ids = await enqueueMaterialsForTiming(tx, {
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      bookingId: BOOKING_ID,
      timing: "t_24h",
    });

    expect(ids).toHaveLength(1);
    expect(state.notifications[0].bookingId).toBe(BOOKING_ID);
  });

  it("records the libraryMaterialId in metadata (the dedup key)", async () => {
    state.materials = [material({ id: "m1", storagePath: "t/b/a.pdf" })];
    const tx = buildFakeTx(state);

    await enqueueMaterialsForTiming(tx, {
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      bookingId: BOOKING_ID,
      timing: "t_24h",
    });

    expect(state.notifications[0].metadata).toMatchObject({ libraryMaterialId: "m1" });
  });

  // The t_5d timing is the one that needs this: since the five-day class
  // reminder was removed there is no reminder row upstream to short-circuit on,
  // so the scan re-evaluates the five-day mark on every tick and calls straight
  // in here. Without per-material dedup a teacher's student would get the same
  // material re-sent every five minutes for the last five days before class.
  it("does not re-enqueue a material it already queued on an earlier tick", async () => {
    state.materials = [
      material({ id: "m1", storagePath: "t/b/a.pdf", sendTiming: "t_5d" }),
      material({ id: "m2", linkUrl: "https://drive/b", sendTiming: "t_5d" }),
    ];
    const tx = buildFakeTx(state);
    const args = {
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      bookingId: BOOKING_ID,
      timing: "t_5d" as const,
    };

    const first = await enqueueMaterialsForTiming(tx, args);
    expect(first).toHaveLength(2);

    const second = await enqueueMaterialsForTiming(tx, args);
    expect(second).toHaveLength(0);
    expect(state.notifications).toHaveLength(2);
  });

  it("still sends a material added after an earlier tick already fired", async () => {
    state.materials = [material({ id: "m1", storagePath: "t/b/a.pdf", sendTiming: "t_5d" })];
    const tx = buildFakeTx(state);
    const args = {
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      bookingId: BOOKING_ID,
      timing: "t_5d" as const,
    };

    await enqueueMaterialsForTiming(tx, args);
    state.materials.push(material({ id: "m2", storagePath: "t/b/b.pdf", sendTiming: "t_5d" }));

    const second = await enqueueMaterialsForTiming(tx, args);
    expect(second).toHaveLength(1);
    expect(state.notifications).toHaveLength(2);
    expect(state.notifications[1].metadata).toMatchObject({ libraryMaterialId: "m2" });
  });

  it("does not treat a manual send (no libraryMaterialId in metadata) as a dedup hit", async () => {
    // Rows written by the manual upload/attach paths — and every row written
    // before the field existed — carry a null libraryMaterialId. Absence must
    // never suppress a scheduled send.
    state.notifications.push({
      id: "legacy",
      teacherId: TEACHER_ID,
      bookingId: BOOKING_ID,
      templateName: "materials_send",
      metadata: { storagePath: "t/b/a.pdf", materialsUrl: null },
    });
    state.materials = [material({ id: "m1", storagePath: "t/b/a.pdf", sendTiming: "t_5d" })];
    const tx = buildFakeTx(state);

    const ids = await enqueueMaterialsForTiming(tx, {
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      bookingId: BOOKING_ID,
      timing: "t_5d",
    });

    expect(ids).toHaveLength(1);
  });

  it("propagates teacherId + bookingId on the notification row (audit trail)", async () => {
    state.materials = [
      material({ id: "m1", storagePath: "t/b/a.pdf", sendTiming: "confirmation" }),
    ];
    const tx = buildFakeTx(state);

    await enqueueMaterialsForTiming(tx, {
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      bookingId: BOOKING_ID,
      timing: "confirmation",
    });

    expect(state.notifications[0].teacherId).toBe(TEACHER_ID);
    expect(state.notifications[0].bookingId).toBe(BOOKING_ID);
  });
});
