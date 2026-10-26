import { beforeEach, describe, expect, it, vi } from "vitest";

// Saving the teacher's subtitle timing: whatever is posted goes through the
// shared parser, and only the calling teacher's own row is written.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const teacherUpdate = vi.fn(async (_args: unknown) => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: { teacher: { update: teacherUpdate } } }));
vi.mock("@/lib/auth", () => ({ requireTeacher: vi.fn(async () => ({ id: "t1" })) }));
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: vi.fn(),
  flushAnalytics: vi.fn(async () => {}),
}));

const { saveCaptionTimingAction } = await import("@/app/actions/caption-timing");

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(() => teacherUpdate.mockClear());

describe("saveCaptionTimingAction", () => {
  it("stores a valid setting on the calling teacher's own row", async () => {
    const res = await saveCaptionTimingAction(undefined, form({ pauseMs: "800", maxChars: "120" }));
    expect(res).toEqual({ ok: true });
    expect(teacherUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { captionTiming: { pauseMs: 800, maxChars: 120 } },
    });
  });

  it("clamps a hand-edited out-of-range value instead of storing it", async () => {
    await saveCaptionTimingAction(undefined, form({ pauseMs: "5", maxChars: "99999" }));
    expect(teacherUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { captionTiming: { pauseMs: 400, maxChars: 300 } },
    });
  });

  it("stores both dials off for a blank or missing form (back to the default)", async () => {
    await saveCaptionTimingAction(undefined, form({ pauseMs: "0" }));
    expect(teacherUpdate).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { captionTiming: { pauseMs: 0, maxChars: 0 } },
    });
  });
});
