import { beforeEach, describe, expect, it, vi } from "vitest";

// material_opened / material_completed — the PostHog engagement events added
// to close the "library_viewed has no downstream signal" gap (product issue
// #2). Exercises trackMaterialEngagement's materialType derivation and
// property shaping directly, with an injected fake db (mirrors
// student-view.test.ts's DI pattern) rather than going through a route.

const trackServerEventMock = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent: trackServerEventMock }));

const { trackMaterialEngagement } = await import("@/lib/library/engagement");

type FakeMaterial = {
  id: string;
  label: string | null;
  teacherId: string;
  body: string | null;
  storagePath: string | null;
  podcast: { status: string } | null;
};

function fakeDb(material: FakeMaterial | null) {
  return { libraryMaterial: { findUnique: vi.fn(async () => material) } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("trackMaterialEngagement", () => {
  it("returns false and never tracks when the material doesn't exist", async () => {
    const ok = await trackMaterialEngagement("s1", "missing", "opened", "web", undefined, {
      db: fakeDb(null),
    });
    expect(ok).toBe(false);
    expect(trackServerEventMock).not.toHaveBeenCalled();
  });

  it("classifies a ready podcast as audio even when it also has a body", async () => {
    const db = fakeDb({
      id: "m1",
      label: "Unit 3 vocab",
      teacherId: "t1",
      body: "some markdown",
      storagePath: null,
      podcast: { status: "ready" },
    });
    await trackMaterialEngagement("s1", "m1", "opened", "web", undefined, { db });
    expect(trackServerEventMock).toHaveBeenCalledWith({
      name: "material_opened",
      distinctId: "s1",
      properties: {
        materialId: "m1",
        materialTitle: "Unit 3 vocab",
        materialType: "audio",
        teacherId: "t1",
        surface: "web",
      },
    });
  });

  it("classifies a body-only material as content", async () => {
    const db = fakeDb({
      id: "m2",
      label: null,
      teacherId: "t1",
      body: "some markdown",
      storagePath: null,
      podcast: null,
    });
    await trackMaterialEngagement("s1", "m2", "opened", "mobile", undefined, { db });
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          materialTitle: "Untitled material",
          materialType: "content",
          surface: "mobile",
        }),
      }),
    );
  });

  it("classifies a storagePath-only material as file, and a bare material as link", async () => {
    await trackMaterialEngagement("s1", "m3", "opened", "web", undefined, {
      db: fakeDb({
        id: "m3",
        label: "PDF",
        teacherId: "t1",
        body: null,
        storagePath: "x.pdf",
        podcast: null,
      }),
    });
    expect(trackServerEventMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ properties: expect.objectContaining({ materialType: "file" }) }),
    );

    await trackMaterialEngagement("s1", "m4", "opened", "web", undefined, {
      db: fakeDb({
        id: "m4",
        label: "Link",
        teacherId: "t1",
        body: null,
        storagePath: null,
        podcast: null,
      }),
    });
    expect(trackServerEventMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ properties: expect.objectContaining({ materialType: "link" }) }),
    );
  });

  it("tracks material_completed with durationSeconds when provided", async () => {
    const db = fakeDb({
      id: "m1",
      label: "Unit 3 vocab",
      teacherId: "t1",
      body: "md",
      storagePath: null,
      podcast: { status: "ready" },
    });
    await trackMaterialEngagement("s1", "m1", "completed", "mobile", 42, { db });
    expect(trackServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "material_completed",
        properties: expect.objectContaining({ durationSeconds: 42 }),
      }),
    );
  });

  it("omits durationSeconds from material_completed when not provided", async () => {
    const db = fakeDb({
      id: "m1",
      label: "Unit 3 vocab",
      teacherId: "t1",
      body: null,
      storagePath: null,
      podcast: { status: "ready" },
    });
    await trackMaterialEngagement("s1", "m1", "completed", "web", undefined, { db });
    const call = trackServerEventMock.mock.calls[0]![0];
    expect(call.properties).not.toHaveProperty("durationSeconds");
  });
});
