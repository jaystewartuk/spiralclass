"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import {
  MATERIAL_CUSTOM_INSTRUCTIONS_MAX,
  MATERIAL_LANGUAGE_VARIETY_MAX,
  type MaterialStyleSettings,
} from "@spiralclass/shared";
import type { StringKey } from "@/lib/i18n-translate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CharacterCounter } from "@/components/ui/character-counter";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormStatus } from "@/components/ui/form-status";
import { useT } from "@/components/locale-provider";
import { saveMaterialStyleAction, type ProfileState } from "@/app/actions/profile";
import { SegmentedControl } from "./segmented-control";

// AI material style editor (D-78, plus D-80's vocabulary dial).
//
// The page's job is to make an abstract preference concrete, so every dial
// carries a live effect line paraphrasing the directive the prompt builder
// actually sends (lib/materials/prompt.ts). Picking "Casual" says what casual
// will read like, instead of leaving the teacher to find out one generated
// material at a time.
//
// "" is unset for tone, learner age and both text fields: the column stays null
// and the prompt gets no directive, so output is byte-identical to never having
// opted in. Vocabulary is the exception — see VOCAB_FALLBACK.

/** What a null `vocabulary` resolves to at generation time (D-80). */
const VOCAB_FALLBACK = "everyday";

type StyleOption = { value: string; labelKey: StringKey; effectKey: StringKey };

const TONE_OPTIONS: readonly StyleOption[] = [
  {
    value: "",
    labelKey: "web.settings.materialStyle.tone.auto",
    effectKey: "web.settings.materialStyle.tone.effect.auto",
  },
  {
    value: "casual",
    labelKey: "web.settings.materialStyle.tone.casual",
    effectKey: "web.settings.materialStyle.tone.effect.casual",
  },
  {
    value: "friendly",
    labelKey: "web.settings.materialStyle.tone.friendly",
    effectKey: "web.settings.materialStyle.tone.effect.friendly",
  },
  {
    value: "neutral",
    labelKey: "web.settings.materialStyle.tone.neutral",
    effectKey: "web.settings.materialStyle.tone.effect.neutral",
  },
  {
    value: "academic",
    labelKey: "web.settings.materialStyle.tone.academic",
    effectKey: "web.settings.materialStyle.tone.effect.academic",
  },
];

const AGE_OPTIONS: readonly StyleOption[] = [
  {
    value: "",
    labelKey: "web.settings.materialStyle.age.auto",
    effectKey: "web.settings.materialStyle.age.effect.auto",
  },
  {
    value: "kids",
    labelKey: "web.settings.materialStyle.age.kids",
    effectKey: "web.settings.materialStyle.age.effect.kids",
  },
  {
    value: "teens",
    labelKey: "web.settings.materialStyle.age.teens",
    effectKey: "web.settings.materialStyle.age.effect.teens",
  },
  {
    value: "adults",
    labelKey: "web.settings.materialStyle.age.adults",
    effectKey: "web.settings.materialStyle.age.effect.adults",
  },
];

// No "automatic" option, because there is no automatic: a null vocabulary
// resolves to `everyday` during generation (D-80 — that directive is always
// emitted, unlike the D-78 ones). Offering "Default" and "Everyday" as two
// answers to the same question would be a distinction the teacher cannot act
// on. So the control SHOWS everyday while the column is still null and posts ""
// until she picks — an untouched row keeps following the global default if it
// ever moves.
const VOCAB_OPTIONS: readonly StyleOption[] = [
  {
    value: "basic",
    labelKey: "web.settings.materialStyle.vocab.basic",
    effectKey: "web.settings.materialStyle.vocab.effect.basic",
  },
  {
    value: "everyday",
    labelKey: "web.settings.materialStyle.vocab.everyday",
    effectKey: "web.settings.materialStyle.vocab.effect.everyday",
  },
  {
    value: "advanced",
    labelKey: "web.settings.materialStyle.vocab.advanced",
    effectKey: "web.settings.materialStyle.vocab.effect.advanced",
  },
  {
    value: "native",
    labelKey: "web.settings.materialStyle.vocab.native",
    effectKey: "web.settings.materialStyle.vocab.effect.native",
  },
];

function effectKeyFor(options: readonly StyleOption[], value: string): StringKey {
  return (options.find((o) => o.value === value) ?? options[0]!).effectKey;
}

type Draft = {
  tone: string;
  learnerAge: string;
  vocabulary: string;
  languageVariety: string;
  customInstructions: string;
};

function draftOf(settings: MaterialStyleSettings): Draft {
  return {
    tone: settings.tone ?? "",
    learnerAge: settings.learnerAge ?? "",
    vocabulary: settings.vocabulary ?? "",
    languageVariety: settings.languageVariety ?? "",
    customInstructions: settings.customInstructions ?? "",
  };
}

/** What the server will store for this draft — free text is trimmed on save. */
function normalized(draft: Draft): Draft {
  return {
    ...draft,
    languageVariety: draft.languageVariety.trim(),
    customInstructions: draft.customInstructions.trim(),
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.tone === b.tone &&
    a.learnerAge === b.learnerAge &&
    a.vocabulary === b.vocabulary &&
    a.languageVariety === b.languageVariety &&
    a.customInstructions === b.customInstructions
  );
}

export function MaterialStyleForm({
  initial,
  /** The teacher's own subject, so the variety question can name it. */
  targetLanguageLabel,
}: {
  initial: MaterialStyleSettings;
  targetLanguageLabel: string | null;
}) {
  const t = useT();
  const ids = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  // What is on the server. Seeded from the row and re-seeded from the draft on
  // a successful save, so "unsaved changes" is answered by this component
  // rather than by whether the RSC refresh has landed yet.
  const [saved, setSaved] = useState<Draft>(() => normalized(draftOf(initial)));
  const [state, formAction, pending] = useActionState<ProfileState, FormData>(
    saveMaterialStyleAction,
    undefined,
  );

  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (!state?.ok || state.error) return;
    // The action trims; mirror that into the fields so a trailing space the
    // teacher typed doesn't leave the form looking dirty the moment it saves.
    const stored = normalized(draftRef.current);
    setSaved(stored);
    setDraft(stored);
  }, [state]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const dirty = !sameDraft(normalized(draft), saved);

  const varietyHint = targetLanguageLabel
    ? t("web.settings.materialStyle.variety.hintFor", { language: targetLanguageLabel })
    : t("web.settings.materialStyle.variety.hint");

  const dial = (
    key: "tone" | "learnerAge" | "vocabulary",
    options: readonly StyleOption[],
    labelKey: StringKey,
    shown: string,
    formValue?: string,
  ) => (
    <div className="space-y-2.5">
      <span id={`${ids}-${key}`} className="block text-sm font-medium">
        {t(labelKey)}
      </span>
      <SegmentedControl
        name={key}
        value={shown}
        formValue={formValue}
        onChange={(value) => set(key, value)}
        options={options.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
        labelledBy={`${ids}-${key}`}
        describedBy={`${ids}-${key}-effect`}
      />
      <p id={`${ids}-${key}-effect`} className="text-muted-foreground text-sm">
        {t(effectKeyFor(options, shown))}
      </p>
    </div>
  );

  return (
    <form action={formAction} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-lg">
            {t("web.settings.materialStyle.cardTitle")}
          </CardTitle>
          <CardDescription>{t("web.settings.materialStyle.cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="divide-border divide-y">
          <div className="pb-6">
            {dial("tone", TONE_OPTIONS, "web.settings.materialStyle.tone.label", draft.tone)}
          </div>
          <div className="py-6">
            {dial(
              "learnerAge",
              AGE_OPTIONS,
              "web.settings.materialStyle.age.label",
              draft.learnerAge,
            )}
          </div>
          <div className="space-y-2.5 pt-6">
            {dial(
              "vocabulary",
              VOCAB_OPTIONS,
              "web.settings.materialStyle.vocab.label",
              draft.vocabulary || VOCAB_FALLBACK,
              draft.vocabulary,
            )}
            {/* The one dial whose meaning isn't obvious from its options: it is
                deliberately NOT the CEFR level, and a per-class choice beats
                it. Said once, below, rather than inside the effect line that
                changes with every click. */}
            <p className="text-subtle text-sm">{t("web.settings.materialStyle.vocab.hint")}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-lg">
            {t("web.settings.materialStyle.words.title")}
          </CardTitle>
          <CardDescription>{t("web.settings.materialStyle.words.description")}</CardDescription>
        </CardHeader>
        <CardContent className="divide-border divide-y">
          <div className="space-y-2.5 pb-6">
            <label htmlFor="languageVariety" className="block text-sm font-medium">
              {t("web.settings.materialStyle.variety.label")}
            </label>
            <Input
              id="languageVariety"
              name="languageVariety"
              value={draft.languageVariety}
              onChange={(e) => set("languageVariety", e.target.value)}
              maxLength={MATERIAL_LANGUAGE_VARIETY_MAX}
              placeholder={t("web.settings.materialStyle.variety.placeholder")}
              aria-describedby={`${ids}-variety-hint`}
            />
            <p id={`${ids}-variety-hint`} className="text-muted-foreground text-sm">
              {varietyHint}
            </p>
          </div>

          <div className="space-y-2.5 pt-6">
            <label htmlFor="customInstructions" className="block text-sm font-medium">
              {t("web.settings.materialStyle.custom.label")}
            </label>
            <Textarea
              id="customInstructions"
              name="customInstructions"
              value={draft.customInstructions}
              onChange={(e) => set("customInstructions", e.target.value)}
              maxLength={MATERIAL_CUSTOM_INSTRUCTIONS_MAX}
              rows={4}
              placeholder={t("web.settings.materialStyle.custom.placeholder")}
              aria-describedby={`${ids}-custom-hint ${ids}-custom-count`}
            />
            <div className="flex items-start justify-between gap-3">
              <p id={`${ids}-custom-hint`} className="text-muted-foreground text-sm">
                {t("web.settings.materialStyle.custom.hint")}
              </p>
              <CharacterCounter
                id={`${ids}-custom-count`}
                length={draft.customInstructions.length}
                max={MATERIAL_CUSTOM_INSTRUCTIONS_MAX}
                className="shrink-0"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* The save row sticks to the bottom of the viewport, the same idiom the
          class-content editor uses: this form is taller than a phone screen, so
          a Save button in flow sat below the fold of the last question. Sticky
          keeps its flow space, so nothing needs extra padding; z-30 is under the
          app nav (z-40) and Radix portals (z-50). */}
      <div className="border-border/60 bg-background/95 pb-safe-bottom supports-[backdrop-filter]:bg-background/80 sticky bottom-0 z-30 flex flex-wrap items-center justify-between gap-3 border-t py-3 backdrop-blur">
        <div className="min-w-0 flex-1">
          {dirty ? (
            <p className="text-warning text-sm" aria-live="polite">
              {t("web.settings.materialStyle.unsaved")}
            </p>
          ) : (
            <FormStatus state={state} savedMessage={t("web.settings.materialStyle.savedMessage")} />
          )}
          {dirty && state?.error ? <p className="text-destructive text-sm">{state.error}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {dirty ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setDraft(saved)}
              disabled={pending}
            >
              {t("common.discard")}
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={pending || !dirty}>
            {pending ? t("web.settings.saving") : t("common.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}
