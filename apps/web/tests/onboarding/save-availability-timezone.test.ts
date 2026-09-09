import { describe, expect, it, vi } from "vitest";

// D-53: saveAvailabilityAction must stamp every AvailabilityRule row with the
// teacher's current zone, so the rule is frozen in the clock it was written in
// and a later zone change can't silently reinterpret it. This exercises the
// success path (the validation surface is covered by save-availability.test.ts).

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const TEACHER_TZ = "America/Mexico_City";

const teacherUpdate = vi.fn((_args: { where: unknown; data: unknown }) => ({ __op: "update" }));
const deleteMany = vi.fn((_args: { where: unknown }) => ({ __op: "deleteMany" }));
const createMany = vi.fn((_args: { data: Array<Record<string, unknown>> }) => ({
  __op: "createMany",
}));
const $transaction = vi.fn(async (ops: unknown) => ops);

vi.mock("@/lib/auth", () => ({
  requireTeacher: vi.fn(async () => ({ id: TEACHER_ID, timezone: TEACHER_TZ })),
}));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "en") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: vi.fn(),
  flushAnalytics: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction,
    // findUnique backs maybeEmitMarketplaceReady's post-transaction re-check
    // — null short-circuits it harmlessly,
    // matching this test's focus (the timezone-stamping write), not activation.
    teacher: { update: teacherUpdate, findUnique: vi.fn(async () => null) },
    availabilityRule: { deleteMany, createMany },
  },
}));

const { saveAvailabilityAction } = await import("@/app/actions/onboarding");

function form(ranges: Array<{ weekday: number; start: string; end: string }>): FormData {
  const fd = new FormData();
  fd.set("bufferMin", "10");
  fd.set("minAdvanceH", "2");
  fd.set("maxAdvanceDays", "60");
  for (const r of ranges) {
    fd.append("range_weekday", String(r.weekday));
    fd.append("range_start", r.start);
    fd.append("range_end", r.end);
  }
  return fd;
}

describe("saveAvailabilityAction — timezone snapshot", () => {
  it("stamps every rule with the teacher's current zone", async () => {
    // The action ends in redirect(), which the mock throws — swallow it; we're
    // asserting on the write that happened just before.
    await expect(
      saveAvailabilityAction(
        undefined,
        form([
          { weekday: 1, start: "09:00", end: "13:00" },
          { weekday: 3, start: "16:00", end: "19:00" },
        ]),
      ),
    ).rejects.toThrow(/redirect:/);

    const arg = createMany.mock.calls[0]?.[0];
    expect(arg?.data).toHaveLength(2);
    for (const row of arg?.data ?? []) {
      expect(row).toMatchObject({ teacherId: TEACHER_ID, timezone: TEACHER_TZ });
    }
    // And the whole write went through one transaction.
    expect($transaction).toHaveBeenCalledOnce();
  });
});
