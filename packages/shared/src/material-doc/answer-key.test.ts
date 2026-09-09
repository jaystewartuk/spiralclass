import { describe, expect, it } from "vitest";
import { parseMaterialDoc } from "./parse";
import { serializeMaterialDoc } from "./serialize";
import { hasAnswerKey, stripAnswerKey, stripAnswerKeyMarkdown } from "./answer-key";

// Round-tripping through the serializer keeps these assertions readable: the
// stripped tree is compared as Markdown rather than as a nested block literal.
function stripped(body: string): string {
  return serializeMaterialDoc(stripAnswerKey(parseMaterialDoc(body)));
}

describe("hasAnswerKey", () => {
  it("is false for a document with no answer callout", () => {
    const doc = parseMaterialDoc("# Lesson\n\n> [!exercise]\n> Fill the gap.");
    expect(hasAnswerKey(doc)).toBe(false);
  });

  it("is true for a top-level answer callout", () => {
    expect(hasAnswerKey(parseMaterialDoc("> [!answer]\n> Because."))).toBe(true);
  });

  it("is true for an answer nested inside a question callout", () => {
    const body = "> [!question] Q\n> What is it?\n>\n> > [!answer] A\n> > This.";
    expect(hasAnswerKey(parseMaterialDoc(body))).toBe(true);
  });

  it("is true for an answer nested under a list item", () => {
    const body = "1. First part\n\n   > [!answer]\n   > Yes.";
    expect(hasAnswerKey(parseMaterialDoc(body))).toBe(true);
  });
});

describe("stripAnswerKey", () => {
  it("returns the same doc reference when there is nothing to strip", () => {
    const doc = parseMaterialDoc("# Lesson\n\nJust prose.");
    expect(stripAnswerKey(doc)).toBe(doc);
  });

  it("removes a top-level answer callout, header and all", () => {
    const out = stripped("# Lesson\n\n> [!exercise]\n> Fill the gap.\n\n> [!answer]\n> the gap");
    expect(out).toContain("Fill the gap.");
    expect(out).not.toContain("the gap\n");
    expect(out).not.toContain("[!answer]");
  });

  it("removes an answer nested inside a question callout but keeps the question", () => {
    const out = stripped("> [!question] Q\n> What is it?\n>\n> > [!answer] A\n> > This.");
    expect(out).toContain("What is it?");
    expect(out).toContain("[!question]");
    expect(out).not.toContain("[!answer]");
    expect(out).not.toContain("This.");
  });

  it("removes an answer nested under a list item", () => {
    const out = stripped("1. First part\n\n   > [!answer]\n   > Yes.");
    expect(out).toContain("First part");
    expect(out).not.toContain("[!answer]");
    expect(out).not.toContain("Yes.");
  });

  it("removes an answer nested inside a plain quote", () => {
    const out = stripped("> Some quote\n>\n> > [!answer]\n> > Hidden.");
    expect(out).toContain("Some quote");
    expect(out).not.toContain("Hidden.");
  });

  it("leaves every other callout variant untouched", () => {
    const body = [
      "> [!tip]",
      "> A tip.",
      "",
      "> [!vocabulary] Key words",
      "> - la casa — the house",
      "",
      "> [!homework]",
      "> Do exercise 3.",
    ].join("\n");
    const out = stripped(body);
    expect(out).toContain("[!tip]");
    expect(out).toContain("[!vocabulary]");
    expect(out).toContain("[!homework]");
  });

  it("does not mutate the input document", () => {
    const doc = parseMaterialDoc("> [!answer]\n> Because.");
    const before = JSON.stringify(doc);
    stripAnswerKey(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("leaves nothing behind when the whole document is an answer key", () => {
    expect(stripAnswerKey(parseMaterialDoc("> [!answer]\n> Because.")).blocks).toEqual([]);
  });
});

describe("stripAnswerKeyMarkdown", () => {
  it("returns the same string reference when there is no answer key", () => {
    // Identity, not just equality: the no-answer case must not pay for a
    // parse/serialize round trip, and must not renormalize a teacher's body.
    const body = "# Lesson\n\n1) Odd marker\n\n> [!tip]\n> Keep me.";
    expect(stripAnswerKeyMarkdown(body)).toBe(body);
  });

  it("passes null and empty bodies straight through", () => {
    expect(stripAnswerKeyMarkdown(null)).toBeNull();
    expect(stripAnswerKeyMarkdown("")).toBe("");
  });

  it("cuts a top-level answer callout out of the Markdown", () => {
    const out = stripAnswerKeyMarkdown(
      "> [!exercise]\n> Fill the gap: I ___ tea.\n\n> [!answer]\n> drink",
    );
    expect(out).toContain("Fill the gap");
    expect(out).not.toContain("[!answer]");
    expect(out).not.toContain("drink");
  });

  it("cuts answers nested in a question callout and under a list item", () => {
    const out = stripAnswerKeyMarkdown(
      [
        "> [!question] Q1",
        "> Which is correct?",
        ">",
        "> > [!answer] A1",
        "> > The second one.",
        "",
        "1. Part one",
        "",
        "   > [!answer]",
        "   > forty-two",
      ].join("\n"),
    );
    expect(out).toContain("Which is correct?");
    expect(out).toContain("Part one");
    expect(out).not.toContain("[!answer]");
    expect(out).not.toContain("The second one.");
    expect(out).not.toContain("forty-two");
  });

  it("is idempotent — a second pass over a stripped body changes nothing", () => {
    const once = stripAnswerKeyMarkdown("> [!exercise]\n> Go.\n\n> [!answer]\n> Secret.");
    expect(stripAnswerKeyMarkdown(once)).toBe(once);
  });

  it("takes an image embedded only inside an answer with it", () => {
    // The PDF export already relies on this ordering (strip, then resolve
    // images) so a student copy never mints a URL for a picture that appears
    // only in an answer. Every other student surface now gets it for free.
    const out = stripAnswerKeyMarkdown(
      "> [!question]\n> Which one?\n\n> [!answer]\n> ![solution](material-image:t1/library/images/sol.png)",
    );
    expect(out).not.toContain("material-image:");
    expect(out).not.toContain("sol.png");
  });
});
