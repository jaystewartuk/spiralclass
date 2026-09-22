import { beforeEach, describe, expect, it, vi } from "vitest";

// Settings → Booking page → "Share progress with my students".
//
// The behaviour worth pinning is that ONE flip moves two things: the teacher's
// default for future students, and every pairing she already has. The public
// booking page promises the vocabulary review whenever the default is on, so a
// toggle that only governed new students would leave the promise false for the
// roster she had when she flipped it — and a toggle that only governed
// existing students would leave it false for everyone who buys afterwards.

vi.mock("server-only", () => ({}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));

vi.mock("@/lib/auth", () => ({
  requireTeacher: vi.fn(async () => ({ id: "t-1", bookingSlug: "alicia-moreno" })),
}));

const teacherUpdate = vi.fn((_args: unknown) => ({ __op: "teacher.update" }));
const pairingsUpdateMany = vi.fn((_args: unknown) => ({ __op: "teacherStudent.updateMany" }));
const transaction = vi.fn(async (ops: unknown[]) => ops);

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (ops: unknown[]) => transaction(ops),
    teacher: { update: (args: unknown) => teacherUpdate(args) },
    teacherStudent: { updateMany: (args: unknown) => pairingsUpdateMany(args) },
  },
}));

const { setProgressSharingAction } = await import("@/app/actions/progress-sharing");

function formData(shared: boolean): FormData {
  const fd = new FormData();
  if (shared) fd.set("shared", "on");
  return fd;
}

beforeEach(() => vi.clearAllMocks());

describe("setProgressSharingAction", () => {
  it("turns sharing on for the teacher's default AND every existing student", async () => {
    const result = await setProgressSharingAction(undefined, formData(true));

    expect(result).toEqual({ ok: true, shared: true });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t-1" },
        data: { shareProgressByDefault: true },
      }),
    );
    expect(pairingsUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teacherId: "t-1" },
        data: { shareProgress: true },
      }),
    );
  });

  it("turns it off again for both, so changing her mind actually takes effect", async () => {
    const result = await setProgressSharingAction(undefined, formData(false));

    expect(result).toEqual({ ok: true, shared: false });
    expect(teacherUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { shareProgressByDefault: false } }),
    );
    expect(pairingsUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { shareProgress: false } }),
    );
  });

  it("writes both in one transaction, never a half-applied policy", async () => {
    await setProgressSharingAction(undefined, formData(true));
    expect(transaction).toHaveBeenCalledOnce();
    expect(transaction.mock.calls[0]![0]).toHaveLength(2);
  });

  it("revalidates only the settings page the toggle is on (D-174)", async () => {
    await setProgressSharingAction(undefined, formData(true));
    // Her public /b/<slug> reflects the setting too, but it is a dynamic route
    // with nothing prerendered to invalidate — and a second revalidation would
    // make the client discard this form's own result.
    expect(revalidatePath.mock.calls.map((c) => c[0])).toEqual(["/settings/booking-page"]);
  });
});
