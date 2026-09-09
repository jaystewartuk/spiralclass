import { describe, expect, it, vi } from "vitest";

// `saveAvailabilityAction` validation surface. The success path is covered by
// integration tests (it writes AvailabilityRule rows); here we pin the
// error-shaping the form relies on: which control to redden (`field`) and the
// day-prefixed message for a range-level problem. All these cases fail the
// schema, so the action returns before touching the DB — the prisma mock only
// needs to exist for module import.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/auth", () => ({
  requireTeacher: vi.fn(async () => ({ id: TEACHER_ID })),
}));

vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: vi.fn(async () => "en"),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const { saveAvailabilityAction } = await import("@/app/actions/onboarding");

type Range = { weekday: number; start: string; end: string };

function form(
  ranges: Range[],
  opts: { bufferMin?: string; minAdvanceH?: string; maxAdvanceDays?: string } = {},
): FormData {
  const fd = new FormData();
  fd.set("bufferMin", opts.bufferMin ?? "10");
  fd.set("minAdvanceH", opts.minAdvanceH ?? "2");
  fd.set("maxAdvanceDays", opts.maxAdvanceDays ?? "60");
  for (const r of ranges) {
    fd.append("range_weekday", String(r.weekday));
    fd.append("range_start", r.start);
    fd.append("range_end", r.end);
  }
  return fd;
}

describe("saveAvailabilityAction — error targeting", () => {
  it("flags the ranges group (not a numeric field) for an empty schedule", async () => {
    const result = await saveAvailabilityAction(undefined, form([]));
    expect(result?.field).toBe("ranges");
    expect(result?.error).toBeTruthy();
  });

  it("names the day for an overlapping-range error", async () => {
    const result = await saveAvailabilityAction(
      undefined,
      form([
        { weekday: 5, start: "09:00", end: "11:00" },
        { weekday: 5, start: "10:00", end: "12:00" },
      ]),
    );
    expect(result?.field).toBe("ranges");
    expect(result?.error).toContain("Friday");
    expect(result?.error?.toLowerCase()).toContain("overlap");
  });

  it("points at the offending numeric field, not the first input", async () => {
    const result = await saveAvailabilityAction(
      undefined,
      form([{ weekday: 1, start: "09:00", end: "10:00" }], { maxAdvanceDays: "0" }),
    );
    expect(result?.field).toBe("maxAdvanceDays");
  });
});
