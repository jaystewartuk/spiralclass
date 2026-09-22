import { beforeEach, describe, expect, it, vi } from "vitest";

// Student profile-photo actions — the student twin of profile-action.test.ts's
// saveTeacherPhotoAction/removeTeacherPhotoAction, but against the PRIVATE
// student-photos bucket (signed URL, not public).

const state = { student: { id: "s1", photoPath: null as string | null } };
vi.mock("@/lib/auth", () => ({ requireStudent: vi.fn(async () => state.student) }));

const studentUpdate = vi.fn(async (_arg: { data: Record<string, unknown> }) => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: { student: { update: studentUpdate } } }));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const upload = vi.fn(async () => ({ error: null as { message: string } | null }));
const remove = vi.fn(async () => ({ error: null as { message: string } | null }));
const ensureBucket = vi.fn(async () => {});
vi.mock("@/lib/storage/provider", () => ({
  getStorageProvider: () => ({
    upload,
    remove,
    ensureBucket,
    publicUrl: vi.fn(),
    createSignedUrl: vi.fn(),
  }),
}));

const { saveStudentPhotoAction, removeStudentPhotoAction } =
  await import("@/app/actions/student-photo");

function photoForm(file: File | string): FormData {
  const f = new FormData();
  f.set("photo", file);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.student = { id: "s1", photoPath: null };
});

describe("saveStudentPhotoAction", () => {
  it("requires a non-empty file", async () => {
    const res = await saveStudentPhotoAction(undefined, photoForm(new File([], "x.png")));
    expect(res).toHaveProperty("error");
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects a disallowed content type", async () => {
    const gif = new File([new Uint8Array([1, 2, 3])], "a.gif", { type: "image/gif" });
    expect(await saveStudentPhotoAction(undefined, photoForm(gif))).toHaveProperty("error");
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects an oversized image", async () => {
    const big = new File([new Uint8Array(6 * 1024 * 1024)], "a.png", { type: "image/png" });
    expect(await saveStudentPhotoAction(undefined, photoForm(big))).toHaveProperty("error");
    expect(upload).not.toHaveBeenCalled();
  });

  it("uploads a valid image and stores the pointer", async () => {
    const ok = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    const res = await saveStudentPhotoAction(undefined, photoForm(ok));
    expect(res).toEqual({ ok: true });
    // The private student-photos bucket, keyed by student id (same shape as
    // the teacher's public bucket).
    expect(upload).toHaveBeenCalledWith("student-photos", "s1", ok, {
      contentType: "image/png",
      upsert: true,
    });
    expect(studentUpdate.mock.calls[0][0].data).toEqual({ photoPath: "s1" });
  });

  it("surfaces an upload error", async () => {
    upload.mockResolvedValueOnce({ error: { message: "storage full" } });
    const ok = new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" });
    expect(await saveStudentPhotoAction(undefined, photoForm(ok))).toHaveProperty("error");
    expect(studentUpdate).not.toHaveBeenCalled();
  });
});

describe("removeStudentPhotoAction", () => {
  it("clears the pointer even when there was no photo", async () => {
    const res = await removeStudentPhotoAction();
    expect(res).toEqual({ ok: true });
    expect(studentUpdate.mock.calls[0][0].data).toEqual({ photoPath: null });
  });
});
