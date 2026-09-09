import { describe, expect, it } from "vitest";
import type { CallMaterial } from "./api";
import { studentCallMaterial } from "./call-material";

// The student copy of an in-call material. These tests are the standing proof
// that answer-key content cannot reach a student through the shared material
// view — every student-facing producer (getCallMaterials, the data-channel
// encoder AND its decoder) funnels through the function under test.

const content = (body: string | null): CallMaterial => ({
  id: "m1",
  label: "Present simple",
  kind: "content",
  body,
  viewUrl: null,
  fileKind: null,
});

const ANSWERED = [
  "# Present simple",
  "",
  "> [!exercise]",
  "> Complete the gap: She (go) to school.",
  "",
  "> [!answer]",
  "> goes",
  "",
  "> [!question] Why?",
  "> Third person singular.",
  ">",
  "> > [!answer]",
  "> > Because the subject is 'she'.",
].join("\n");

describe("studentCallMaterial", () => {
  it("cuts every answer callout out of the body, at any depth", () => {
    const out = studentCallMaterial(content(ANSWERED));
    expect(out.body).toContain("Complete the gap: She (go) to school.");
    expect(out.body).toContain("Third person singular.");
    expect(out.body).not.toContain("[!answer]");
    expect(out.body).not.toContain("goes");
    expect(out.body).not.toContain("Because the subject is");
  });

  it("keeps every non-answer field identical", () => {
    const src = content(ANSWERED);
    const out = studentCallMaterial(src);
    expect({ ...out, body: null }).toEqual({ ...src, body: null });
  });

  it("returns the same object reference when there is nothing to strip", () => {
    const src = content("# Just prose\n\n> [!tip]\n> Read it aloud.");
    expect(studentCallMaterial(src)).toBe(src);
  });

  it("leaves a file/link material (body null) untouched", () => {
    const file: CallMaterial = {
      id: "m2",
      label: "Worksheet",
      kind: "file",
      body: null,
      viewUrl: "https://x/y.pdf",
      fileKind: "pdf",
    };
    expect(studentCallMaterial(file)).toBe(file);
  });

  it("does NOT pretend to strip a PDF the teacher sends the student", () => {
    // The strip is a Markdown-body rule and there is no answer-key structure
    // inside a PDF to cut. Pinned so the honest version of the guarantee
    // survives: what protects a file is that the teacher picks "for the
    // student" for that one file, not anything this function does to it.
    const file: CallMaterial = {
      id: "m3",
      label: "Answer key.pdf",
      kind: "file",
      body: null,
      viewUrl: "https://x/answers.pdf",
      fileKind: "pdf",
    };
    expect(studentCallMaterial(file).viewUrl).toBe("https://x/answers.pdf");
  });

  it("is idempotent", () => {
    const once = studentCallMaterial(content(ANSWERED));
    expect(studentCallMaterial(once)).toBe(once);
  });

  it("does not mutate its input", () => {
    const src = content(ANSWERED);
    studentCallMaterial(src);
    expect(src.body).toBe(ANSWERED);
  });

  it("collapses a material that is nothing BUT an answer key to an empty body", () => {
    // Not `null`: the material is still a content material, it just has
    // nothing left to show the student. A null here would flip `kind`
    // resolution downstream and turn it into a link with no URL.
    const out = studentCallMaterial(content("> [!answer]\n> 42"));
    expect(out.body).toBe("");
    expect(out.kind).toBe("content");
  });
});
