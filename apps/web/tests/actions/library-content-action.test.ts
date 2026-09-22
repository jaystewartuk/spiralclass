import { beforeEach, describe, expect, it, vi } from "vitest";

// The unified material form's action-layer dispatch
// (docs/features/library-materials.md): saveMaterialContentAction, generateMaterialDraftAction,
// restoreMaterialRevisionAction, listMaterialRevisionsFor, and the library-scope
// path of saveMaterialAttachmentAction all live in app/actions/library.ts and
// route to lib/materials/handlers.ts by bookingId presence — booking-scope vs
// library-scope. This file pins the FormData parsing and the dispatch itself
// (mocking every handler), not the business logic behind each handler, which
// is covered in tests/materials/handlers-content-save.test.ts. The booking-scope
// path of saveMaterialAttachmentAction is covered end-to-end (no handler mock)
// in tests/notifications/materials-upload.test.ts.

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "en") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: vi.fn(),
  flushAnalytics: vi.fn(async () => {}),
}));
vi.mock("@/lib/notifications/materials", () => ({
  notifyLibraryMaterialAssigned: vi.fn(async () => {}),
}));
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: vi.fn(async () => ({ ok: true })),
  upgradeNudge: vi.fn(() => "UPGRADE"),
}));

const syncLibraryMaterialFocusTags = vi.fn(async () => {});
vi.mock("@/lib/materials/tags", () => ({ syncLibraryMaterialFocusTags }));

const resolveMaterialAttachment = vi.fn(async (..._a: any[]) => ({}) as any);
const removeMaterialObject = vi.fn(async () => {});
vi.mock("@/lib/storage/materials-upload", () => ({
  resolveMaterialAttachment: (...args: any[]) => resolveMaterialAttachment(...args),
  removeMaterialObject,
  // The unified action validates a posted link with this schema before it
  // rides onto the same material row as the body.
  materialLinkSchema: { safeParse: (v: string) => ({ success: true, data: v }) },
}));

type SaveResult = { ok: boolean; materialId?: string; code?: string; message?: string };
type GenerateResult = { ok: boolean; body?: string; code?: string; message?: string };

const saveClassContentForBooking = vi.fn(async (..._a: any[]): Promise<SaveResult> => ({
  ok: true,
  materialId: "content-1",
}));
const saveLibraryContentMaterial = vi.fn(async (..._a: any[]): Promise<SaveResult> => ({
  ok: true,
  materialId: "lib-1",
}));
const generateClassContentForBooking = vi.fn(async (..._a: any[]): Promise<GenerateResult> => ({
  ok: true,
  body: "# Booking draft",
}));
const generateLibraryMaterialForTeacher = vi.fn(async (..._a: any[]): Promise<GenerateResult> => ({
  ok: true,
  body: "# Library draft",
}));
const listClassContentRevisionsForBooking = vi.fn(async (..._a: any[]) => [{ id: "r1" }]);
const listLibraryMaterialRevisions = vi.fn(async (..._a: any[]) => [{ id: "r2" }]);
const restoreClassContentRevisionForBooking = vi.fn(async (..._a: any[]): Promise<SaveResult> => ({
  ok: true,
  materialId: "content-1",
}));
const restoreLibraryMaterialRevision = vi.fn(async (..._a: any[]): Promise<SaveResult> => ({
  ok: true,
  materialId: "lib-1",
}));
const getClassContentForBooking = vi.fn(async (..._a: any[]) => ({
  id: "content-1",
  body: "# Restored",
  source: "manual",
}));
const saveMaterialAttachment = vi.fn(async (..._a: any[]): Promise<SaveResult> => ({
  ok: true,
  materialId: "att-1",
}));
const nextPositionInLevel = vi.fn(async (..._a: any[]) => 0);

vi.mock("@/lib/materials/handlers", () => ({
  saveClassContentForBooking: (...a: any[]) => saveClassContentForBooking(...a),
  saveLibraryContentMaterial: (...a: any[]) => saveLibraryContentMaterial(...a),
  generateClassContentForBooking: (...a: any[]) => generateClassContentForBooking(...a),
  generateLibraryMaterialForTeacher: (...a: any[]) => generateLibraryMaterialForTeacher(...a),
  listClassContentRevisionsForBooking: (...a: any[]) => listClassContentRevisionsForBooking(...a),
  listLibraryMaterialRevisions: (...a: any[]) => listLibraryMaterialRevisions(...a),
  restoreClassContentRevisionForBooking: (...a: any[]) =>
    restoreClassContentRevisionForBooking(...a),
  restoreLibraryMaterialRevision: (...a: any[]) => restoreLibraryMaterialRevision(...a),
  getClassContentForBooking: (...a: any[]) => getClassContentForBooking(...a),
  saveMaterialAttachment: (...a: any[]) => saveMaterialAttachment(...a),
  nextPositionInLevel: (...a: any[]) => nextPositionInLevel(...a),
}));

const libraryMaterialFindFirst = vi.fn(async (..._a: any[]) => ({
  body: "# Restored lib",
  contentSource: "manual",
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findFirst: vi.fn(async () => ({ id: "b1" })) },
    libraryMaterial: {
      findFirst: (...a: any[]) => libraryMaterialFindFirst(...a),
    },
  },
}));

const {
  saveMaterialAttachmentAction,
  saveMaterialContentAction,
  generateMaterialDraftAction,
  restoreMaterialRevisionAction,
  listMaterialRevisionsFor,
} = await import("@/app/actions/library");

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveMaterialAttachment.mockResolvedValue({ ok: { kind: "link", linkUrl: "https://x.com" } });
  saveClassContentForBooking.mockResolvedValue({ ok: true, materialId: "content-1" });
  saveLibraryContentMaterial.mockResolvedValue({ ok: true, materialId: "lib-1" });
  generateClassContentForBooking.mockResolvedValue({ ok: true, body: "# Booking draft" });
  generateLibraryMaterialForTeacher.mockResolvedValue({ ok: true, body: "# Library draft" });
  restoreClassContentRevisionForBooking.mockResolvedValue({ ok: true, materialId: "content-1" });
  restoreLibraryMaterialRevision.mockResolvedValue({ ok: true, materialId: "lib-1" });
  getClassContentForBooking.mockResolvedValue({
    id: "content-1",
    body: "# Restored",
    source: "manual",
  });
  libraryMaterialFindFirst.mockResolvedValue({ body: "# Restored lib", contentSource: "manual" });
  saveMaterialAttachment.mockResolvedValue({ ok: true, materialId: "att-1" });
});

describe("saveMaterialContentAction — dispatch", () => {
  it("routes to saveClassContentForBooking when bookingId is posted", async () => {
    const r = await saveMaterialContentAction(
      undefined,
      fd({ bookingId: "b1", body: "# Hi", source: "manual" }),
    );
    expect(r).toEqual({ ok: true, materialId: "content-1" });
    expect(saveClassContentForBooking).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: "t1", bookingId: "b1", body: "# Hi" }),
    );
    expect(saveLibraryContentMaterial).not.toHaveBeenCalled();
    // Booking-scope content has no tags of its own — never synced.
    expect(syncLibraryMaterialFocusTags).not.toHaveBeenCalled();
  });

  it("routes to saveLibraryContentMaterial when no bookingId is posted, and syncs tags", async () => {
    const r = await saveMaterialContentAction(
      undefined,
      fd({ levelId: "lvl1", visibility: "all", body: "# Hi", focusTagIdsPresent: "1" }),
    );
    expect(r).toEqual({ ok: true, materialId: "lib-1" });
    expect(saveLibraryContentMaterial).toHaveBeenCalledWith(
      expect.objectContaining({
        teacherId: "t1",
        levelId: "lvl1",
        visibility: "all",
        body: "# Hi",
      }),
    );
    expect(saveClassContentForBooking).not.toHaveBeenCalled();
    expect(syncLibraryMaterialFocusTags).toHaveBeenCalledWith("t1", "lib-1", []);
  });

  it("passes materialId through for a library edit-in-place", async () => {
    await saveMaterialContentAction(
      undefined,
      fd({ materialId: "lib-1", levelId: "lvl1", body: "# Edited" }),
    );
    expect(saveLibraryContentMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ materialId: "lib-1" }),
    );
  });

  it("surfaces a handler error without syncing tags", async () => {
    saveLibraryContentMaterial.mockResolvedValue({
      ok: false,
      code: "invalid",
      message: "Elige un nivel.",
    });
    const r = await saveMaterialContentAction(undefined, fd({ levelId: "", body: "# Hi" }));
    expect(r).toEqual({ error: "Elige un nivel." });
    expect(syncLibraryMaterialFocusTags).not.toHaveBeenCalled();
  });

  it("carries a posted link onto the same content row (unified material)", async () => {
    await saveMaterialContentAction(
      undefined,
      fd({ levelId: "lvl1", body: "# Hi", linkUrl: "https://x.com/a" }),
    );
    expect(saveLibraryContentMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ body: "# Hi", linkUrl: "https://x.com/a" }),
    );
  });

  it("falls back to the attachment path when there's no body (a file/link-only material)", async () => {
    const r = await saveMaterialContentAction(
      undefined,
      fd({ levelId: "lvl1", linkUrl: "https://x.com/b" }),
    );
    expect(r).toEqual({ ok: true, materialId: "att-1" });
    expect(saveMaterialAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ levelId: "lvl1", linkUrl: "https://x.com/b" }),
    );
    expect(saveLibraryContentMaterial).not.toHaveBeenCalled();
  });
});

describe("generateMaterialDraftAction — dispatch", () => {
  it("routes to generateClassContentForBooking when bookingId is posted", async () => {
    const r = await generateMaterialDraftAction(undefined, fd({ bookingId: "b1", topic: "x" }));
    expect(r).toEqual({ body: "# Booking draft" });
    expect(generateClassContentForBooking).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: "t1", bookingId: "b1", topic: "x" }),
    );
    expect(generateLibraryMaterialForTeacher).not.toHaveBeenCalled();
  });

  it("routes to generateLibraryMaterialForTeacher when no bookingId is posted", async () => {
    const r = await generateMaterialDraftAction(undefined, fd({ topic: "x", levelId: "lvl1" }));
    expect(r).toEqual({ body: "# Library draft" });
    expect(generateLibraryMaterialForTeacher).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: "t1", topic: "x", levelId: "lvl1" }),
    );
    expect(generateClassContentForBooking).not.toHaveBeenCalled();
  });

  // The picker posts through a hidden input (Radix Select doesn't post). Both
  // scopes carry it — language is not library-only.
  it("forwards the posted language on both scopes", async () => {
    await generateMaterialDraftAction(undefined, fd({ topic: "x", language: "French" }));
    expect(generateLibraryMaterialForTeacher).toHaveBeenCalledWith(
      expect.objectContaining({ language: "French" }),
    );

    await generateMaterialDraftAction(
      undefined,
      fd({ bookingId: "b1", topic: "x", language: "Japanese" }),
    );
    expect(generateClassContentForBooking).toHaveBeenCalledWith(
      expect.objectContaining({ language: "Japanese" }),
    );
  });

  it("sends null rather than an empty string when no language is posted", async () => {
    await generateMaterialDraftAction(undefined, fd({ topic: "x" }));
    expect(generateLibraryMaterialForTeacher).toHaveBeenCalledWith(
      expect.objectContaining({ language: null }),
    );
  });

  // Lesson continuity: the picker posts one hidden `continueFromMaterialId`
  // input per checked previous-class material (same convention as
  // `focusTagId`). Booking-scope only — the library-generation branch never
  // reads the field.
  it("forwards posted continueFromMaterialId values on the booking scope", async () => {
    const f = new FormData();
    f.set("bookingId", "b1");
    f.set("topic", "x");
    f.append("continueFromMaterialId", "prev1");
    f.append("continueFromMaterialId", "prev2");
    await generateMaterialDraftAction(undefined, f);
    expect(generateClassContentForBooking).toHaveBeenCalledWith(
      expect.objectContaining({ continueFromMaterialIds: ["prev1", "prev2"] }),
    );
  });

  it("sends an empty array when no continuation material is picked", async () => {
    await generateMaterialDraftAction(undefined, fd({ bookingId: "b1", topic: "x" }));
    expect(generateClassContentForBooking).toHaveBeenCalledWith(
      expect.objectContaining({ continueFromMaterialIds: [] }),
    );
  });
});

describe("listMaterialRevisionsFor — dispatch", () => {
  it("lists booking revisions when bookingId is given", async () => {
    const r = await listMaterialRevisionsFor({ teacherId: "t1", bookingId: "b1" });
    expect(r).toEqual([{ id: "r1" }]);
    expect(listClassContentRevisionsForBooking).toHaveBeenCalledWith({
      teacherId: "t1",
      bookingId: "b1",
    });
    expect(listLibraryMaterialRevisions).not.toHaveBeenCalled();
  });

  it("lists library revisions when only materialId is given", async () => {
    const r = await listMaterialRevisionsFor({ teacherId: "t1", materialId: "lib-1" });
    expect(r).toEqual([{ id: "r2" }]);
    expect(listLibraryMaterialRevisions).toHaveBeenCalledWith({
      teacherId: "t1",
      materialId: "lib-1",
    });
  });

  it("returns an empty list when neither is given", async () => {
    const r = await listMaterialRevisionsFor({ teacherId: "t1" });
    expect(r).toEqual([]);
    expect(listClassContentRevisionsForBooking).not.toHaveBeenCalled();
    expect(listLibraryMaterialRevisions).not.toHaveBeenCalled();
  });
});

describe("restoreMaterialRevisionAction — dispatch", () => {
  it("restores a booking's content and re-fetches it for the editor", async () => {
    const r = await restoreMaterialRevisionAction(
      undefined,
      fd({ bookingId: "b1", materialId: "content-1", revisionId: "r1" }),
    );
    expect(restoreClassContentRevisionForBooking).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: "t1", bookingId: "b1", revisionId: "r1" }),
    );
    expect(getClassContentForBooking).toHaveBeenCalledWith({ teacherId: "t1", bookingId: "b1" });
    expect(r).toEqual({ ok: true, body: "# Restored", source: "manual" });
  });

  it("restores a library item and re-fetches it, scoped to the teacher", async () => {
    const r = await restoreMaterialRevisionAction(
      undefined,
      fd({ materialId: "lib-1", revisionId: "r2" }),
    );
    expect(restoreLibraryMaterialRevision).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: "t1", materialId: "lib-1", revisionId: "r2" }),
    );
    expect(libraryMaterialFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "lib-1", teacherId: "t1" } }),
    );
    expect(r).toEqual({ ok: true, body: "# Restored lib", source: "manual" });
  });

  it("surfaces a handler error", async () => {
    restoreLibraryMaterialRevision.mockResolvedValue({
      ok: false,
      code: "not-found",
      message: "Esa versión ya no está disponible.",
    });
    const r = await restoreMaterialRevisionAction(
      undefined,
      fd({ materialId: "lib-1", revisionId: "gone" }),
    );
    expect(r).toEqual({ error: "Esa versión ya no está disponible." });
  });
});

describe("saveMaterialAttachmentAction — library scope", () => {
  it("requires a level and never syncs tags on a rejected save", async () => {
    saveMaterialAttachment.mockResolvedValue({
      ok: false,
      code: "invalid",
      message: "Elige un nivel.",
    });
    const r = await saveMaterialAttachmentAction(undefined, fd({ linkUrl: "https://x.com" }));
    expect(r).toEqual({ error: "Elige un nivel." });
    expect(syncLibraryMaterialFocusTags).not.toHaveBeenCalled();
  });

  it("saves a library-scope link attachment and syncs tags, without a booking lookup", async () => {
    const r = await saveMaterialAttachmentAction(
      undefined,
      fd({ levelId: "lvl1", linkUrl: "https://x.com", focusTagId: "tag1" }),
    );
    expect(r).toEqual({ ok: true, error: undefined });
    expect(saveMaterialAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: "t1", bookingId: null, levelId: "lvl1" }),
    );
    expect(syncLibraryMaterialFocusTags).toHaveBeenCalledWith("t1", "att-1", ["tag1"]);
  });
});
