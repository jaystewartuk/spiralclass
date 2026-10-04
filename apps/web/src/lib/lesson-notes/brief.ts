import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { InsightCategory } from "@prisma/client";
import { anthropicApiKey } from "@/lib/env";
import type { StudentProfile } from "./profile";

// AI pre-class brief — Phase F (the Phase F design,
// D-19). Closes the loop: turns the student's StudentLearningProfile (what E
// validated) into a short prep for the NEXT lesson — what to focus on and ≤3
// suggested cues the teacher can stage into the live notes. Read-only over the
// profile; mirrors insights.ts (pure prompt + forced-tool structured output +
// degrade-gracefully). Teacher-only, Pro-gated upstream.

// Haiku (D-87 — cost). Safe here because this is a short (max_tokens 1024),
// structured forced-tool call that passes NO `output_config.effort` — `effort`
// 400s on pre-4.6 models including Haiku 4.5, which is why the effort-passing
// class-content compose path stayed on Sonnet 5. Adding `effort` here requires
// moving this constant to an effort-capable model in the same change.
// Hardcoded: ANTHROPIC_MODEL does NOT override this.
export const BRIEF_MODEL = "claude-haiku-4-5";

// Keep it a ~15-second read: at most three suggested cues.
export const MAX_BRIEF_FOCUS = 3;

const CATEGORIES = ["pronunciation", "grammar", "vocabulary", "fluency", "comprehension"] as const;

export type BriefInput = {
  studentName: string;
  language: string; // BCP-47 target language
  profile: StudentProfile;
  // The language the brief is written in — the teacher's reading language, as
  // an English name ("French"); see localeEnglishName(). Not `language`, which
  // is the subject the student is learning.
  outputLanguage: string;
};

export type BriefFocus = {
  skill: string;
  category: InsightCategory;
  why: string;
  suggestedCue: string; // plain text destined for a LessonNote.body
};

export type Brief = {
  summary: string;
  focus: BriefFocus[];
  vocabulary: string[];
};

export class BriefUnavailableError extends Error {}

// A flattened profile row for the prompt digest.
type FlatSkill = {
  category: InsightCategory;
  skill: string;
  recurrenceCount: number;
  trend: "focus" | "improving" | "new";
  lastEvidence: string | null;
};

function flatten(profile: StudentProfile): FlatSkill[] {
  const rows: FlatSkill[] = [];
  for (const [category, skills] of Object.entries(profile.byCategory)) {
    for (const [skill, entry] of Object.entries(skills)) {
      rows.push({
        category: category as InsightCategory,
        skill,
        recurrenceCount: entry.recurrenceCount,
        trend: entry.trend,
        lastEvidence: entry.lastEvidence,
      });
    }
  }
  return rows;
}

// Is there anything in the profile worth briefing on? (Used to skip empty briefs.)
export function profileHasSignal(profile: StudentProfile): boolean {
  return flatten(profile).length > 0 || profile.vocabulary.length > 0;
}

// ---------------------------------------------------------------------------
// Prompt (pure — unit-tested). One English prompt that names the language to
// write in: there were an English and a Spanish copy chosen by a boolean, so a
// teacher reading French was briefed in Spanish.
// ---------------------------------------------------------------------------
export function buildBriefPrompt(input: BriefInput): { system: string; user: string } {
  const flat = flatten(input.profile);
  // focus + new are actionable; improving is encouragement only (never nag).
  const trendRank = { focus: 0, new: 1, improving: 2 } as const;
  const actionable = flat
    .filter((r) => r.trend !== "improving")
    .sort(
      (a, b) => trendRank[a.trend] - trendRank[b.trend] || b.recurrenceCount - a.recurrenceCount,
    );
  const improving = flat.filter((r) => r.trend === "improving");

  const system = [
    "You are a language-teaching assistant preparing a one-to-one teacher for her NEXT lesson with a single student.",
    "From the student's learning profile below, write a brief, practical prep: a one-line summary, the few things most worth focusing on, and at most three concrete cues the teacher can use in class.",
    `Write every string in ${input.outputLanguage}. Skill names, example words and phrases in the language being learned stay as they are.`,
    "Hard rules you must follow:",
    "- Use ONLY the profile provided. Never invent a weakness that isn't there. If the profile is thin, return little.",
    "- Lead with 'focus' skills (recurring and recent). 'new' skills may follow. NEVER nag about 'improving' skills — at most mention them as encouragement in the summary.",
    '- At most three suggested cues. Each cue is a short teacher-voice imperative ready to paste into class notes, e.g. "Drill ser vs estar with a photo prompt".',
    "- Each focus item names the skill, says briefly WHY (recurrence/recency from the profile), and gives one cue.",
    "Return your brief only through the emit_brief tool.",
  ].join("\n");

  const focusLines = actionable.length
    ? actionable
        .map(
          (r) =>
            `- ${r.skill} (${r.category}, ${r.trend}, seen ${r.recurrenceCount}×)${r.lastEvidence ? `: "${r.lastEvidence}"` : ""}`,
        )
        .join("\n")
    : "(none)";
  const improvingLine = improving.length ? improving.map((r) => r.skill).join(", ") : "(none)";
  const vocabLine = input.profile.vocabulary.length
    ? input.profile.vocabulary.map((v) => v.term).join(", ")
    : "(none)";

  const user = `Student: ${input.studentName}. Target language: ${input.language}.\n\nFocus areas (recurring/recent — base your cues on these):\n${focusLines}\n\nImproving (mention only as encouragement, do NOT cue):\n${improvingLine}\n\nVocabulary to revisit:\n${vocabLine}\n\nWrite the prep brief in ${input.outputLanguage}.`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// Structured output: a forced tool call, validated server-side.
// ---------------------------------------------------------------------------
export const BRIEF_TOOL: Anthropic.Tool = {
  name: "emit_brief",
  description:
    "Emit the pre-class brief. Use only the student's learning profile; never invent a weakness.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One-line prep summary, in the teacher's language." },
      focus: {
        type: "array",
        items: {
          type: "object",
          properties: {
            skill: { type: "string" },
            category: { type: "string", enum: [...CATEGORIES] },
            why: {
              type: "string",
              description: "Brief reason from the profile (recurrence/recency).",
            },
            suggestedCue: {
              type: "string",
              description: "A short teacher-voice cue to paste into class notes.",
            },
          },
          required: ["skill", "category", "suggestedCue"],
        },
      },
      vocabulary: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "focus"],
  },
};

const focusSchema = z.object({
  skill: z.string().trim().min(1),
  category: z.enum(CATEGORIES),
  why: z.string().trim().min(1).nullish(),
  suggestedCue: z.string().trim().min(1),
});

// Validate the model's tool input into a clean Brief. Drops malformed focus
// items, caps the cue count, and keeps the vocabulary list bounded.
export function parseBriefToolInput(raw: unknown): Brief {
  const obj = (raw ?? {}) as { summary?: unknown; focus?: unknown; vocabulary?: unknown };
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";

  const focus: BriefFocus[] = [];
  if (Array.isArray(obj.focus)) {
    for (const item of obj.focus) {
      const parsed = focusSchema.safeParse(item);
      if (!parsed.success) continue;
      focus.push({
        skill: parsed.data.skill,
        category: parsed.data.category,
        why: parsed.data.why ?? "",
        suggestedCue: parsed.data.suggestedCue,
      });
      if (focus.length >= MAX_BRIEF_FOCUS) break;
    }
  }

  const vocabulary = Array.isArray(obj.vocabulary)
    ? obj.vocabulary
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .slice(0, 12)
    : [];

  return { summary, focus, vocabulary };
}

// Generate the brief via Claude with a forced tool call. Throws
// BriefUnavailableError when no key is configured; lets SDK errors propagate.
export async function generateBrief(input: BriefInput): Promise<{ brief: Brief; model: string }> {
  const apiKey = anthropicApiKey();
  if (!apiKey) throw new BriefUnavailableError("ANTHROPIC_API_KEY not configured");

  const client = new Anthropic({ apiKey });
  const { system, user } = buildBriefPrompt(input);

  const response = await client.messages.create({
    model: BRIEF_MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: user }],
    tools: [BRIEF_TOOL],
    tool_choice: { type: "tool", name: BRIEF_TOOL.name },
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === BRIEF_TOOL.name,
  );
  return {
    brief: toolUse
      ? parseBriefToolInput(toolUse.input)
      : { summary: "", focus: [], vocabulary: [] },
    model: response.model,
  };
}
