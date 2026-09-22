import { describe, expect, it } from "vitest";
import { parseHelpQa, splitHelpSections, stripMarkdown } from "./markdown";

describe("splitHelpSections", () => {
  it("splits on `##` and keeps everything under each heading", () => {
    const sections = splitHelpSections(
      ["## Purpose", "", "Do the thing.", "", "## Tips", "", "- One", "- Two"].join("\n"),
    );
    expect(sections.map((s) => s.heading)).toEqual(["Purpose", "Tips"]);
    expect(sections[0].body).toBe("Do the thing.");
    expect(sections[1].body).toBe("- One\n- Two");
  });

  it("keeps `###` sub-headings inside their parent section", () => {
    const sections = splitHelpSections(
      ["## Steps", "", "### Create an offer", "", "1. Open settings."].join("\n"),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].body).toContain("### Create an offer");
  });

  it("returns content before the first heading as an unnamed section", () => {
    const sections = splitHelpSections("Lead paragraph.\n\n## Purpose\n\nBody.");
    expect(sections[0]).toEqual({ heading: "", body: "Lead paragraph." });
    expect(sections[1].heading).toBe("Purpose");
  });

  it("ignores a `##` inside a fenced code block", () => {
    const sections = splitHelpSections(
      ["## Purpose", "", "```sh", "## not a heading", "```", "", "Done."].join("\n"),
    );
    expect(sections.map((s) => s.heading)).toEqual(["Purpose"]);
    expect(sections[0].body).toContain("## not a heading");
  });

  it("parses translated headings, which is the whole reason it is structural", () => {
    const sections = splitHelpSections("## Propósito\n\nCuerpo.\n\n## Solución de problemas\n\nX.");
    expect(sections.map((s) => s.heading)).toEqual(["Propósito", "Solución de problemas"]);
  });

  it("returns nothing for an empty body", () => {
    expect(splitHelpSections("")).toEqual([]);
  });
});

describe("parseHelpQa", () => {
  it("pairs a bold lead with the rest of its paragraph", () => {
    const qa = parseHelpQa("**How do students find me?** Share your public booking page.");
    expect(qa).toEqual([
      { question: "How do students find me?", answer: "Share your public booking page." },
    ]);
  });

  it("keeps a wrapped answer whole", () => {
    const qa = parseHelpQa(
      "**Can I change this later?** Yes. Open Settings\nto edit your profile.",
    );
    expect(qa[0].answer).toBe("Yes. Open Settings to edit your profile.");
  });

  it("strips markdown from both halves", () => {
    const qa = parseHelpQa(
      "**Why is it less?** See [Stripe's pricing](https://stripe.com/pricing).",
    );
    expect(qa[0].answer).toBe("See Stripe's pricing.");
  });

  it("ignores a bold label with nothing after it", () => {
    expect(parseHelpQa("**Tips**")).toEqual([]);
  });

  it("ignores a paragraph whose bold is not the lead", () => {
    expect(parseHelpQa("Set a clear **expiry period** for the package.")).toEqual([]);
  });

  it("collects every pair in a section", () => {
    const qa = parseHelpQa(
      ["**One?** First.", "", "**Two?** Second.", "", "Not a pair."].join("\n"),
    );
    expect(qa.map((item) => item.question)).toEqual(["One?", "Two?"]);
  });
});

describe("stripMarkdown", () => {
  it("keeps link text and drops the target", () => {
    expect(stripMarkdown("See [Stripe's pricing](https://stripe.com/pricing) for rates.")).toBe(
      "See Stripe's pricing for rates.",
    );
  });

  it("removes emphasis, code and image syntax", () => {
    expect(stripMarkdown("**Bold** and `code` and ![alt](a.png)")).toBe("Bold and code and alt");
  });

  it("collapses whitespace so a wrapped paragraph reads as one line", () => {
    expect(stripMarkdown("one\n  two\n\nthree")).toBe("one two three");
  });

  it("leaves an underscore inside a word alone", () => {
    expect(stripMarkdown("the utm_content slug")).toBe("the utm_content slug");
  });
});
