import { beforeEach, describe, expect, it, vi } from "vitest";

// Teacher pause/resume of one of their own packages. A paused package is
// silently excluded from booking guards. Pin: validation, teacher scoping,
// the active⇄paused state-machine guards, and that the update flips to the
// right status.

const state = { pkg: null as { id: string; status: string; studentId: string } | null };

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));

const packageUpdate = vi.fn(async () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    package: {
      findFirst: vi.fn(async () => state.pkg),
      update: packageUpdate,
    },
  },
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const { togglePackagePauseAction } = await import("@/app/actions/packages");

const PKG_ID = "11111111-1111-4111-8111-111111111111";

function fd(intent: string, packageId = PKG_ID): FormData {
  const f = new FormData();
  f.set("packageId", packageId);
  f.set("intent", intent);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.pkg = { id: PKG_ID, status: "active", studentId: "s1" };
});

describe("togglePackagePauseAction", () => {
  it("rejects an invalid intent", async () => {
    const res = await togglePackagePauseAction(undefined, fd("destroy"));
    expect(res).toHaveProperty("error");
    expect(packageUpdate).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid package id", async () => {
    const res = await togglePackagePauseAction(undefined, fd("pause", "not-a-uuid"));
    expect(res).toHaveProperty("error");
  });

  it("404s a package outside the teacher's roster", async () => {
    state.pkg = null;
    const res = await togglePackagePauseAction(undefined, fd("pause"));
    expect(res).toHaveProperty("error");
    expect(packageUpdate).not.toHaveBeenCalled();
  });

  it("pauses an active package", async () => {
    const res = await togglePackagePauseAction(undefined, fd("pause"));
    expect(res).toEqual({ ok: true });
    expect(packageUpdate).toHaveBeenCalledWith({
      where: { id: PKG_ID },
      data: { status: "paused" },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/students/s1");
  });

  it("refuses to pause a package that isn't active", async () => {
    state.pkg = { id: PKG_ID, status: "paused", studentId: "s1" };
    const res = await togglePackagePauseAction(undefined, fd("pause"));
    expect(res).toHaveProperty("error");
    expect(packageUpdate).not.toHaveBeenCalled();
  });

  it("resumes a paused package", async () => {
    state.pkg = { id: PKG_ID, status: "paused", studentId: "s1" };
    const res = await togglePackagePauseAction(undefined, fd("resume"));
    expect(res).toEqual({ ok: true });
    expect(packageUpdate).toHaveBeenCalledWith({
      where: { id: PKG_ID },
      data: { status: "active" },
    });
  });

  it("refuses to resume a package that isn't paused", async () => {
    state.pkg = { id: PKG_ID, status: "active", studentId: "s1" };
    const res = await togglePackagePauseAction(undefined, fd("resume"));
    expect(res).toHaveProperty("error");
    expect(packageUpdate).not.toHaveBeenCalled();
  });
});
