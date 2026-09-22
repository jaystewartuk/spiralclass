import { afterEach, describe, expect, it, vi } from "vitest";

// call-nudge.ts is a server action module; neutralize the server-only guard.
vi.mock("server-only", () => ({}));

const requireOnboardedTeacher = vi.fn();
const requireStudent = vi.fn();
vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: () => requireOnboardedTeacher(),
  requireStudent: () => requireStudent(),
}));

const findFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findFirst: (...args: unknown[]) => findFirst(...args) } },
}));

vi.mock("@/lib/students/identity", () => ({
  studentIdentityIds: async () => ["s1", "s2"],
}));

const nudgeCounterparty = vi.fn();
vi.mock("@/lib/video/nudge", () => ({
  nudgeCounterparty: (...args: unknown[]) => nudgeCounterparty(...args),
}));

import { nudgeFromStudent, nudgeFromTeacher } from "@/app/actions/call-nudge";

afterEach(() => {
  vi.clearAllMocks();
});

describe("nudgeFromTeacher", () => {
  it("resolves the student counterparty and forwards to the core", async () => {
    requireOnboardedTeacher.mockResolvedValue({ id: "t1", name: "Prof" });
    findFirst.mockResolvedValue({ id: "bk", studentId: "s9" });
    nudgeCounterparty.mockResolvedValue({ ok: true, delivered: 2 });

    const res = await nudgeFromTeacher("bk");

    expect(res).toEqual({ ok: true, delivered: 2 });
    expect(nudgeCounterparty).toHaveBeenCalledWith(expect.anything(), {
      bookingId: "bk",
      callerIdentity: "t1",
      callerName: "Prof",
      to: { type: "student", id: "s9" },
    });
  });

  it("returns not-found without nudging when the booking isn't hers", async () => {
    requireOnboardedTeacher.mockResolvedValue({ id: "t1", name: "Prof" });
    findFirst.mockResolvedValue(null);

    const res = await nudgeFromTeacher("bk");

    expect(res).toEqual({ ok: false, reason: "not-found" });
    expect(nudgeCounterparty).not.toHaveBeenCalled();
  });
});

describe("nudgeFromStudent", () => {
  it("resolves the teacher counterparty across the identity set and forwards", async () => {
    requireStudent.mockResolvedValue({ id: "s1", name: "Mira" });
    findFirst.mockResolvedValue({ id: "bk", teacherId: "t7" });
    nudgeCounterparty.mockResolvedValue({ ok: true, delivered: 1 });

    const res = await nudgeFromStudent("bk");

    expect(res).toEqual({ ok: true, delivered: 1 });
    // Scoped to the student's whole identity set, like the call-token route.
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "bk", studentId: { in: ["s1", "s2"] } },
      select: { id: true, teacherId: true },
    });
    expect(nudgeCounterparty).toHaveBeenCalledWith(expect.anything(), {
      bookingId: "bk",
      callerIdentity: "s1",
      callerName: "Mira",
      to: { type: "teacher", id: "t7" },
    });
  });

  it("returns not-found when the booking isn't the student's", async () => {
    requireStudent.mockResolvedValue({ id: "s1", name: "Mira" });
    findFirst.mockResolvedValue(null);

    const res = await nudgeFromStudent("bk");

    expect(res).toEqual({ ok: false, reason: "not-found" });
    expect(nudgeCounterparty).not.toHaveBeenCalled();
  });
});
