// Deterministic checks on a model surface's output (D-201). Each check is a
// rule the prompt states or the product doc promises, turned into a function.
// No model judges another model here: these catch the output that is
// ungrounded, unbounded or off-shape, which is where a prompt or model change
// does its quiet damage. What is *good* is the teacher's call
// (lib/ai/quality-metrics.ts).
//
// A check is reported only when it applies to the case, so a pass rate means
// "of the rules this lesson gave grounds to test".

import { MAX_INSIGHTS_PER_CATEGORY, type Insight } from "@/lib/lesson-notes/insights";
import type { HomeworkAiReviewContent } from "@spiralclass/shared";
import type { HomeworkReviewCase, LessonInsightsCase } from "./cases";

export type Check = {
  id: string;
  ok: boolean;
  // Why it failed, or null on a pass.
  detail: string | null;
};

// Case-, accent-preserving, punctuation- and whitespace-insensitive. A model
// that quotes «estoy cansado.» has still quoted the student; one that quotes
// "estoy cansada" has not.
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contains(haystack: string, needle: string): boolean {
  const n = normalize(needle);
  return n.length > 0 && normalize(haystack).includes(n);
}

function result(id: string, failures: string[]): Check {
  return { id, ok: failures.length === 0, detail: failures.length ? failures.join("; ") : null };
}

function mentionChecks(
  text: string,
  expect: { mustMention?: string[]; mustNotMention?: string[] } | undefined,
): Check[] {
  const checks: Check[] = [];
  if (expect?.mustMention?.length) {
    checks.push(
      result(
        "must-mention",
        expect.mustMention.filter((m) => !contains(text, m)).map((m) => `missing "${m}"`),
      ),
    );
  }
  if (expect?.mustNotMention?.length) {
    checks.push(
      result(
        "must-not-mention",
        expect.mustNotMention.filter((m) => contains(text, m)).map((m) => `contains "${m}"`),
      ),
    );
  }
  return checks;
}

const label = (i: Insight) => `${i.category} "${i.summary}"`;

export function checkLessonInsights(c: LessonInsightsCase, output: Insight[]): Check[] {
  const { input } = c;
  const expect = c.expect;
  const students = input.utterances.filter((u) => u.speaker === "student");
  const weakWords = input.pronunciation?.weakWords ?? [];
  const teacherSignal =
    input.teacherCues.length > 0 || input.utterances.some((u) => u.speaker === "teacher");
  const checks: Check[] = [];

  // "At most three findings per category" — the parser caps this too, so a
  // failure here means the cap moved.
  const perCategory = new Map<string, number>();
  for (const i of output) perCategory.set(i.category, (perCategory.get(i.category) ?? 0) + 1);
  checks.push(
    result(
      "cap-per-category",
      [...perCategory]
        .filter(([, n]) => n > MAX_INSIGHTS_PER_CATEGORY)
        .map(([cat, n]) => `${cat}: ${n}`),
    ),
  );

  // "Every finding must cite the student's exact words as evidence."
  checks.push(result("evidence-present", output.filter((i) => !i.evidence).map(label)));

  // The cited words are the STUDENT's, and were actually said — or, with audio
  // scores, are a scored weak word. A quote lifted from the teacher's turn or
  // paraphrased is the model inventing the record it claims to cite.
  checks.push(
    result(
      "evidence-quoted",
      output
        .filter((i) => i.evidence)
        .filter(
          (i) =>
            !students.some((u) => contains(u.text, i.evidence!)) &&
            !weakWords.some((w) => contains(i.evidence!, w.word)),
        )
        .map((i) => `${label(i)} cites "${i.evidence}"`),
    ),
  );

  // "Include the atMs timestamp of that utterance (copy it from the tag)." The
  // playback bookmark lands on this, so a plausible-looking wrong number is a
  // bookmark to the wrong moment.
  checks.push(
    result(
      "timestamp-anchored",
      output
        .filter((i) => {
          if (i.atMs == null) return true;
          const onUtterance = input.utterances.some(
            (u) => u.atMs === i.atMs && (!i.evidence || contains(u.text, i.evidence)),
          );
          const onWeakWord = weakWords.some((w) => w.atMs === i.atMs);
          return !onUtterance && !onWeakWord;
        })
        .map((i) => `${label(i)} at ${i.atMs ?? "null"}`),
    ),
  );

  // The pronunciation rule flips on audio scores: with them, a finding must
  // name a scored word; without them, text cannot hear sound and only a
  // teacher signal licenses one. "Never guess pronunciation from spelling."
  const pron = output.filter((i) => i.category === "pronunciation");
  if (weakWords.length > 0) {
    checks.push(
      result(
        "pronunciation-grounded",
        pron
          .filter((i) => !weakWords.some((w) => i.evidence && contains(i.evidence, w.word)))
          .map((i) => `${label(i)} names no scored word`),
      ),
    );
  } else if (!teacherSignal) {
    checks.push(
      result(
        "pronunciation-grounded",
        pron.map((i) => `${label(i)} with no signal`),
      ),
    );
  }

  if (expect?.maxFindings != null) {
    checks.push(
      result(
        "conservative",
        output.length > expect.maxFindings
          ? [`${output.length} findings, expected at most ${expect.maxFindings}`]
          : [],
      ),
    );
  }

  if (expect?.categories) {
    const allowed = new Set<string>(expect.categories);
    checks.push(
      result("categories-allowed", output.filter((i) => !allowed.has(i.category)).map(label)),
    );
  }

  const text = output.map((i) => [i.summary, i.evidence, i.suggestion].join("\n")).join("\n");
  checks.push(...mentionChecks(text, expect));
  return checks;
}

// A span the model put in quotation marks. Only these are held to the
// submission: prose that paraphrases is allowed to.
const QUOTED = /["“«]([^"”»]{3,})["”»]/g;

const MAX_BULLETS = 6;
const MAX_BULLET_CHARS = 300;

export function checkHomeworkReview(
  c: HomeworkReviewCase,
  output: HomeworkAiReviewContent | null,
): Check[] {
  if (!output) return [{ id: "parsed", ok: false, detail: "no usable review came back" }];
  const checks: Check[] = [{ id: "parsed", ok: true, detail: null }];
  const expect = c.expect;

  // "Only emit grammarNotes when the material/assignment is clearly
  // language-focused" — a history answer does not get a grammar lecture.
  if (!c.languageFocused) {
    checks.push(
      result(
        "grammar-notes-gated",
        output.grammarNotes?.length ? [`${output.grammarNotes.length} grammar notes`] : [],
      ),
    );
  }

  // "Never invent content the student didn't write." Anything the model
  // presents as a quotation must appear in the submission or an attachment.
  const submitted = [c.input.attemptText ?? "", ...c.input.attachmentTexts.map((a) => a.text)].join(
    "\n",
  );
  const bullets = [
    ...output.corrections,
    ...output.strengths,
    ...output.weaknesses,
    ...(output.grammarNotes ?? []),
  ];
  // A correction quotes the slip and then the fix, so not every span is the
  // student's. The rule is per bullet: one that quotes must quote the
  // submission at least once.
  const invented: string[] = [];
  for (const bullet of bullets) {
    const spans = [...bullet.matchAll(QUOTED)].map((m) => m[1]!);
    if (spans.length && !spans.some((span) => contains(submitted, span))) {
      invented.push(spans.map((s) => `"${s}"`).join(", "));
    }
  }
  checks.push(result("quotes-grounded", invented));

  // "A few bullet points each, not paragraphs."
  const long = bullets.filter((b) => b.length > MAX_BULLET_CHARS).length;
  checks.push(
    result("concise", [
      ...(output.strengths.length > MAX_BULLETS ? [`${output.strengths.length} strengths`] : []),
      ...(output.weaknesses.length > MAX_BULLETS ? [`${output.weaknesses.length} weaknesses`] : []),
      ...(long ? [`${long} bullets over ${MAX_BULLET_CHARS} chars`] : []),
    ]),
  );

  if (expect?.scoreRange) {
    const [lo, hi] = expect.scoreRange;
    const s = output.suggestedScore;
    checks.push(
      result(
        "score-in-range",
        s == null ? ["no score"] : s < lo || s > hi ? [`${s} outside ${lo}–${hi}`] : [],
      ),
    );
  }

  checks.push(...mentionChecks([...bullets, output.suggestedFeedback].join("\n"), expect));
  return checks;
}
