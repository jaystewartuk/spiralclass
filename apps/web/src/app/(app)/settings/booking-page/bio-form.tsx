"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { BIO_MAX_LENGTH } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { CharacterCounter } from "@/components/ui/character-counter";
import { FormStatus } from "@/components/ui/form-status";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/components/locale-provider";
import { saveBioAction, type ProfileState } from "@/app/actions/profile";
import { useBookingPageDraft } from "./preview-context";

export function BioForm({ initialBio }: { initialBio: string | null }) {
  const t = useT();
  const draft = useBookingPageDraft();
  const [bio, setBio] = useState(initialBio ?? "");
  // See HeadlineForm for why the persisted value is tracked separately and
  // advanced to the SUBMITTED string rather than the current one.
  const [saved, setSaved] = useState(initialBio ?? "");
  const submittedRef = useRef(saved);
  const [state, formAction, pending] = useActionState<ProfileState, FormData>(
    saveBioAction,
    undefined,
  );

  useEffect(() => {
    if (state?.ok && !state.error) setSaved(submittedRef.current);
  }, [state]);

  function onChange(value: string) {
    setBio(value);
    draft?.setBio(value);
  }

  const dirty = bio.trim() !== saved.trim();

  return (
    <form
      action={formAction}
      onSubmit={() => {
        submittedRef.current = bio;
      }}
      className="space-y-3"
    >
      <div className="space-y-2">
        <Label htmlFor="bio">{t("bookingPage.bio")}</Label>
        <Textarea
          id="bio"
          name="bio"
          maxLength={BIO_MAX_LENGTH}
          rows={4}
          value={bio}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("web.settings.bookingPage.bioPlaceholder")}
          aria-invalid={state?.error ? true : undefined}
          aria-describedby={
            state?.error ? "bio-help bio-counter bio-error" : "bio-help bio-counter"
          }
          className="resize-y"
        />
        <div className="flex items-start justify-between gap-3">
          <p id="bio-help" className="text-xs text-muted-foreground">
            {t("web.settings.bookingPage.bioHelp")}
          </p>
          <CharacterCounter id="bio-counter" length={bio.length} max={BIO_MAX_LENGTH} />
        </div>
      </div>
      <FormStatus state={state} errorId="bio-error" savedMessage={t("bookingPage.saved")} />
      <Button type="submit" disabled={pending || !dirty}>
        {pending ? t("web.settings.bookingPage.saving") : t("common.save")}
      </Button>
    </form>
  );
}
