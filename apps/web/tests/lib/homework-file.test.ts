import { describe, expect, it, vi } from "vitest";

// homework-file.ts is a server module (`import "server-only"`); neutralize the
// guard so these pure path-guard tests can import it.
vi.mock("server-only", () => ({}));

import { ALLOWED_SUBMISSION_FILE_TYPES, isSubmissionFilePath } from "@/lib/storage/homework-file";

const T = "teacher-1";
const A = "assignment-1";
const S = "student-1";
const PREFIX = `homework/${T}/${A}/${S}/`;

describe("isSubmissionFilePath", () => {
  it("accepts a well-formed path under the student's assignment prefix", () => {
    expect(isSubmissionFilePath(`${PREFIX}123.pdf`, T, A, S)).toBe(true);
    expect(isSubmissionFilePath(`${PREFIX}456.docx`, T, A, S)).toBe(true);
  });

  it("rejects a path outside this student's prefix (cross-tenant guard)", () => {
    // Another student's space.
    expect(isSubmissionFilePath(`homework/${T}/${A}/other-student/1.pdf`, T, A, S)).toBe(false);
    // Another assignment.
    expect(isSubmissionFilePath(`homework/${T}/other/${S}/1.pdf`, T, A, S)).toBe(false);
    // Another teacher.
    expect(isSubmissionFilePath(`homework/other/${A}/${S}/1.pdf`, T, A, S)).toBe(false);
    // A completely different bucket area.
    expect(isSubmissionFilePath(`file/${T}/${S}/1.pdf`, T, A, S)).toBe(false);
  });

  it("rejects traversal, nested keys, and empty leaf", () => {
    expect(isSubmissionFilePath(`${PREFIX}../escape.pdf`, T, A, S)).toBe(false);
    expect(isSubmissionFilePath(`${PREFIX}sub/dir.pdf`, T, A, S)).toBe(false);
    expect(isSubmissionFilePath(PREFIX, T, A, S)).toBe(false);
  });

  it("rejects a disallowed extension", () => {
    expect(isSubmissionFilePath(`${PREFIX}malware.exe`, T, A, S)).toBe(false);
    expect(isSubmissionFilePath(`${PREFIX}script.sh`, T, A, S)).toBe(false);
  });
});

describe("ALLOWED_SUBMISSION_FILE_TYPES", () => {
  it("covers the required PDF + Word types and the optional extras", () => {
    expect(ALLOWED_SUBMISSION_FILE_TYPES["application/pdf"]).toBe("pdf");
    expect(ALLOWED_SUBMISSION_FILE_TYPES["application/msword"]).toBe("doc");
    expect(
      ALLOWED_SUBMISSION_FILE_TYPES[
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ],
    ).toBe("docx");
    expect(ALLOWED_SUBMISSION_FILE_TYPES["image/jpeg"]).toBe("jpg");
    expect(ALLOWED_SUBMISSION_FILE_TYPES["text/plain"]).toBe("txt");
  });

  it("covers spoken-answer audio types (slice 7, same set as chat voice messages)", () => {
    expect(ALLOWED_SUBMISSION_FILE_TYPES["audio/mp4"]).toBe("m4a");
    expect(ALLOWED_SUBMISSION_FILE_TYPES["audio/mpeg"]).toBe("mp3");
    expect(ALLOWED_SUBMISSION_FILE_TYPES["audio/webm"]).toBe("webm");
  });

  it("excludes executable/script types", () => {
    expect(ALLOWED_SUBMISSION_FILE_TYPES["application/x-msdownload"]).toBeUndefined();
    expect(ALLOWED_SUBMISSION_FILE_TYPES["application/zip"]).toBeUndefined();
  });
});
