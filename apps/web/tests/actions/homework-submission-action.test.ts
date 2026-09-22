import { beforeEach, describe, expect, it, vi } from "vitest";

// The student's WEB hand-in path (app/actions/homework-submission.ts) — the
// mirror of api/mobile/student/assignments/[id]/submission/**.
//
// What's worth testing here is precisely what a second transport can get wrong:
// the policy checks are shared helpers, so these assert that the action calls
// them and honours their answers, that a submit is one transaction that also
// snapshots an attempt and attributes its files, and that ownership failures
// come back as a typed miss rather than throwing. The rules themselves
// (canEditSubmission / canSubmit) are the real implementations, not stubs —
// that is the point: web and mobile must agree on when a hand-in is allowed.

vi.mock("server-only", () => ({}));

const trackServerEvent = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: (...args: unknown[]) => trackServerEvent(...args),
  flushAnalytics: vi.fn(async () => {}),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const enqueueHomeworkSubmitted = vi.fn(async (..._args: unknown[]) => "notif-1");
vi.mock("@/lib/notifications/enqueue", () => ({
  enqueueHomeworkSubmitted: (...args: unknown[]) => enqueueHomeworkSubmitted(...args),
}));
vi.mock("@/lib/notifications/events", () => ({ emitNotificationQueued: vi.fn(async () => {}) }));

vi.mock("@/lib/auth", () => ({ requireStudent: vi.fn(async () => ({ id: "student-1" })) }));

class FakeApiAuthError extends Error {
  constructor(
    public status: number,
    public reason: string,
  ) {
    super(reason);
  }
}
vi.mock("@/lib/api/auth", () => ({ ApiAuthError: FakeApiAuthError }));

vi.mock("@/lib/storage/homework-file", () => ({
  ALLOWED_SUBMISSION_FILE_TYPES: { "application/pdf": "pdf" },
  MAX_SUBMISSION_FILE_BYTES: 25 * 1024 * 1024,
  deleteSubmissionObject: vi.fn(async () => true),
  headSubmissionObject: vi.fn(async () => 1024),
  isSubmissionFilePath: vi.fn(() => true),
  presignSubmissionUpload: vi.fn(() => ({ uploadUrl: "https://r2/put", storagePath: "hw/a/b" })),
}));

type Assignment = {
  id: string;
  bookingId: string;
  teacherId: string;
  dueAt: Date | null;
  allowLateSubmission: boolean;
  allowResubmission: boolean;
  title: string;
};

const state = {
  owned: true,
  assignment: {
    id: "a-1",
    bookingId: "b-1",
    teacherId: "t-1",
    dueAt: null,
    allowLateSubmission: false,
    allowResubmission: false,
    title: "Write five sentences",
  } as Assignment,
  submission: null as null | {
    id: string;
    status: string;
    submittedAt: Date | null;
    textResponse: string | null;
    files: { id: string; storagePath: string }[];
  },
  fileCount: 0,
};

vi.mock("@/lib/homework/access", () => ({
  resolveStudentAssignment: vi.fn(async () => {
    if (!state.owned) throw new FakeApiAuthError(404, "assignment-not-found");
    return { assignment: state.assignment, studentId: "student-1" };
  }),
}));

vi.mock("@/lib/homework/submission", () => ({
  findSubmission: vi.fn(async () => state.submission),
  ensureSubmission: vi.fn(async () => state.submission ?? { id: "s-1", files: [] }),
}));

const attemptCreate = vi.fn(async () => ({ id: "att-1" }));
const fileUpdateMany = vi.fn(async () => ({ count: 1 }));
const submissionUpsert = vi.fn(async () => ({
  id: "s-1",
  status: "submitted",
  submittedAt: new Date("2026-08-31T12:00:00Z"),
  files: [],
}));

const tx = {
  homeworkSubmission: { upsert: submissionUpsert },
  homeworkAttempt: { count: vi.fn(async () => 0), create: attemptCreate },
  homeworkSubmissionFile: { updateMany: fileUpdateMany },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    homeworkSubmission: {
      update: vi.fn(async () => ({})),
      findUniqueOrThrow: vi.fn(async () => ({ id: "s-1" })),
    },
    homeworkSubmissionFile: {
      count: vi.fn(async () => state.fileCount),
      create: vi.fn(async () => ({
        id: "f-1",
        fileName: "a.pdf",
        fileType: "application/pdf",
        fileSize: 1024,
      })),
      delete: vi.fn(async () => ({})),
    },
  },
}));

const {
  attachHomeworkFileAction,
  presignHomeworkFileAction,
  removeHomeworkFileAction,
  saveHomeworkDraftAction,
  submitHomeworkAction,
} = await import("@/app/actions/homework-submission");

const storage = await import("@/lib/storage/homework-file");
const { prisma } = await import("@/lib/prisma");

beforeEach(() => {
  vi.clearAllMocks();
  state.owned = true;
  state.assignment = {
    id: "a-1",
    bookingId: "b-1",
    teacherId: "t-1",
    dueAt: null,
    allowLateSubmission: false,
    allowResubmission: false,
    title: "Write five sentences",
  };
  state.submission = null;
  state.fileCount = 0;
});

describe("submitHomeworkAction", () => {
  it("hands in a typed answer, snapshots the attempt and attributes its files", async () => {
    const result = await submitHomeworkAction("a-1", "Mi respuesta");

    expect(result).toEqual({ ok: true });
    expect(submissionUpsert).toHaveBeenCalledOnce();
    // The attempt snapshot and the file attribution are the two things a
    // second transport most easily forgets — a submit that writes only the
    // submission row loses the hand-in history the teacher reviews.
    expect(attemptCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attemptNumber: 1, textResponse: "Mi respuesta" }),
      }),
    );
    expect(fileUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ attemptId: null }) }),
    );
    expect(enqueueHomeworkSubmitted).toHaveBeenCalledOnce();
  });

  it("records the hand-in as a web submission, not a mobile one", async () => {
    await submitHomeworkAction("a-1", "Mi respuesta");
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "homework_submitted",
        properties: expect.objectContaining({ surface: "web" }),
      }),
    );
  });

  it("refuses an empty hand-in with no text and no files", async () => {
    const result = await submitHomeworkAction("a-1", "   ");
    expect(result).toEqual({ ok: false, error: "empty-submission" });
    expect(submissionUpsert).not.toHaveBeenCalled();
  });

  it("accepts a file-only hand-in", async () => {
    state.fileCount = 1;
    expect(await submitHomeworkAction("a-1", null)).toEqual({ ok: true });
  });

  it("refuses a second hand-in when the assignment forbids resubmission", async () => {
    state.submission = {
      id: "s-1",
      status: "submitted",
      submittedAt: new Date(),
      textResponse: "first",
      files: [],
    };
    const result = await submitHomeworkAction("a-1", "second");
    expect(result).toEqual({ ok: false, error: "submission-locked" });
  });

  it("refuses a late hand-in when the assignment forbids one", async () => {
    state.assignment.dueAt = new Date(Date.now() - 60_000);
    const result = await submitHomeworkAction("a-1", "late answer");
    expect(result).toEqual({ ok: false, error: "past-due" });
  });

  it("allows a late hand-in when the assignment permits one", async () => {
    state.assignment.dueAt = new Date(Date.now() - 60_000);
    state.assignment.allowLateSubmission = true;
    expect(await submitHomeworkAction("a-1", "late answer")).toEqual({ ok: true });
  });

  it("reports someone else's assignment as a miss rather than throwing", async () => {
    state.owned = false;
    expect(await submitHomeworkAction("a-1", "answer")).toEqual({ ok: false, error: "not-found" });
  });
});

describe("saveHomeworkDraftAction", () => {
  it("refuses to overwrite an answer that has already been handed in", async () => {
    state.submission = {
      id: "s-1",
      status: "submitted",
      submittedAt: new Date(),
      textResponse: "handed in",
      files: [],
    };
    expect(await saveHomeworkDraftAction("a-1", "sneaky edit")).toEqual({
      ok: false,
      error: "submission-locked",
    });
  });

  it("saves while the submission is still a draft", async () => {
    state.submission = {
      id: "s-1",
      status: "draft",
      submittedAt: null,
      textResponse: "",
      files: [],
    };
    expect(await saveHomeworkDraftAction("a-1", "work in progress")).toEqual({ ok: true });
  });
});

describe("presignHomeworkFileAction", () => {
  it("issues an upload ticket for an allowed type", async () => {
    expect(await presignHomeworkFileAction("a-1", "application/pdf")).toEqual({
      ok: true,
      uploadUrl: "https://r2/put",
      storagePath: "hw/a/b",
    });
  });

  it("refuses a type outside the allowlist before minting anything", async () => {
    expect(await presignHomeworkFileAction("a-1", "application/x-sh")).toEqual({
      ok: false,
      error: "bad-type",
    });
    expect(storage.presignSubmissionUpload).not.toHaveBeenCalled();
  });

  it("refuses to issue a ticket once the submission is locked", async () => {
    state.submission = {
      id: "s-1",
      status: "submitted",
      submittedAt: new Date(),
      textResponse: "done",
      files: [],
    };
    expect(await presignHomeworkFileAction("a-1", "application/pdf")).toEqual({
      ok: false,
      error: "submission-locked",
    });
  });

  it("reports a storage outage rather than pretending the upload can start", async () => {
    vi.mocked(storage.presignSubmissionUpload).mockReturnValueOnce({
      error: "storage-not-configured",
    } as ReturnType<typeof storage.presignSubmissionUpload>);
    expect(await presignHomeworkFileAction("a-1", "application/pdf")).toEqual({
      ok: false,
      error: "upload-unavailable",
    });
  });
});

describe("attachHomeworkFileAction", () => {
  const file = { storagePath: "hw/a/b", fileName: "essay.pdf", mimeType: "application/pdf" };

  it("records the file with the size read back from storage, not the client's word", async () => {
    vi.mocked(storage.headSubmissionObject).mockResolvedValueOnce(4096);
    const result = await attachHomeworkFileAction("a-1", file);

    expect(result).toEqual({ ok: true, fileId: "f-1" });
    expect(prisma.homeworkSubmissionFile.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fileSize: 4096 }) }),
    );
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "homework_file_attached",
        properties: expect.objectContaining({ surface: "web" }),
      }),
    );
  });

  it("refuses a path outside this student's own prefix", async () => {
    vi.mocked(storage.isSubmissionFilePath).mockReturnValueOnce(false);
    expect(await attachHomeworkFileAction("a-1", file)).toEqual({ ok: false, error: "bad-path" });
    expect(prisma.homeworkSubmissionFile.create).not.toHaveBeenCalled();
  });

  it("refuses a file that never actually landed in storage", async () => {
    vi.mocked(storage.headSubmissionObject).mockResolvedValueOnce(null);
    expect(await attachHomeworkFileAction("a-1", file)).toEqual({
      ok: false,
      error: "not-uploaded",
    });
  });

  it("enforces the size cap on the real size, so a small claim can't smuggle a big file", async () => {
    vi.mocked(storage.headSubmissionObject).mockResolvedValueOnce(26 * 1024 * 1024);
    expect(await attachHomeworkFileAction("a-1", file)).toEqual({
      ok: false,
      error: "file-too-large",
    });
    expect(prisma.homeworkSubmissionFile.create).not.toHaveBeenCalled();
  });
});

describe("removeHomeworkFileAction", () => {
  it("refuses a file id that does not belong to this submission", async () => {
    state.submission = {
      id: "s-1",
      status: "draft",
      submittedAt: null,
      textResponse: null,
      files: [{ id: "mine", storagePath: "hw/mine" }],
    };
    expect(await removeHomeworkFileAction("a-1", "someone-elses")).toEqual({
      ok: false,
      error: "not-found",
    });
  });

  it("removes a file that does", async () => {
    state.submission = {
      id: "s-1",
      status: "draft",
      submittedAt: null,
      textResponse: null,
      files: [{ id: "mine", storagePath: "hw/mine" }],
    };
    expect(await removeHomeworkFileAction("a-1", "mine")).toEqual({ ok: true });
  });
});
