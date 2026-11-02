"use client";

import { startTransition, useActionState, useId, useState } from "react";
import {
  CAPTION_MAX_CHARS_MAX,
  CAPTION_MAX_CHARS_MIN,
  CAPTION_MAX_CHARS_STEP,
  CAPTION_PAUSE_MAX_MS,
  CAPTION_PAUSE_MIN_MS,
  CAPTION_PAUSE_STEP_MS,
  CAPTION_TIMING_DEFAULTS,
  parseCaptionTiming,
  previewCaptionCuts,
  type CaptionTiming,
} from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormStatus } from "@/components/ui/form-status";
import { useT } from "@/components/locale-provider";
import { saveCaptionTimingAction, type CaptionTimingState } from "@/app/actions/caption-timing";

// The two dials, as native selects: 0 is "leave it to the browser", then every
// step in the shared range. Native because the choice is a short list on a
// phone as often as a desktop, and because the values are the server's to
// validate either way (parseCaptionTiming clamps whatever is posted).

function range(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let v = min; v <= max; v += step) out.push(v);
  return out;
}

const PAUSE_VALUES = range(CAPTION_PAUSE_MIN_MS, CAPTION_PAUSE_MAX_MS, CAPTION_PAUSE_STEP_MS);
const CHARS_VALUES = range(CAPTION_MAX_CHARS_MIN, CAPTION_MAX_CHARS_MAX, CAPTION_MAX_CHARS_STEP);

const SELECT_CLASS =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-base focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden lg:h-10 lg:text-sm";

export function CaptionTimingForm({ initial }: { initial: CaptionTiming }) {
  const t = useT();
  const ids = useId();
  const [draft, setDraft] = useState<CaptionTiming>(initial);
  const [saved, setSaved] = useState<CaptionTiming>(initial);
  // What was on screen when the save went out is what is stored once it
  // succeeds; edits made while it was in flight stay dirty.
  const [state, formAction, pending] = useActionState<CaptionTimingState, FormData>(
    async (prev, formData) => {
      const sent = parseCaptionTiming({
        pauseMs: formData.get("pauseMs"),
        maxChars: formData.get("maxChars"),
      });
      const result = await saveCaptionTimingAction(prev, formData);
      if (result?.ok && !result.error) setSaved(sent);
      return result;
    },
    undefined,
  );

  const dirty = draft.pauseMs !== saved.pauseMs || draft.maxChars !== saved.maxChars;
  const lines = previewCaptionCuts(t("web.settings.captionTiming.preview.sample"), draft);

  return (
    // Not `action={formAction}`: React resets a form when its action settles,
    // and a controlled <select> then falls back to the option it had on first
    // render — the saved value was right and the dropdown showed the old one.
    // Dispatching from a transition runs the same action without the reset.
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => formAction(data));
      }}
      className="space-y-6"
    >
      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-lg">
            {t("web.settings.captionTiming.cardTitle")}
          </CardTitle>
          <CardDescription>{t("web.settings.captionTiming.cardDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          <div className="space-y-2.5 pb-6">
            <label htmlFor={`${ids}-pause`} className="block text-sm font-medium">
              {t("web.settings.captionTiming.pause.label")}
            </label>
            <select
              id={`${ids}-pause`}
              name="pauseMs"
              className={SELECT_CLASS}
              value={draft.pauseMs}
              onChange={(e) => setDraft((d) => ({ ...d, pauseMs: Number(e.target.value) }))}
              aria-describedby={`${ids}-pause-hint`}
            >
              <option value={0}>{t("web.settings.captionTiming.pause.off")}</option>
              {PAUSE_VALUES.map((ms) => (
                <option key={ms} value={ms}>
                  {t("web.settings.captionTiming.pause.option", { ms })}
                </option>
              ))}
            </select>
            <p id={`${ids}-pause-hint`} className="text-sm text-muted-foreground">
              {t("web.settings.captionTiming.pause.hint")}
            </p>
          </div>

          <div className="space-y-2.5 pt-6">
            <label htmlFor={`${ids}-chars`} className="block text-sm font-medium">
              {t("web.settings.captionTiming.maxChars.label")}
            </label>
            <select
              id={`${ids}-chars`}
              name="maxChars"
              className={SELECT_CLASS}
              value={draft.maxChars}
              onChange={(e) => setDraft((d) => ({ ...d, maxChars: Number(e.target.value) }))}
              aria-describedby={`${ids}-chars-hint`}
            >
              <option value={0}>{t("web.settings.captionTiming.maxChars.off")}</option>
              {CHARS_VALUES.map((count) => (
                <option key={count} value={count}>
                  {t("web.settings.captionTiming.maxChars.option", { count })}
                </option>
              ))}
            </select>
            <p id={`${ids}-chars-hint`} className="text-sm text-muted-foreground">
              {t("web.settings.captionTiming.maxChars.hint")}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2" className="text-lg">
            {t("web.settings.captionTiming.preview.title")}
          </CardTitle>
          <CardDescription>{t("web.settings.captionTiming.preview.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2" data-testid="caption-timing-preview">
            {lines.map((line, i) => (
              <li key={i} className="rounded-md bg-muted px-3 py-2 text-base">
                {line}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <div className="sticky bottom-0 z-30 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-background/95 py-3 pb-safe-bottom backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="min-w-0 flex-1">
          {dirty ? (
            <p className="text-sm text-warning" aria-live="polite">
              {t("web.settings.captionTiming.unsaved")}
            </p>
          ) : (
            <FormStatus state={state} savedMessage={t("web.settings.captionTiming.savedMessage")} />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setDraft(CAPTION_TIMING_DEFAULTS)}
            disabled={pending || (draft.pauseMs === 0 && draft.maxChars === 0)}
          >
            {t("web.settings.captionTiming.reset")}
          </Button>
          <Button type="submit" size="sm" disabled={pending || !dirty}>
            {pending ? t("web.settings.saving") : t("common.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}
