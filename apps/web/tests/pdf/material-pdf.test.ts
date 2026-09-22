import { describe, expect, it } from "vitest";
import { renderMaterialPdfBuffer } from "@/lib/pdf/material-pdf";

// %PDF magic bytes — the one universal signal that renderToBuffer produced a
// real PDF stream, without asserting on react-pdf's internal layout.
const PDF_MAGIC = "%PDF-";

describe("renderMaterialPdfBuffer", () => {
  it("renders a title-only PDF", async () => {
    const buf = await renderMaterialPdfBuffer({ title: "Past simple", body: "Hello there." });
    expect(buf.subarray(0, 5).toString("latin1")).toBe(PDF_MAGIC);
  });

  it("renders every Markdown construct ClassContentMarkdown supports without throwing", async () => {
    const body = [
      "# Heading 1",
      "## Heading 2",
      "### Heading 3",
      "",
      "A **bold** and *italic* paragraph with a [link](https://example.com) and `inline code`.",
      "",
      "- item one",
      "- item two",
      "",
      "1. first",
      "2. second",
      "",
      "> a blockquote",
      "",
      "---",
      "",
      "```",
      "const x = 1;",
      "```",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n");

    const buf = await renderMaterialPdfBuffer({ title: "Kitchen sink", body });
    expect(buf.subarray(0, 5).toString("latin1")).toBe(PDF_MAGIC);
    expect(buf.byteLength).toBeGreaterThan(500);
  });

  it("includes an optional meta line when provided", async () => {
    const buf = await renderMaterialPdfBuffer({
      title: "Unit 3",
      body: "Body text.",
      metaLine: "A1 · This level and below",
    });
    expect(buf.subarray(0, 5).toString("latin1")).toBe(PDF_MAGIC);
  });

  // The rendered text lives in a compressed content stream, so these assert on
  // size rather than grepping for the answer: dropping a block can only make
  // the document smaller, and the semantics of WHAT gets dropped are pinned by
  // packages/shared/src/material-doc/answer-key.test.ts.
  describe("answer key", () => {
    const WITH_ANSWERS = [
      "# Lesson",
      "",
      "> [!exercise]",
      "> Translate: la casa",
      "",
      "> [!answer]",
      "> the house — and here is a good deal more solution text to make the",
      "> difference in rendered size unambiguous rather than marginal.",
    ].join("\n");

    it("strips the answer callouts by default", async () => {
      const student = await renderMaterialPdfBuffer({ title: "Lesson", body: WITH_ANSWERS });
      const teacherCopy = await renderMaterialPdfBuffer({
        title: "Lesson",
        body: WITH_ANSWERS,
        includeAnswerKey: true,
      });
      expect(student.subarray(0, 5).toString("latin1")).toBe(PDF_MAGIC);
      expect(student.byteLength).toBeLessThan(teacherCopy.byteLength);
    });

    it("treats an explicit includeAnswerKey: false the same as omitting it", async () => {
      const omitted = await renderMaterialPdfBuffer({ title: "Lesson", body: WITH_ANSWERS });
      const explicit = await renderMaterialPdfBuffer({
        title: "Lesson",
        body: WITH_ANSWERS,
        includeAnswerKey: false,
      });
      expect(explicit.byteLength).toBe(omitted.byteLength);
    });

    it("renders identically either way when the material has no answer callouts", async () => {
      const body = "# Lesson\n\n> [!exercise]\n> Translate: la casa";
      const student = await renderMaterialPdfBuffer({ title: "Lesson", body });
      const teacherCopy = await renderMaterialPdfBuffer({
        title: "Lesson",
        body,
        includeAnswerKey: true,
      });
      // Same size means no stamp was added either — the cover only advertises an
      // answer key when there is really one in the file.
      expect(teacherCopy.byteLength).toBe(student.byteLength);
    });

    it("renders a document that is nothing but an answer key", async () => {
      const buf = await renderMaterialPdfBuffer({
        title: "Solutions",
        body: "> [!answer]\n> 1. b",
      });
      expect(buf.subarray(0, 5).toString("latin1")).toBe(PDF_MAGIC);
    });
  });

  it("renders semantic callouts, checklists, and aligned tables without throwing", async () => {
    const body = [
      "# Lesson",
      "",
      "> [!vocabulary] Key words",
      "> - la casa — the house",
      "",
      "- [x] done step",
      "- [ ] todo step",
      "",
      "| A | B |",
      "| :-- | --: |",
      "| 1 | 2 |",
    ].join("\n");

    const buf = await renderMaterialPdfBuffer({ title: "Mobile test", body });
    expect(buf.subarray(0, 5).toString("latin1")).toBe(PDF_MAGIC);
    expect(buf.byteLength).toBeGreaterThan(500);
  });

  // The tense timeline is the first block drawn with react-pdf's Svg
  // primitives. This renderer has no `Font.register` (built-in standard PDF
  // fonts only), so every mark has to be a vector — a glyph the standard fonts
  // don't carry would render as a blank box or throw. Rendering to a real
  // buffer is the check that the primitives are all supported at this version.
  describe("tense timeline", () => {
    const TIMELINE = [
      "```timeline",
      "past Before",
      "now Today",
      "future Later",
      "span 20 50 have lived here",
      "point 20 I moved to Mérida",
      "point 85 I will move away",
      "```",
    ].join("\n");

    it("renders a timeline to a real PDF", async () => {
      const buf = await renderMaterialPdfBuffer({ title: "Present perfect", body: TIMELINE });
      expect(buf.subarray(0, 5).toString("latin1")).toBe(PDF_MAGIC);
      expect(buf.byteLength).toBeGreaterThan(500);
    });

    it("renders a timeline with no span and no labels", async () => {
      const buf = await renderMaterialPdfBuffer({
        title: "Bare",
        body: "```timeline\npast\nnow\nfuture\npoint 0\npoint 100\n```",
      });
      expect(buf.subarray(0, 5).toString("latin1")).toBe(PDF_MAGIC);
    });

    // The graphic's height is pinned rather than derived from its content, so
    // that a tall block can't push the rest of a handout onto the next page —
    // the same rule the image block follows. A timeline with many markers must
    // therefore stay roughly the size of one with few.
    it("keeps a crowded timeline the same height as a sparse one", async () => {
      const sparse = "```timeline\npoint 50 a\n```";
      const crowded = `\`\`\`timeline\n${Array.from(
        { length: 8 },
        (_, i) => `point ${i * 12} a`,
      ).join("\n")}\n\`\`\``;
      const one = await renderMaterialPdfBuffer({ title: "T", body: sparse });
      const many = await renderMaterialPdfBuffer({ title: "T", body: crowded });
      // Both fit on a single page: react-pdf writes one `/Type /Page` object
      // per page, so a second page would show up in the (uncompressed) object
      // dictionary. The graphic is fixed-height; only the legend grows.
      const pages = (buf: Buffer) =>
        (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
      expect(pages(one)).toBe(1);
      expect(pages(many)).toBe(1);
    });
  });
});
