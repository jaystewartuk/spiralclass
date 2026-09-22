import { beforeEach, describe, expect, it, vi } from "vitest";

// This transitively pulls in lib/materials/handlers.ts, which now calls the
// homework auto-draft check (lib/homework/auto-draft.ts) — a server module
// (`import "server-only"`); neutralize the guard, same as homework-wire.test.ts.
vi.mock("server-only", () => ({}));

// listClassContentRevisionsForBooking / restoreClassContentRevisionForBooking
// (task 5, generalized at D-69) — the booking-ownership-scoped wrappers
// around materials/revisions.ts, now backed by LibraryMaterial (bookingId
// set, sendTiming null) instead of the dropped ClassContent table.

vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent: vi.fn() }));
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: vi.fn(async () => ({ ok: true })),
  upgradeNudge: vi.fn(() => "UPGRADE"),
}));
vi.mock("@/lib/focus-tags", () => ({
  resolveFocusTagsWithCategory: vi.fn(async () => []),
}));
// Pulled in statically by lib/materials/handlers.ts for the file/link
// attachment path (not exercised here) — stubbed so the module graph doesn't
// reach the real Inngest client, which needs env vars this test doesn't set.
vi.mock("@/lib/notifications/enqueue", () => ({
  enqueueMaterialsSend: vi.fn(async () => "notif-id"),
}));
vi.mock("@/lib/notifications/events", () => ({
  emitNotificationQueued: vi.fn(async () => {}),
}));

const bookingFindFirst = vi.fn();
const revisionFindMany = vi.fn();
const revisionFindFirst = vi.fn();
const materialFindFirst = vi.fn();
const materialUpdate = vi.fn();
const materialCreate = vi.fn();
const revisionCreate = vi.fn();
const revisionDeleteMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findFirst: (...args: unknown[]) => bookingFindFirst(...args) },
    materialRevision: {
      findMany: (...args: unknown[]) => revisionFindMany(...args),
      findFirst: (...args: unknown[]) => revisionFindFirst(...args),
      create: (...args: unknown[]) => revisionCreate(...args),
      deleteMany: (...args: unknown[]) => revisionDeleteMany(...args),
    },
    libraryMaterial: {
      findFirst: (...args: unknown[]) => materialFindFirst(...args),
      update: (...args: unknown[]) => materialUpdate(...args),
      create: (...args: unknown[]) => materialCreate(...args),
    },
  },
}));

const {
  listClassContentRevisionsForBooking,
  restoreClassContentRevisionForBooking,
  snapshotMaterialRevisionBeforeRefine,
} = await import("@/lib/materials/handlers");

beforeEach(() => {
  bookingFindFirst
    .mockReset()
    .mockImplementation(async ({ where }: any) =>
      where.id === "b1" && where.teacherId === "t1" ? { id: "b1", studentId: "s1" } : null,
    );
  revisionFindMany.mockReset().mockResolvedValue([]);
  revisionFindFirst.mockReset().mockResolvedValue(null);
  materialFindFirst.mockReset().mockResolvedValue(null);
  materialUpdate.mockReset().mockResolvedValue({ id: "m1" });
  materialCreate.mockReset().mockResolvedValue({ id: "m1" });
  revisionCreate.mockReset().mockResolvedValue({});
  revisionDeleteMany.mockReset().mockResolvedValue({ count: 0 });
});

describe("listClassContentRevisionsForBooking", () => {
  it("returns null for a booking the teacher doesn't own", async () => {
    const r = await listClassContentRevisionsForBooking({ teacherId: "t1", bookingId: "nope" });
    expect(r).toBeNull();
    expect(revisionFindMany).not.toHaveBeenCalled();
  });

  it("returns an empty list when the booking has no content material yet", async () => {
    materialFindFirst.mockResolvedValue(null);
    const r = await listClassContentRevisionsForBooking({ teacherId: "t1", bookingId: "b1" });
    expect(r).toEqual([]);
    expect(revisionFindMany).not.toHaveBeenCalled();
  });

  it("lists the owned booking's content material's revisions", async () => {
    materialFindFirst.mockResolvedValue({ id: "m1", body: "# X", contentSource: "manual" });
    revisionFindMany.mockResolvedValue([
      { id: "r1", body: "# A", source: "manual", createdAt: new Date() },
    ]);
    const r = await listClassContentRevisionsForBooking({ teacherId: "t1", bookingId: "b1" });
    expect(r).toHaveLength(1);
    expect(revisionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teacherId: "t1", materialId: "m1" } }),
    );
  });
});

describe("restoreClassContentRevisionForBooking", () => {
  it("404s a booking the teacher doesn't own", async () => {
    const r = await restoreClassContentRevisionForBooking({
      teacherId: "t1",
      bookingId: "nope",
      revisionId: "r1",
      locale: "en",
    });
    expect(r).toEqual({ ok: false, code: "not-found", message: "Class not found." });
  });

  it("errors when the revision id doesn't belong to this booking/teacher", async () => {
    revisionFindFirst.mockResolvedValue(null);
    const r = await restoreClassContentRevisionForBooking({
      teacherId: "t1",
      bookingId: "b1",
      revisionId: "gone",
      locale: "en",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not-found");
    expect(materialUpdate).not.toHaveBeenCalled();
    expect(materialCreate).not.toHaveBeenCalled();
  });

  it("errors when the revision's material belongs to a different booking", async () => {
    revisionFindFirst.mockResolvedValue({
      body: "# Old draft",
      source: "ai",
      material: { bookingId: "some-other-booking" },
    });
    const r = await restoreClassContentRevisionForBooking({
      teacherId: "t1",
      bookingId: "b1",
      revisionId: "r1",
      locale: "en",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("not-found");
  });

  it("saves the revision's body/source, snapshotting whatever it replaces", async () => {
    revisionFindFirst.mockResolvedValue({
      body: "# Old draft",
      source: "ai",
      material: { bookingId: "b1" },
    });
    materialFindFirst.mockResolvedValue({ id: "m1", body: "# Current", contentSource: "manual" });

    const r = await restoreClassContentRevisionForBooking({
      teacherId: "t1",
      bookingId: "b1",
      revisionId: "r1",
      locale: "en",
    });

    expect(r).toEqual({ ok: true, materialId: "m1" });
    expect(materialUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "m1" },
        data: { body: "# Old draft", contentSource: "ai" },
      }),
    );
    // The state being replaced (the current, pre-restore body) is snapshotted.
    expect(revisionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ body: "# Current", source: "manual" }),
      }),
    );
  });
});

// snapshotMaterialRevisionBeforeRefine (AI-editing UX follow-up): checkpoints
// the pre-refine body the moment a refine applies client-side, rather than
// waiting for the next explicit Save. Ownership-scoped like every other
// mutation here, and silent (returns void, never throws past the ownership
// check) — it's best-effort recovery infra, not a user-facing action with its
// own error surface.
describe("snapshotMaterialRevisionBeforeRefine", () => {
  it("no-ops when the material isn't owned by this teacher (or doesn't exist yet)", async () => {
    materialFindFirst.mockResolvedValue(null);
    await snapshotMaterialRevisionBeforeRefine({
      teacherId: "t1",
      materialId: "m1",
      body: "# Pre-refine body",
      source: "manual",
    });
    expect(materialFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "m1", teacherId: "t1", body: { not: null } },
      }),
    );
    expect(revisionCreate).not.toHaveBeenCalled();
  });

  it("no-ops on a blank/whitespace-only body without even looking up the material", async () => {
    await snapshotMaterialRevisionBeforeRefine({
      teacherId: "t1",
      materialId: "m1",
      body: "   \n\n  ",
      source: "manual",
    });
    expect(materialFindFirst).not.toHaveBeenCalled();
    expect(revisionCreate).not.toHaveBeenCalled();
  });

  it("snapshots the pre-refine body, normalized, once ownership is confirmed", async () => {
    materialFindFirst.mockResolvedValue({ id: "m1" });
    await snapshotMaterialRevisionBeforeRefine({
      teacherId: "t1",
      materialId: "m1",
      body: "# Before the AI touched it\r\n\r\nOriginal text.  ",
      source: "ai",
    });
    expect(revisionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          materialId: "m1",
          teacherId: "t1",
          body: "# Before the AI touched it\n\nOriginal text.",
          source: "ai",
        }),
      }),
    );
  });

  it("never trusts a client-supplied materialId across tenants", async () => {
    // materialFindFirst's where clause already scopes by teacherId — this
    // pins that the caller can't snapshot onto a material it doesn't own by
    // just knowing its id.
    materialFindFirst.mockImplementation(async ({ where }: any) =>
      where.teacherId === "t1" ? { id: "m1" } : null,
    );
    await snapshotMaterialRevisionBeforeRefine({
      teacherId: "someone-else",
      materialId: "m1",
      body: "# Stolen snapshot attempt",
      source: "manual",
    });
    expect(revisionCreate).not.toHaveBeenCalled();
  });
});
