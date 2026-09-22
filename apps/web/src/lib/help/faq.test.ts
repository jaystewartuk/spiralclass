import { describe, expect, it } from "vitest";
import type { ContentDoc } from "@spiralclass/shared";
import { collectHelpFaq } from "./faq";
import { prepareHelpGuides } from "./guides";

const doc = (slug: string, body: string): ContentDoc => ({
  slug,
  audience: "teacher",
  title: { en: slug },
  summary: { en: "Summary." },
  body: { en: body },
});

const faqFor = (docs: ContentDoc[]) => collectHelpFaq(prepareHelpGuides(docs, "en", () => null));

describe("collectHelpFaq", () => {
  it("collects the real questions, not the section headings", () => {
    const items = faqFor([
      doc("a", "## Questions\n\n**Can I change this later?** Yes. Open Settings."),
    ]);
    expect(items).toEqual([
      { question: "Can I change this later?", answer: "Yes. Open Settings." },
    ]);
  });

  it("leaves a troubleshooting symptom out of the markup", () => {
    const items = faqFor([
      doc("a", "## Troubleshooting\n\n**A student cannot book.** Check the package."),
    ]);
    expect(items).toEqual([]);
  });

  it("strips markdown out of the answer text", () => {
    const items = faqFor([
      doc("a", "## Questions\n\n**Why?** See [Stripe's pricing](https://stripe.com/pricing)."),
    ]);
    expect(items[0].answer).toBe("See Stripe's pricing.");
  });

  it("de-duplicates a question two guides both answer", () => {
    const items = faqFor([
      doc("a", "## Questions\n\n**Same question?** One."),
      doc("b", "## Questions\n\n**Same question?** Two."),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].answer).toBe("One.");
  });

  it("returns nothing when the docs contain no questions", () => {
    expect(faqFor([doc("a", "## Purpose\n\nJust prose.")])).toEqual([]);
  });
});
