import { beforeEach, describe, expect, it, vi } from "vitest";

// snapshotRefineCheckpointAction (app/actions/library.ts) — the thin,
// directly-callable server action material-form.tsx dispatches the instant
// an AI refine applies client-side, so Version History gets a checkpoint for
// "what was here before the AI changed it" without waiting for the next
// explicit Save (lib/materials/handlers.ts#snapshotMaterialRevisionBeforeRefine
// holds the actual ownership-scoped logic and its own tests). What matters
// here is the thin wrapper's contract: it authenticates, forwards the exact
// input, and — the whole reason it exists as a separate action rather than
// being inlined — never lets a failure escape to the caller, since the
// client dispatches it fire-and-forget over an AI edit that already applied.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: vi.fn(),
  flushAnalytics: vi.fn(async () => {}),
}));
vi.mock("@/lib/storage/materials-upload", () => ({
  materialLinkSchema: { safeParse: vi.fn() },
  removeMaterialObject: vi.fn(),
  resolveMaterialAttachment: vi.fn(),
}));
vi.mock("@/lib/notifications/materials", () => ({ notifyLibraryMaterialAssigned: vi.fn() }));
vi.mock("@/lib/subscriptions/enforce", () => ({
  gateProFeature: vi.fn(),
  upgradeNudge: vi.fn(),
}));
vi.mock("@/lib/materials/config", () => ({ validateClassContentBody: vi.fn() }));
vi.mock("@/lib/materials/image-cleanup", () => ({ removeUnreferencedMaterialImages: vi.fn() }));
vi.mock("@/lib/materials/tags", () => ({ syncLibraryMaterialFocusTags: vi.fn() }));

const requireOnboardedTeacher = vi.fn(async () => ({ id: "t1" }));
vi.mock("@/lib/auth", () => ({ requireOnboardedTeacher }));

const snapshotMaterialRevisionBeforeRefine = vi.fn(async () => {});
vi.mock("@/lib/materials/handlers", () => ({
  generateClassContentForBooking: vi.fn(),
  generateLibraryMaterialForTeacher: vi.fn(),
  getClassContentForBooking: vi.fn(),
  listClassContentRevisionsForBooking: vi.fn(),
  listLibraryMaterialRevisions: vi.fn(),
  nextPositionInLevel: vi.fn(),
  refineMaterialForTeacher: vi.fn(),
  restoreClassContentRevisionForBooking: vi.fn(),
  restoreLibraryMaterialRevision: vi.fn(),
  saveClassContentForBooking: vi.fn(),
  saveLibraryContentMaterial: vi.fn(),
  saveMaterialAttachment: vi.fn(),
  snapshotMaterialRevisionBeforeRefine,
}));

const { snapshotRefineCheckpointAction } = await import("@/app/actions/library");

beforeEach(() => {
  requireOnboardedTeacher.mockClear();
  snapshotMaterialRevisionBeforeRefine.mockClear();
});

describe("snapshotRefineCheckpointAction", () => {
  it("authenticates and forwards the teacher id + input straight through", async () => {
    await snapshotRefineCheckpointAction({
      materialId: "m1",
      body: "# Before the AI touched it",
      source: "manual",
    });
    expect(requireOnboardedTeacher).toHaveBeenCalled();
    expect(snapshotMaterialRevisionBeforeRefine).toHaveBeenCalledWith({
      teacherId: "t1",
      materialId: "m1",
      body: "# Before the AI touched it",
      source: "manual",
    });
  });

  it("swallows a handler failure instead of throwing — a missed checkpoint must never surface as an error over an already-applied AI edit", async () => {
    snapshotMaterialRevisionBeforeRefine.mockRejectedValueOnce(new Error("db unavailable"));
    await expect(
      snapshotRefineCheckpointAction({ materialId: "m1", body: "# x", source: "ai" }),
    ).resolves.toBeUndefined();
  });

  it("swallows an auth failure too (e.g. a stale session) rather than rejecting", async () => {
    requireOnboardedTeacher.mockRejectedValueOnce(new Error("not authenticated"));
    await expect(
      snapshotRefineCheckpointAction({ materialId: "m1", body: "# x", source: "ai" }),
    ).resolves.toBeUndefined();
    expect(snapshotMaterialRevisionBeforeRefine).not.toHaveBeenCalled();
  });
});
