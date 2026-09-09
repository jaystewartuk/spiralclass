"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { HEADLINE_MAX_LENGTH } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { CharacterCounter } from "@/components/ui/character-counter";
import { FormStatus } from "@/components/ui/form-status";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";
import { saveHeadlineAction, type ProfileState } from "@/app/actions/profile";
import { useBookingPageDraft } from "./preview-context";

export function HeadlineForm({ initialHeadline }: { initialHeadline: string | null }) {
  const t = useT();
  const draft = useBookingPageDraft();
  const [headline, setHeadline] = useState(initialHeadline ?? "");
  // What is currently persisted, so Save can be inert when there is nothing to
  // save. Advanced only on a confirmed write, and to the value that was
  // actually submitted — not to whatever is in the box when the response lands,
  // which is a different string if she kept typing.
  const [saved, setSaved] = useState(initialHeadline ?? "");
  const submittedRef = useRef(saved);
  const [state, formAction, pending] = useActionState<ProfileState, FormData>(
    saveHeadlineAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok && !state.error) setSaved(submittedRef.current);
  }, [state]);

  function onChange(value: string) {
    setHeadline(value);
    // Feeds the preview beside this field, so a headline can be judged at the
    // size a student will read it at before it is committed.
    draft?.setHeadline(value);
  }

  const dirty = headline.trim() !== saved.trim();

  return (
    <form
      action={formAction}
      onSubmit={() => {
        submittedRef.current = headline;
      }}
      className="space-y-3"
    >
      <div className="space-y-2">
        <Label htmlFor="headline">{t("bookingPage.headline")}</Label>
        <Input
          id="headline"
          name="headline"
          maxLength={HEADLINE_MAX_LENGTH}
          value={headline}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("web.settings.bookingPage.headlineFieldPlaceholder")}
          aria-invalid={state?.error ? true : undefined}
          aria-describedby={
            state?.error
              ? "headline-help headline-counter headline-error"
              : "headline-help headline-counter"
          }
        />
        <div className="flex items-start justify-between gap-3">
          <p id="headline-help" className="text-xs text-muted-foreground">
            {t("web.settings.bookingPage.headlineHelp")}
          </p>
          <CharacterCounter
            id="headline-counter"
            length={headline.length}
            max={HEADLINE_MAX_LENGTH}
          />
        </div>
      </div>
      <FormStatus state={state} errorId="headline-error" savedMessage={t("bookingPage.saved")} />
      <Button type="submit" disabled={pending || !dirty}>
        {pending ? t("web.settings.bookingPage.saving") : t("common.save")}
      </Button>
    </form>
  );
}
