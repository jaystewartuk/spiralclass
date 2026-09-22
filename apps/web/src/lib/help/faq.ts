// The FAQPage structured data for the public help centre.
//
// It used to be built from each doc's TITLE and SUMMARY — four entries, none
// of which was a question and none of which answered one. schema.org's
// `Question`/`acceptedAnswer` pair is a claim about the page's content, so a
// heading pretending to be a question is a wrong claim, not merely a weak one.
//
// The docs already contain real questions: every Questions and Troubleshooting
// section is written as `**How do students find me?** Share your public
// booking page…`. Those are what goes in the markup, extracted from the same
// bodies the page renders, so the structured data cannot describe a page the
// visitor does not get.

import type { HelpGuide } from "./guides";
import { parseHelpQa, stripMarkdown } from "./markdown";

export interface HelpFaqItem {
  question: string;
  answer: string;
}

// Google's guidance is that an FAQPage lists questions. A troubleshooting lead
// ("A student cannot book.") is a symptom, and useful on the page, but it is
// not one — so it stays out of the markup while staying in the search index.
function isQuestion(text: string): boolean {
  return text.trimEnd().endsWith("?") || text.trimEnd().endsWith("？");
}

/**
 * Every genuine question/answer pair across the given guides, de-duplicated by
 * question. Order follows the page.
 */
export function collectHelpFaq(guides: readonly HelpGuide[]): HelpFaqItem[] {
  const seen = new Set<string>();
  const items: HelpFaqItem[] = [];

  for (const guide of guides) {
    for (const qa of guide.sections.flatMap((section) => parseHelpQa(section.body))) {
      if (!isQuestion(qa.question)) continue;
      const key = qa.question.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ question: qa.question, answer: stripMarkdown(qa.answer) });
    }
  }

  return items;
}
