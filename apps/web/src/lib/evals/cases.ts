// The shape of an eval case: one input to a model surface, plus what a good
// answer must and must not do (D-201). Cases are JSON files, one per case,
// under evals/cases/<surface>/ — the committed ones are synthetic. Real lesson
// material is personal data and lives outside this repository; point
// `EVAL_CASES_DIR` at it (see docs/development/testing.md, "Model evals").
//
// Expectations are deliberately the kind a function can check. Whether a
// finding is *insightful* is the teacher's verdict, read back by
// lib/ai/quality-metrics.ts; what is checked here is whether the output is
// grounded, bounded and in the shape the product promised.

import { z } from "zod";
import { INSIGHT_CATEGORIES } from "@/lib/lesson-notes/insights";

export const EVAL_SURFACES = ["lesson-insights", "homework-review"] as const;
export type EvalSurface = (typeof EVAL_SURFACES)[number];

const caseName = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case, it names the recorded-output file");

const mentions = {
  // Each must appear somewhere in the output, case- and punctuation-insensitive.
  mustMention: z.array(z.string().min(1)).optional(),
  // None may appear anywhere in the output.
  mustNotMention: z.array(z.string().min(1)).optional(),
};

const utteranceSchema = z
  .object({
    speaker: z.enum(["student", "teacher"]),
    text: z.string().min(1),
    atMs: z.number().int().nonnegative(),
  })
  .strict();

const weakWordSchema = z
  .object({
    word: z.string().min(1),
    accuracy: z.number().min(0).max(100),
    atMs: z.number().int().nonnegative(),
    phonemes: z
      .array(
        z.object({ phoneme: z.string().min(1), accuracy: z.number().min(0).max(100) }).strict(),
      )
      .optional(),
  })
  .strict();

export const lessonInsightsCaseSchema = z
  .object({
    surface: z.literal("lesson-insights"),
    name: caseName,
    // One sentence: what this case is there to catch.
    about: z.string().min(1),
    // Mirrors InsightsInput (lib/lesson-notes/insights.ts).
    input: z
      .object({
        studentName: z.string().min(1),
        targetLanguage: z.string().min(2),
        outputLanguage: z.string().min(1),
        utterances: z.array(utteranceSchema),
        teacherCues: z.array(z.object({ body: z.string().min(1), done: z.boolean() }).strict()),
        studentNotes: z.array(z.object({ body: z.string().min(1) }).strict()),
        pronunciation: z
          .object({ weakWords: z.array(weakWordSchema).min(1) })
          .strict()
          .optional(),
      })
      .strict(),
    expect: z
      .object({
        ...mentions,
        // The prompt asks for a short, sharp list; a thin lesson should yield
        // few or no findings. Checked only when set.
        maxFindings: z.number().int().nonnegative().optional(),
        // The only categories this lesson gives grounds for.
        categories: z.array(z.enum(INSIGHT_CATEGORIES)).min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const homeworkReviewCaseSchema = z
  .object({
    surface: z.literal("homework-review"),
    name: caseName,
    about: z.string().min(1),
    // Mirrors AiReviewPromptInput (lib/homework/ai-review-prompt.ts).
    input: z
      .object({
        assignmentTitle: z.string().min(1),
        assignmentInstructions: z.string().nullable(),
        materialExcerpt: z.string().nullable(),
        attemptText: z.string().nullable(),
        attachmentTexts: z.array(
          z.object({ fileName: z.string().min(1), text: z.string().min(1) }),
        ),
        teacherInstructions: z.string().nullable(),
        outputLanguage: z.string().min(1),
      })
      .strict(),
    // Whether the assignment is language practice. The prompt lets
    // grammarNotes through only then; the checker holds it to that.
    languageFocused: z.boolean(),
    expect: z
      .object({
        ...mentions,
        // Inclusive bounds on suggestedScore, which must then be present.
        scoreRange: z
          .tuple([z.number().int().min(0).max(10), z.number().int().min(0).max(10)])
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const evalCaseSchema = z.discriminatedUnion("surface", [
  lessonInsightsCaseSchema,
  homeworkReviewCaseSchema,
]);

export type LessonInsightsCase = z.infer<typeof lessonInsightsCaseSchema>;
export type HomeworkReviewCase = z.infer<typeof homeworkReviewCaseSchema>;
export type EvalCase = z.infer<typeof evalCaseSchema>;

// Parse one case file's JSON. Throws with the file name and the first problem,
// because a malformed case silently skipped is a measurement that never ran.
export function parseEvalCase(raw: unknown, source: string): EvalCase {
  const parsed = evalCaseSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const where = first?.path.length ? ` at ${first.path.join(".")}` : "";
  throw new Error(`${source}: ${first?.message ?? "invalid case"}${where}`);
}
