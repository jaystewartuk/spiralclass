// Prompt builder for a material's podcast SCRIPT — the spoken, single-narrator
// monologue Claude writes from a material's Markdown `body` before ElevenLabs
// renders it to audio. Pure + side-effect-free so it's unit-testable without
// the Anthropic SDK, exactly like buildMaterialPrompt (prompt.ts).
//
// This is a DIFFERENT job from buildMaterialPrompt: that produces a written
// document (Markdown, headings, tables); this rewrites such a document as
// natural spoken prose meant to be heard, not read — no Markdown, no headings,
// no bullet lists, no speaker labels, no stage directions. It reuses the same
// output-language vs target-language split rules so a language teacher's
// podcast narrates instructions in one language and target-language example
// sentences in the language being taught.

import type { LessonFormat } from "@spiralclass/shared";

import type { AppLocale } from "@/lib/i18n";
import { lessonFormatDirective, type MaterialPrompt } from "@/lib/materials/prompt";
import { PODCAST_WORDS_PER_MINUTE } from "@/lib/materials/config";

export type PodcastPromptInput = {
  // The material's Markdown body — the source the podcast narrates. Required:
  // there's nothing to turn into audio without it.
  body: string;
  // The relevant level (e.g. "A2", "Grade 7"), if any — sets the register.
  levelLabel?: string | null;
  // The material's focus tags (grammar/vocabulary/skill/theme) — what to keep
  // front-and-center while narrating.
  focusLabels?: string[];
  // Output language the narration is spoken in (e.g. "French", "Spanish").
  // Falls back to the locale default when unset.
  language?: string | null;
  // The language being TAUGHT — the subject. When it differs from the output
  // language, target-language example sentences are spoken in the target
  // language while the surrounding narration stays in the output language.
  targetLanguage?: string | null;
  // UI locale — drives the default output language and the final instruction.
  locale: AppLocale;
  // Roughly how long the finished podcast should run, in minutes. Shapes the
  // word budget (~PODCAST_WORDS_PER_MINUTE words/min); a soft target, not a cap.
  targetDurationMin: number;
  // Lesson format (D-88) — same axis as buildMaterialPrompt's, threaded
  // through here so the narrated episode never invents pair/group/team
  // activities the source material doesn't have reason to include either.
  lessonFormat?: LessonFormat | null;
};

// Build the system + user prompt for one podcast-script generation. Output is
// plain spoken prose (NOT Markdown) — the model is told to return narration
// only, no preamble, no formatting, no code fence.
export function buildPodcastScriptPrompt(input: PodcastPromptInput): MaterialPrompt {
  const en = input.locale === "en";
  const language = input.language?.trim() || (en ? "English" : "Spanish");
  const target = input.targetLanguage?.trim();
  const teachesOtherLanguage = Boolean(target && target !== language);
  const wordBudget = Math.max(120, Math.round(input.targetDurationMin * PODCAST_WORDS_PER_MINUTE));

  const system = [
    `You are a scriptwriter turning one teacher's teaching material into a short, single-narrator educational podcast — a warm, engaging spoken monologue the student listens to, not a document they read.`,
    // One-to-one constraint (D-88) — same rule as buildMaterialPrompt: the
    // narration must never coach the listener into a group/pair/team activity.
    lessonFormatDirective(input.lessonFormat),
    target
      ? `The teacher teaches ${target}: this podcast is ${target} teaching material, and ${target} is the language the student is learning.`
      : `The language being taught is not specified: infer it from the material and focus below rather than assuming it is the same language you are narrating in.`,
    teachesOtherLanguage
      ? `Narrate in ${language}, but any ${target} the student is meant to learn — example sentences, vocabulary, dialogue — must be spoken in ${target}, exactly as it should sound aloud.`
      : `Narrate in ${language}, regardless of the language of these instructions.`,
    // The core constraint: this text is READ ALOUD by a TTS engine, so anything
    // that isn't spoken words is noise the engine will mangle.
    `This script is read aloud by a text-to-speech voice. Output ONLY the words the narrator speaks: natural, flowing spoken prose in complete sentences.`,
    `Do NOT include any Markdown, headings, bullet or numbered lists, tables, code, URLs, emoji, stage directions, sound-effect or music cues, speaker labels, or a title line. Do not describe the format — just speak the content. Spell out things that must be heard (say "number one" rather than "1.").`,
    `Open by welcoming the listener and naming what this episode covers, cover the material's key points in a logical spoken order with brief examples, and close with a short recap or send-off.`,
    `Keep it to roughly ${input.targetDurationMin} minute${input.targetDurationMin === 1 ? "" : "s"} — about ${wordBudget} words. It's better to explain a few things well than to rush everything.`,
    input.levelLabel
      ? `Pitch the vocabulary, pace, and examples to a "${input.levelLabel}" level student.`
      : `Pitch it to an introductory level, since no level was specified.`,
    `Do not add a preamble like "Here is the script" — start directly with the narrator's first spoken words.`,
  ]
    .filter(Boolean)
    .join(" ");

  const lines: string[] = [];
  const focus = (input.focusLabels ?? []).map((t) => t.trim()).filter(Boolean);
  if (focus.length > 0) {
    lines.push(`Keep the episode focused on: ${focus.join("; ")}.`);
  }
  lines.push(
    `Here is the teaching material to turn into the podcast episode:`,
    "",
    input.body.trim(),
    "",
    en ? `Write the spoken podcast script now.` : `Escribe ahora el guion hablado del podcast.`,
  );

  return { system, user: lines.join("\n") };
}
