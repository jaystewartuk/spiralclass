import { describe, expect, it, vi } from "vitest";

// wire.ts is a server module (`import "server-only"`); neutralize the guard.
vi.mock("server-only", () => ({}));

// The wire module signs file URLs through the storage seam; stub it so these
// pure status-derivation tests need no R2 config.
vi.mock("@/lib/storage/homework-file", () => ({
  mintSubmissionSignedUrl: vi.fn(async () => "https://cdn.test/hw.pdf"),
}));

import {
  canEditSubmission,
  canSubmit,
  displayStatus,
  isSubmissionLate,
  toWireAttempt,
  toWireFeedback,
} from "@/lib/homework/wire";

const DUE = new Date("2026-07-20T17:00:00Z");
const BEFORE = new Date("2026-07-20T16:00:00Z");
const AFTER = new Date("2026-07-20T18:00:00Z");

describe("isSubmissionLate", () => {
  it("is false without a due date or submit time", () => {
    expect(isSubmissionLate(null, DUE)).toBe(false);
    expect(isSubmissionLate(AFTER, null)).toBe(false);
  });
  it("is true only when submitted after the due date", () => {
    expect(isSubmissionLate(BEFORE, DUE)).toBe(false);
    expect(isSubmissionLate(AFTER, DUE)).toBe(true);
  });
});

describe("displayStatus", () => {
  it("is not_submitted with no submission row", () => {
    expect(displayStatus(null, DUE)).toBe("not_submitted");
  });
  it("passes draft/returned/graded through unchanged", () => {
    expect(displayStatus({ status: "draft", submittedAt: null }, DUE)).toBe("draft");
    expect(displayStatus({ status: "returned", submittedAt: null }, DUE)).toBe("returned");
    expect(displayStatus({ status: "graded", submittedAt: AFTER }, DUE)).toBe("graded");
  });
  it("derives late for a submitted hand-in past the due date", () => {
    expect(displayStatus({ status: "submitted", submittedAt: AFTER }, DUE)).toBe("late");
    expect(displayStatus({ status: "submitted", submittedAt: BEFORE }, DUE)).toBe("submitted");
    expect(displayStatus({ status: "submitted", submittedAt: AFTER }, null)).toBe("submitted");
  });
});

describe("canEditSubmission", () => {
  it("allows editing a fresh (no row) or draft/returned submission", () => {
    expect(canEditSubmission(null, false)).toBe(true);
    expect(canEditSubmission({ status: "draft" }, false)).toBe(true);
    expect(canEditSubmission({ status: "returned" }, false)).toBe(true);
  });
  it("locks a submitted row unless resubmission is allowed", () => {
    expect(canEditSubmission({ status: "submitted" }, false)).toBe(false);
    expect(canEditSubmission({ status: "submitted" }, true)).toBe(true);
  });
  it("always locks a graded row", () => {
    expect(canEditSubmission({ status: "graded" }, true)).toBe(false);
  });
});

describe("canSubmit", () => {
  const base = { allowLateSubmission: true, allowResubmission: false, dueAt: DUE };

  it("allows a first submit before the due date", () => {
    expect(canSubmit(null, base, BEFORE)).toBe(true);
  });
  it("blocks a late submit when late submission is disallowed", () => {
    expect(canSubmit(null, { ...base, allowLateSubmission: false }, AFTER)).toBe(false);
  });
  it("allows a late submit when late submission is allowed", () => {
    expect(canSubmit(null, base, AFTER)).toBe(true);
  });
  it("blocks re-submitting an already-submitted assignment without resubmission", () => {
    expect(canSubmit({ status: "submitted" }, base, BEFORE)).toBe(false);
    expect(canSubmit({ status: "submitted" }, { ...base, allowResubmission: true }, BEFORE)).toBe(
      true,
    );
  });
});

describe("toWireFeedback", () => {
  it("maps a feedback row to its wire shape", () => {
    expect(
      toWireFeedback({
        id: "f1",
        attemptId: "at1",
        teacherId: "t1",
        decision: "approved",
        content: "Great work!",
        score: 9,
        aiDraftId: null,
        createdAt: AFTER,
      } as never),
    ).toEqual({
      id: "f1",
      decision: "approved",
      content: "Great work!",
      score: 9,
      createdAt: AFTER.toISOString(),
    });
  });
});

describe("toWireAttempt", () => {
  it("nests feedback and maps files in upload order", async () => {
    const wire = await toWireAttempt({
      id: "at1",
      submissionId: "sub1",
      attemptNumber: 2,
      textResponse: "answer",
      submittedAt: AFTER,
      files: [
        {
          id: "f2",
          submissionId: "sub1",
          teacherId: "t1",
          storagePath: "p2",
          fileName: "b.pdf",
          fileType: "application/pdf",
          fileSize: 20,
          uploadedAt: AFTER,
          attemptId: "at1",
        },
        {
          id: "f1",
          submissionId: "sub1",
          teacherId: "t1",
          storagePath: "p1",
          fileName: "a.pdf",
          fileType: "application/pdf",
          fileSize: 10,
          uploadedAt: BEFORE,
          attemptId: "at1",
        },
      ],
      feedback: null,
    } as never);
    expect(wire.attemptNumber).toBe(2);
    expect(wire.feedback).toBeNull();
    expect(wire.files.map((f) => f.fileName)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("surfaces the attempt's own feedback when present", async () => {
    const wire = await toWireAttempt({
      id: "at1",
      submissionId: "sub1",
      attemptNumber: 1,
      textResponse: "answer",
      submittedAt: BEFORE,
      files: [],
      feedback: {
        id: "f1",
        attemptId: "at1",
        teacherId: "t1",
        decision: "rejected",
        content: "Try again",
        score: null,
        aiDraftId: null,
        createdAt: AFTER,
      },
    } as never);
    expect(wire.feedback).toEqual({
      id: "f1",
      decision: "rejected",
      content: "Try again",
      score: null,
      createdAt: AFTER.toISOString(),
    });
  });
});
