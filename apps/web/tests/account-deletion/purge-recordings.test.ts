import { beforeEach, describe, expect, it, vi } from "vitest";

// Closing a teacher's account destroys her recordings (D-136). The property that
// matters most here is the ORDER: the row is the only pointer to the R2 object,
// so a row must never be deleted while its object is still there.

type RemoveResult = { error: { message: string } | null };
const removeObject = vi.fn(async (_bucket: string, _paths: string[]): Promise<RemoveResult> => ({
  error: null,
}));
vi.mock("@/lib/storage/provider", () => ({
  getStorageProvider: () => ({ remove: removeObject }),
}));

const callRecordingFindMany = vi.fn(async () => [] as { id: string; storageKey: string }[]);
const callRecordingDeleteMany = vi.fn(async () => ({ count: 0 }));
const lessonAudioFindMany = vi.fn(async () => [] as { id: string; storageKey: string }[]);
const lessonAudioDeleteMany = vi.fn(async () => ({ count: 0 }));
const lessonTranscriptDeleteMany = vi.fn(async () => ({ count: 2 }));
const lessonSummaryDeleteMany = vi.fn(async () => ({ count: 1 }));

const { purgeTeacherRecordings } = await import("@/lib/account-deletion/purge-recordings");

const prisma = {
  callRecording: { findMany: callRecordingFindMany, deleteMany: callRecordingDeleteMany },
  lessonAudio: { findMany: lessonAudioFindMany, deleteMany: lessonAudioDeleteMany },
  lessonTranscript: { deleteMany: lessonTranscriptDeleteMany },
  lessonSummary: { deleteMany: lessonSummaryDeleteMany },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  callRecordingFindMany.mockResolvedValue([]);
  lessonAudioFindMany.mockResolvedValue([]);
});

describe("purgeTeacherRecordings", () => {
  it("deletes every object and row for the teacher, and the derived rows", async () => {
    callRecordingFindMany.mockResolvedValue([
      { id: "rec-1", storageKey: "recordings/b1/1.m4a" },
      { id: "rec-2", storageKey: "recordings/b2/2.mp4" },
    ]);
    lessonAudioFindMany.mockResolvedValue([{ id: "aud-1", storageKey: "lesson-audio/b1/s-1.ogg" }]);

    const result = await purgeTeacherRecordings(prisma, "teacher-1");

    expect(result).toEqual({
      recordings: 2,
      lessonAudio: 1,
      transcripts: 2,
      summaries: 1,
      objectsFailed: 0,
    });
    // Legacy .mp4 video recordings are purged the same as new .m4a ones.
    expect(removeObject).toHaveBeenCalledWith("recordings", ["recordings/b1/1.m4a"]);
    expect(removeObject).toHaveBeenCalledWith("recordings", ["recordings/b2/2.mp4"]);
    expect(removeObject).toHaveBeenCalledWith("recordings", ["lesson-audio/b1/s-1.ogg"]);
    expect(callRecordingDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["rec-1", "rec-2"] } },
    });
    expect(lessonAudioDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["aud-1"] } } });
    expect(lessonTranscriptDeleteMany).toHaveBeenCalledWith({ where: { teacherId: "teacher-1" } });
    expect(lessonSummaryDeleteMany).toHaveBeenCalledWith({ where: { teacherId: "teacher-1" } });
  });

  it("KEEPS the row when its object could not be deleted — the row is the only pointer", async () => {
    callRecordingFindMany.mockResolvedValue([
      { id: "rec-ok", storageKey: "recordings/b1/ok.m4a" },
      { id: "rec-bad", storageKey: "recordings/b1/bad.m4a" },
    ]);
    removeObject.mockImplementation(async (_bucket, paths) =>
      paths[0].endsWith("bad.m4a") ? { error: { message: "r2-delete-http-500" } } : { error: null },
    );

    const result = await purgeTeacherRecordings(prisma, "teacher-1");

    expect(result.objectsFailed).toBe(1);
    expect(result.recordings).toBe(1);
    // rec-bad is absent: deleting it would strand its object in R2 with nothing
    // left to find it by.
    expect(callRecordingDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["rec-ok"] } } });
  });

  it("does not batch objects into one call, so one bad key can't strand the rest", async () => {
    callRecordingFindMany.mockResolvedValue([
      { id: "r1", storageKey: "k1" },
      { id: "r2", storageKey: "k2" },
      { id: "r3", storageKey: "k3" },
    ]);

    await purgeTeacherRecordings(prisma, "teacher-1");

    // The provider's own remove() aborts a batch on its first failure.
    expect(removeObject).toHaveBeenCalledTimes(3);
    for (const call of removeObject.mock.calls) expect(call[1]).toHaveLength(1);
  });

  it("survives a remover that throws, counting it as a failure rather than aborting", async () => {
    callRecordingFindMany.mockResolvedValue([
      { id: "r1", storageKey: "k1" },
      { id: "r2", storageKey: "k2" },
    ]);
    removeObject.mockImplementationOnce(async () => {
      throw new Error("network down");
    });

    const result = await purgeTeacherRecordings(prisma, "teacher-1");

    expect(result.objectsFailed).toBe(1);
    expect(result.recordings).toBe(1);
    expect(callRecordingDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["r2"] } } });
  });

  it("issues no delete when the teacher has nothing stored", async () => {
    const result = await purgeTeacherRecordings(prisma, "teacher-1");

    expect(removeObject).not.toHaveBeenCalled();
    expect(callRecordingDeleteMany).not.toHaveBeenCalled();
    expect(lessonAudioDeleteMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ recordings: 0, lessonAudio: 0, objectsFailed: 0 });
  });
});
