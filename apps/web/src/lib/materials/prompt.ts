// AI compose prompt builder for materials (D-17 Phase 2, generalized by the
// ClassContent/LibraryMaterial merge — D-69, docs/features/library-materials.md).
//
// Pure + side-effect-free so it's unit-testable without the Anthropic SDK. One
// builder now serves both outputs ("one AI plumbing, two outputs"):
//   * forClass: true  — a single class's content, seeded with the student's
//     level/interests/goals and what's already been covered (context an
//     external chatbot can't see).
//   * forClass: false — a standalone reusable library item, seeded by a level
//     and the teacher's own category/format/theme taxonomy instead of one
//     student's profile.
// Both accept an optional lesson template (D-46): when present, its section
// headings become the required structure regardless of scope.

import {
  CALLOUT_VARIANTS,
  DEFAULT_LESSON_FORMAT,
  DEFAULT_MATERIAL_VOCABULARY,
  usesEnglishCopy,
} from "@spiralclass/shared";
import type {
  LessonFormat,
  MaterialLearnerAge,
  MaterialTone,
  MaterialVocabulary,
} from "@spiralclass/shared";

import type { AppLocale } from "@/lib/i18n";

// Lesson format (D-88) — the platform is one-to-one only today (a `Booking`
// has exactly one `studentId`; there is no multi-student booking concept
// anywhere in the schema), so this directive is ALWAYS emitted, unlike the
// D-78 style directives above which are opt-in. It is a switch on a typed
// enum (`LessonFormat`, `@spiralclass/shared`) rather than a bare string so
// that group-class support later is additive: add a "group" value to
// `LESSON_FORMATS` and a case here, without touching any call site. Exported
// so `podcast-prompt.ts` — a sibling prompt builder, not a caller of
// `buildMaterialPrompt` — asserts the identical constraint rather than
// re-deriving its own wording.
export function lessonFormatDirective(format: LessonFormat | null | undefined): string {
  switch (format ?? DEFAULT_LESSON_FORMAT) {
    case "one_to_one":
    default:
      return `This is a private ONE-TO-ONE lesson: exactly one teacher and one student, no one else present. Every activity must work for exactly two people. NEVER include pair work, group work, team activities, group discussions, classroom management instructions (e.g. "divide students into groups," "have each team present," "walk around the room and ask classmates"), or any game, competition, or exercise that needs more than one student. Do not refer to "the class," "students," or "everyone" as a plural audience — address the single student directly, or say "the student." If an activity would naturally be a group activity (a debate, a multi-character role-play, a team quiz, a classroom game), rewrite it as a one-to-one equivalent instead of dropping it: e.g. a group debate becomes the teacher and student arguing opposite sides and then switching; a multi-character role-play becomes the teacher and student each voicing one role; a team quiz becomes a teacher-vs-student or turn-based quiz; an "ask your classmates" activity becomes a back-and-forth exchange between the teacher and the student.`;
  }
}

// AI material style directives (teacher account-level, D-78). Each returns "" when
// its field is unset, so `.filter(Boolean)` on the system array drops it and the
// prompt is byte-identical to before the teacher opted in. These tune HOW the
// model writes; they are appended AFTER the language-axis, structure, and
// student-name rules and are worded to stay subordinate to them.
function toneDirective(tone: MaterialTone | null | undefined): string {
  switch (tone) {
    case "casual":
      return `Write in a warm, casual, conversational register — like a friendly teacher chatting with the student, not a textbook. Use everyday language and contractions, keep explanations light and concrete, and avoid stiff or academic phrasing.`;
    case "friendly":
      return `Write in a friendly, approachable register: clear, warm, and encouraging, plain-spoken but not slangy.`;
    case "neutral":
      return `Write in a neutral, plain register — neither especially casual nor formal.`;
    case "academic":
      return `Write in a formal, academic register: precise terminology and full, well-structured explanations.`;
    default:
      return "";
  }
}

function learnerAgeDirective(age: MaterialLearnerAge | null | undefined): string {
  switch (age) {
    case "kids":
      return `The learners are children: keep sentences short and lively, use simple concrete vocabulary and familiar examples, and make instructions very clear.`;
    case "teens":
      return `The learners are teenagers: pitch the tone and examples to their interests and keep it engaging without being childish.`;
    case "adults":
      return `The learners are adults: use relevant, real-world examples and respect their maturity — no childish framing.`;
    default:
      return "";
  }
}

function languageVarietyDirective(
  variety: string | null | undefined,
  target: string | undefined,
): string {
  const v = variety?.trim();
  if (!v) return "";
  const subject = target || "the target language";
  return `Use the ${v} variety of ${subject}: prefer its vocabulary, spelling, and cultural references.`;
}

function customInstructionsDirective(custom: string | null | undefined): string {
  const c = custom?.trim();
  if (!c) return "";
  // Explicitly subordinate to the rules above so a stray instruction can't
  // reintroduce the language-vs-subject or student-name bugs those rules fix.
  return `The teacher has additional style instructions that apply to all their materials. Follow them as fully as you can, but only where they do not conflict with the rules above about which language(s) to write in, the required structure, or the student's name — those rules always take priority. The instructions: "${c}"`;
}

// Vocabulary difficulty directive (D-80) — the axis the CEFR level no longer
// controls. Always emitted (unlike the D-78 style directives): the whole point
// of the feature is that the DEFAULT is accessible vocabulary, so a null
// preference resolves to the everyday baseline rather than "no directive".
// This governs ONLY word choice (frequency, idioms, uncommon synonyms,
// technical/literary terms) — grammar, structure, and concept difficulty stay
// pinned to the CEFR level directive above it.
function vocabularyDirective(vocab: MaterialVocabulary | null | undefined): string {
  switch (vocab ?? DEFAULT_MATERIAL_VOCABULARY) {
    case "basic":
      return `Vocabulary difficulty: BASIC. Use only the most common, high-frequency words. Avoid uncommon synonyms, idioms, and literary, technical, academic, or regional expressions — even at a high language level, keep the words familiar so the teacher and student both understand them. The ONE exception is a word that is itself the vocabulary item being taught; introduce and gloss it, but do not reach for rare words anywhere else. Keep the grammar and concepts at the specified level, but express them with accessible vocabulary.`;
    case "everyday":
      return `Vocabulary difficulty: EVERYDAY. Use normal, everyday conversational vocabulary. You may use common set phrases, but avoid obscure or rare words, heavy idioms, and literary, technical, or academic jargon unless a word is the specific item being taught. Prioritize comprehension over lexical variety.`;
    case "advanced":
      return `Vocabulary difficulty: ADVANCED. You may use higher-level vocabulary and more complex expressions — less frequent words, some idioms, and richer phrasing — where they fit the content naturally. Keep it purposeful rather than obscure for its own sake.`;
    case "native":
      return `Vocabulary difficulty: NATIVE / EXPERT. Use rich, native-level vocabulary freely: rare words, idioms, and literary, academic, and regional expressions are all welcome where they suit the material. Do not simplify word choice.`;
    default:
      return "";
  }
}

export type MaterialPromptInput = {
  // What the material/class should be about (free text). Optional once a
  // format or focus tag carries the intent — the caller guarantees at least
  // one of topic / formatLabel / focusLabels is present (plus, for a class,
  // the student's profile alone can carry it).
  topic: string;
  // The relevant level (e.g. "A2", "Grade 7"), if any.
  levelLabel?: string | null;
  // The chosen "format" tag (e.g. "Lectura", "Kahoot", "Canción") — when
  // present, this is the deliverable SHAPE the model must produce, not just
  // another topic to mention.
  formatLabel?: string | null;
  // The remaining selected tags (grammar/vocabulary/skill/activity/theme) —
  // the structured "what to work on."
  focusLabels?: string[];
  // Booking-scoped only: the student's durable interests/hobbies, so the
  // model personalizes examples.
  interests?: string | null;
  // Booking-scoped only: what the student is working toward, so the model
  // aims the lesson.
  goals?: string | null;
  // Booking-scoped only: the name of the student this class is for. Supplied so
  // the model has the ONE correct name to use whenever the material (or the
  // teacher's template) calls for a student name — and, just as importantly, so
  // it never invents one or copies a stray example name that happens to sit in
  // the template/interests/goals free text. That literal-name leak was a real
  // bug: a template header like "Estudiante: <example name>" was reproduced
  // verbatim, printing another student's name at the top of this student's
  // content. Null when unknown, which the prompt states outright.
  studentName?: string | null;
  // Booking-scoped only: titles of library items already assigned/covered for
  // this student, so the model builds on them instead of repeating.
  coveredTitles?: string[];
  // Booking-scoped only, opt-in (lesson continuity): the full body of one or
  // more previous classes' materials the teacher explicitly picked as "continue
  // from". Unlike coveredTitles (titles only, drawn from the notebook), this
  // carries the actual previous content so the model can reinforce specific
  // points, avoid repeating what was already spelled out, and pick up the
  // thread where it left off — the context an external chatbot can't see.
  // Empty/absent = no continuation requested, byte-identical to today's output.
  continueFromMaterials?: { label: string; body: string }[];
  // The teacher's own lesson template — a Markdown section skeleton she
  // authored. When present, it is the STRUCTURE the generated material must
  // follow: the model keeps these headings, in this order, and fills each for
  // the target, instead of the default shape. Teacher-owned data, never a
  // platform curriculum (D-46). Length-bounded by the caller.
  templateBody?: string | null;
  // true = generating one specific class's content (booking-scoped);
  // false = a standalone reusable library material. Drives the framing and
  // which of interests/goals/coveredTitles are meaningful.
  forClass: boolean;
  // Output language — follows the target's locale.
  locale: AppLocale;
  // The language the material is WRITTEN IN (e.g. "French", "Japanese") — a
  // teacher whose UI is Spanish may still want the document itself in another
  // language. When set it overrides the locale-derived default; the instructions
  // themselves still read in whatever language they're written.
  //
  // This is ONLY the output language. It is emphatically not the subject — see
  // targetLanguage. The two used to be conflated in this one field, which is why
  // every generation drifted toward a language lesson: a language name was the
  // only concrete noun the model had to reason from.
  language?: string | null;
  // The language being TAUGHT — the subject (D-72). An English language name
  // resolved from the teacher's `target_language` code via `languageName()`.
  // Null when she hasn't picked one, which the prompt states outright rather
  // than leaving the model to infer a subject from the output language (the
  // original bug: a language name was the only concrete noun in the prompt).
  targetLanguage?: string | null;
  // AI material style (teacher account-level, D-78). All optional; unset =
  // no directive, so today's output is unchanged. Read once by
  // handlers.ts#resolveSubject and applied to every generation path.
  tone?: MaterialTone | null;
  learnerAge?: MaterialLearnerAge | null;
  languageVariety?: string | null;
  customInstructions?: string | null;
  // Vocabulary difficulty (D-80) — a separate axis from `levelLabel`. Controls
  // word frequency / idioms / uncommon synonyms / technical terms only; the
  // CEFR level still drives grammar, structure, and concepts. The caller
  // resolves the effective value (class override ?? teacher default ?? everyday)
  // via resolveVocabulary; null here falls back to the everyday baseline inside
  // the directive, so the default output uses accessible vocabulary.
  vocabulary?: MaterialVocabulary | null;
  // Lesson format (D-88). `undefined`/`null` resolves to `DEFAULT_LESSON_FORMAT`
  // ("one_to_one") inside `lessonFormatDirective` — there is no caller today
  // that would pass anything else, since the platform has no group-class
  // concept yet. Present so a future caller can pass a resolved teacher/class
  // setting without changing this type.
  lessonFormat?: LessonFormat | null;
};

export type MaterialPrompt = { system: string; user: string };

// Build the system + user prompt for a single material generation. Output is
// Markdown (the canonical material format); the model is told to return
// content only, no preamble, no surrounding code fence.
export function buildMaterialPrompt(input: MaterialPromptInput): MaterialPrompt {
  const en = usesEnglishCopy(input.locale);
  // An explicit output language wins; otherwise fall back to the UI locale. The
  // fallback must be a plain registry name ("Spanish", not "Mexican Spanish
  // (es-MX)") because it is compared against targetLanguage below — a regional
  // qualifier here would read as a different language and wrongly split the
  // output.
  const language = input.language?.trim() || (en ? "English" : "Spanish");
  const templateBody = input.templateBody?.trim();
  const format = input.formatLabel?.trim();
  const target = input.targetLanguage?.trim();
  const studentName = input.studentName?.trim();
  const what = input.forClass ? "lesson content" : "material";
  // Target vs output language: an A1 French course scaffolded in Spanish is when
  // the two axes split apart mid-document. Compared as resolved names because
  // both now come from one registry — no string-similarity guessing.
  const teachesOtherLanguage = Boolean(target && target !== language);

  const system = [
    input.forClass
      ? `You are an assistant that helps a private teacher prepare the written content for one class.`
      : `You are an assistant that helps a private teacher draft a reusable teaching material — something saved once and used across many classes, not written for a single lesson.`,
    // One-to-one constraint (D-88) — foundational context, right after the
    // opening framing and before the subject, so it governs every activity
    // the model writes below rather than being a late caveat.
    lessonFormatDirective(input.lessonFormat),
    // The subject, before anything else. Without it the only concrete noun in
    // this prompt is the output language, and the model mistakes that for the
    // subject — which is how a French teacher used to get a Spanish lesson.
    target
      ? `The teacher teaches ${target}. Everything you produce must be ${target} teaching material: this is a ${target} lesson, and ${target} is the language the student is learning.`
      : `The language being taught is not specified: infer it from the topic and focus below rather than assuming it is the same language you are writing in.`,
    teachesOtherLanguage
      ? // Instructions in the student's language, target-language content in the
        // target language — what a language teacher means by "in Spanish".
        `Write your instructions, explanations, and any rubric in ${language}, but the ${target} itself — examples, texts, dialogue, and exercise items — must be in ${target}.`
      : `Write the ${what} in ${language}, regardless of the language of these instructions.`,
    `Return well-structured Markdown only: headings, short paragraphs, bullet or numbered lists, and simple tables where useful.`,
    // Semantic callouts (the material-rendering redesign). The renderer turns a
    // blockquote whose first line is a `[!variant]` marker into a distinct,
    // colour-coded box (icon + label) on every surface — PDF, web, mobile, the
    // in-call viewer — so a vocabulary list, a grammar note, a worked example,
    // and the answer key are each instantly recognisable instead of undifferentiated
    // prose. Use them where they FIT NATURALLY; keep the main teaching flow as
    // ordinary prose and lists. The marker set is the shared CALLOUT_VARIANTS, so
    // the wording here can't drift from what the parser accepts.
    `For special blocks, use GitHub-style callouts: a blockquote whose first line is a marker "> [!variant]" optionally followed by a short title, then the body on following "> " lines. Example:\n> [!vocabulary] Key words\n> - la casa — the house\n> - el perro — the dog\nThe available variants are: ${CALLOUT_VARIANTS.join(", ")}. Use them where they help: [!vocabulary] for word lists, [!grammar] for a grammar point, [!example] for a worked example, [!exercise] for a practice task, [!tip] for a study tip, [!important]/[!warning] for things not to get wrong, [!remember] for a key rule to memorise, [!summary] for a recap, and [!homework] for homework. When you write practice questions with a solution, put each solution in an [!answer] callout so the answer key can be hidden during the lesson. Do not overuse callouts — a document that is all boxes is as hard to read as one with none.`,
    `Do NOT include HTML, front matter, or a surrounding code fence. Do not add a preamble like "Here is" — start directly with the content.`,
    // The teacher's own template structure wins over everything else below;
    // otherwise fall back to a format-tag shape, then the plain default.
    templateBody
      ? `The teacher has provided a required lesson structure in the prompt. Follow it exactly: use those section headings, in that order, and write the content for each section — do not add, drop, or reorder sections. ${input.forClass ? "Keep it focused on a single class." : ""}`
      : format
        ? `The teacher chose the format "${format}" — produce content that actually takes that shape (e.g. a "worksheet" format means exercises with room to answer, a "reading" format means a passage followed by comprehension questions, a "quiz/game" format means a numbered list of questions with an answer key at the end). Do not just describe the format; produce it.`
        : input.forClass
          ? `Keep it focused on a single class: a clear objective, the material to cover, a few worked examples, and a short practice or homework section.`
          : `Shape the material as a self-contained, ready-to-use resource: a clear title, the content itself, and (where relevant) a short practice or answer section.`,
    // CEFR level (D-80): controls GRAMMAR complexity, sentence structures,
    // discourse complexity, and the abstractness of ideas — deliberately NOT
    // the vocabulary difficulty, which the directive below owns. This split is
    // the fix for "a high level produced words even the teacher didn't know":
    // the level no longer implies advanced words.
    input.levelLabel
      ? `The student's language level is "${input.levelLabel}". Pitch the grammar complexity, sentence structures, discourse, and abstractness of ideas to this level. This level does NOT dictate how common or rare the vocabulary is — that is set separately by the vocabulary difficulty below, so complex grammar and ideas can be expressed with familiar words.`
      : input.forClass
        ? `Student level: not set — assume an introductory grammar and concept level.`
        : `Pitch the grammar and concepts to an introductory level, since no level was specified.`,
    // Word choice, independent of the level above (D-80). Always present.
    vocabularyDirective(input.vocabulary),
    input.forClass
      ? (input.continueFromMaterials ?? []).some((m) => m.body.trim())
        ? `This class is a direct continuation of the previous class material given below (see "Continuing from"). Treat it as what the student already worked on: briefly reinforce the most important points rather than re-teaching them in full, then move forward — expand on what was introduced and/or bring in the natural next topic. Do not simply repeat that material, and do not jump to something unrelated to it.`
        : `Build on what has already been covered rather than repeating it.`
      : "",
    // Teacher's account-level style (D-78) — how to write, layered on top of
    // the subject/structure/level rules above without changing them.
    toneDirective(input.tone),
    learnerAgeDirective(input.learnerAge),
    languageVarietyDirective(input.languageVariety, target),
    // Name discipline (booking-scoped only). The prompt carries free text the
    // teacher wrote — a lesson template, interests, goals — any of which may
    // contain a concrete person's name (e.g. an example header the teacher
    // left in the template). Without this, the model reproduces that stray
    // name and prints the WRONG student at the top of the content. Pin the one
    // correct name, or forbid inventing one when it's unknown.
    input.forClass
      ? studentName
        ? `This class is for a student named ${studentName}. Whenever the content refers to the student by name — including any name field in a required lesson structure — use exactly this name and no other. Any other person's name that appears in the topic, interests, goals, or template is an example or stray value, NOT this student: never reproduce it as the student's name. Do not invent a different name.`
        : `Do not invent a name for the student, and do not copy any example name that appears in the topic, interests, goals, or template. Refer to the student generically (e.g. "the student") or leave any name field blank.`
      : "",
    // Free-text teacher instructions come LAST and are explicitly subordinate
    // to everything above (see customInstructionsDirective).
    customInstructionsDirective(input.customInstructions),
  ]
    .filter(Boolean)
    .join(" ");

  const lines: string[] = [];
  const topic = input.topic.trim();
  if (topic) lines.push(`Topic${input.forClass ? " for this class" : ""}: ${topic}`);
  if (format) lines.push(`Format: ${format}`);
  if (input.forClass) {
    lines.push(
      input.levelLabel
        ? `Student level: ${input.levelLabel}`
        : `Student level: not set — assume an introductory level.`,
    );
  }
  const focus = (input.focusLabels ?? []).map((t) => t.trim()).filter(Boolean);
  if (focus.length > 0) {
    lines.push(
      input.forClass
        ? `Focus this class on: ${focus.join("; ")}.`
        : `Also focus on: ${focus.join("; ")}.`,
    );
  }
  const goals = input.goals?.trim();
  if (goals) {
    lines.push(`The student's learning goal (aim the lesson toward it): ${goals}`);
  }
  const interests = input.interests?.trim();
  if (interests) {
    lines.push(
      `The student's interests (use them for examples, contexts, and practice prompts): ${interests}`,
    );
  }
  const covered = (input.coveredTitles ?? []).map((t) => t.trim()).filter(Boolean);
  if (covered.length > 0) {
    lines.push(
      `Already covered with this student (build on these, don't repeat): ${covered.join("; ")}.`,
    );
  }
  const continueFrom = (input.continueFromMaterials ?? []).filter((m) => m.body.trim());
  if (continueFrom.length > 0) {
    lines.push(
      continueFrom.length === 1
        ? `Continuing from this previous class material — reinforce briefly, then build forward, don't just repeat it:`
        : `Continuing from these previous class materials — reinforce briefly, then build forward, don't just repeat them:`,
    );
    continueFrom.forEach((m, i) => {
      const label = m.label.trim() || `Previous material ${i + 1}`;
      lines.push(`--- ${label} ---\n${m.body.trim()}`);
    });
  }
  if (templateBody) {
    lines.push(
      `Required lesson structure — reproduce these section headings, in this order, and fill each one for this student:\n${templateBody}`,
    );
  }
  lines.push(
    en
      ? `Write the ${input.forClass ? "class content" : "material"} now.`
      : `Escribe ahora ${input.forClass ? "el contenido de la clase" : "el material"}.`,
  );

  return { system, user: lines.join("\n") };
}

// --- "Edit with AI" refine prompt --------------------------------------------
//
// The refine counterpart to buildMaterialPrompt: instead of generating from a
// topic/format/tags, it takes an EXISTING material's Markdown body plus a
// free-text instruction ("change the date to March 5, shorten section 2") and
// asks the model to return the same document with only that change applied. This
// is what replaces hand-editing raw Markdown — the teacher never types Markdown
// syntax, and the good 95% of the document is preserved rather than gambled on a
// full regeneration. Pure + side-effect-free, same as buildMaterialPrompt.

export type MaterialRefinePromptInput = {
  // The current material, verbatim Markdown, that the change applies to.
  currentBody: string;
  // What the teacher wants changed, in their own words.
  instruction: string;
  // Output language — follows the target's locale.
  locale: AppLocale;
  // The language the material is WRITTEN IN — same axis as buildMaterialPrompt's
  // `language`. Blank → the locale default.
  language?: string | null;
  // The language being TAUGHT — the subject (D-72), resolved to its English name
  // by the caller. Null when the teacher hasn't set one.
  targetLanguage?: string | null;
  // AI material style (teacher account-level, D-78) — carried into a refine so a
  // small edit doesn't quietly regress the material back toward the default
  // academic voice. Learner age / level are generation-only and omitted here.
  tone?: MaterialTone | null;
  languageVariety?: string | null;
  customInstructions?: string | null;
  // Vocabulary difficulty (D-80) — carried into a refine so an edit doesn't
  // regress a Basic-vocabulary material back toward rarer words. Teacher-level
  // only (a refine has no booking/class context), same as tone above.
  vocabulary?: MaterialVocabulary | null;
  // Lesson format (D-88) — carried into a refine so a free-text edit can't
  // reintroduce group/pair/team activities into an already-compliant
  // material. See `MaterialPromptInput.lessonFormat`.
  lessonFormat?: LessonFormat | null;
};

export function buildMaterialRefinePrompt(input: MaterialRefinePromptInput): MaterialPrompt {
  const en = usesEnglishCopy(input.locale);
  // Mirror buildMaterialPrompt's resolution so a refine keeps the material in
  // the same language it was written in — and, for a language teacher, keeps
  // instructions and target-language content on their respective axes.
  const language = input.language?.trim() || (en ? "English" : "Spanish");
  const target = input.targetLanguage?.trim();
  const teachesOtherLanguage = Boolean(target && target !== language);

  const system = [
    `You are an assistant that helps a private teacher revise an existing teaching material written in Markdown.`,
    // One-to-one constraint (D-88) — same rule as buildMaterialPrompt, so a
    // refine can't drift the material back toward group/pair/team activities.
    lessonFormatDirective(input.lessonFormat),
    target
      ? `The teacher teaches ${target}: this is ${target} teaching material.`
      : `The language being taught is not specified: infer it from the material rather than assuming it is the same language you are writing in.`,
    teachesOtherLanguage
      ? `Keep your instructions, explanations, and any rubric in ${language}, but the ${target} itself — examples, texts, dialogue, and exercise items — in ${target}.`
      : `Keep the material written in ${language}, regardless of the language of these instructions.`,
    // The crux of a refine vs a regenerate: change only what was asked, keep
    // everything else byte-for-byte where possible.
    `Apply ONLY the change the teacher asks for. Preserve everything else exactly: do not restructure, do not re-generate from scratch, do not rewrite untouched sections, and do not change formatting you were not asked to change.`,
    `Return the FULL revised material as well-structured Markdown — the complete document, not a diff, a summary, or only the changed part.`,
    // Preserve any semantic callouts the material already uses (a blockquote
    // whose first line is a "> [!variant]" marker); keep them intact unless the
    // change is specifically about them, and you may add new ones with the same
    // syntax where a change introduces vocabulary, an example, or an answer key.
    `Preserve any existing "> [!variant]" callout blocks exactly unless the requested change is about them; you may add new callouts of the same form where appropriate.`,
    `Do NOT include HTML, front matter, or a surrounding code fence. Do not add a preamble like "Here is" — start directly with the content.`,
    // Keep the teacher's account-level voice on a refine so an edit doesn't
    // undo it — subordinate to the preservation rule above (custom last).
    toneDirective(input.tone),
    // Word choice on a refine: keep the material's vocabulary at the intended
    // difficulty rather than drifting rarer while applying the edit (D-80).
    `When applying the change, keep the material's word choice at its intended difficulty. ${vocabularyDirective(input.vocabulary)}`,
    languageVarietyDirective(input.languageVariety, target),
    customInstructionsDirective(input.customInstructions),
  ]
    .filter(Boolean)
    .join(" ");

  const user = [
    `Here is the current material:`,
    ``,
    input.currentBody,
    ``,
    `Change to make: ${input.instruction.trim()}`,
    ``,
    en ? `Return the full revised material now.` : `Devuelve ahora el material completo revisado.`,
  ].join("\n");

  return { system, user };
}
