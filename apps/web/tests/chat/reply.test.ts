import { beforeEach, describe, expect, it, vi } from "vitest";

// validateReplyToId is the single place every chat send route (text/voice/
// video/image/file, web + mobile, teacher + student) checks that a
// client-supplied replyToId actually belongs to the SAME (teacherId,
// studentId) thread before trusting it.

const findUnique = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null);
vi.mock("@/lib/prisma", () => ({
  prisma: { message: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

const { validateReplyToId } = await import("@/lib/chat/reply");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("validateReplyToId", () => {
  it("returns replyToId: null without a lookup when replyToId is null", async () => {
    const result = await validateReplyToId(null, "t1", "s1");
    expect(result).toEqual({ ok: true, replyToId: null });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("returns replyToId: null without a lookup when replyToId is undefined", async () => {
    const result = await validateReplyToId(undefined, "t1", "s1");
    expect(result).toEqual({ ok: true, replyToId: null });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("rejects a non-string replyToId", async () => {
    const result = await validateReplyToId(42, "t1", "s1");
    expect(result).toEqual({ ok: false });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("rejects an empty-string replyToId", async () => {
    const result = await validateReplyToId("", "t1", "s1");
    expect(result).toEqual({ ok: false });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("accepts a replyToId pointing at a message in the same thread", async () => {
    findUnique.mockResolvedValueOnce({ teacherId: "t1", studentId: "s1" });
    const result = await validateReplyToId("m1", "t1", "s1");
    expect(result).toEqual({ ok: true, replyToId: "m1" });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "m1" },
      select: { teacherId: true, studentId: true },
    });
  });

  it("rejects a replyToId pointing at a message in a different thread", async () => {
    findUnique.mockResolvedValueOnce({ teacherId: "other-teacher", studentId: "other-student" });
    const result = await validateReplyToId("m1", "t1", "s1");
    expect(result).toEqual({ ok: false });
  });

  it("rejects a replyToId that doesn't resolve to any message", async () => {
    findUnique.mockResolvedValueOnce(null);
    const result = await validateReplyToId("ghost", "t1", "s1");
    expect(result).toEqual({ ok: false });
  });
});
