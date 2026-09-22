import { beforeEach, describe, expect, it, vi } from "vitest";

// Calendar-feed token rotation actions. Each just gates on the right role,
// rotates that principal's token (invalidating the old subscription URL), and
// revalidates the page that displays it.

const rotateTeacherFeedToken = vi.fn(async () => {});
const rotateStudentFeedToken = vi.fn(async () => {});
vi.mock("@/lib/calendar/feed-token", () => ({
  rotateTeacherFeedToken,
  rotateStudentFeedToken,
}));

vi.mock("@/lib/auth", () => ({
  requireTeacher: vi.fn(async () => ({ id: "t1" })),
  requireStudent: vi.fn(async () => ({ id: "s1" })),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const { regenerateTeacherFeedAction, regenerateStudentFeedAction } =
  await import("@/app/actions/calendar-feed");

beforeEach(() => vi.clearAllMocks());

describe("regenerateTeacherFeedAction", () => {
  it("rotates the teacher token and revalidates the calendar settings page", async () => {
    const res = await regenerateTeacherFeedAction(undefined, new FormData());
    expect(res).toEqual({ ok: true });
    expect(rotateTeacherFeedToken).toHaveBeenCalledWith("t1");
    expect(revalidatePath).toHaveBeenCalledWith("/settings/calendar");
  });
});

describe("regenerateStudentFeedAction", () => {
  it("rotates the student token and revalidates the account page", async () => {
    const res = await regenerateStudentFeedAction(undefined, new FormData());
    expect(res).toEqual({ ok: true });
    expect(rotateStudentFeedToken).toHaveBeenCalledWith("s1");
    expect(revalidatePath).toHaveBeenCalledWith("/my-classes/account");
  });
});
