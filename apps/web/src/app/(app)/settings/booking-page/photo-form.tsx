"use client";

import Image from "next/image";
import { useActionState, useRef } from "react";
import { initialsFrom } from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { FormStatus } from "@/components/ui/form-status";
import { useT } from "@/components/locale-provider";
import {
  removeTeacherPhotoAction,
  saveTeacherPhotoAction,
  type ProfileState,
} from "@/app/actions/profile";

/**
 * The profile photo.
 *
 * Two changes from the raw `<input type="file">` this used to be:
 *
 *  - **One step, not two.** It was a file picker plus a separate submit button
 *    labelled "Change photo" — which reads like the button that opens the
 *    picker, so the obvious order (click it, then pick) did nothing. Picking a
 *    file now submits, which is what every avatar control does.
 *  - **An empty state that tells the truth.** With no photo it rendered
 *    nothing, so the one field that decides whether her page is reachable at
 *    all looked optional. It now shows the same monogram `/b/<slug>` falls back
 *    to, at the same shape, so what is missing is visible.
 *
 * The input stays a real focusable `<input type="file">` behind a label styled
 * as a button — `focus-within` puts the ring on the label — rather than a
 * button that clicks a hidden input, which strips the native keyboard and
 * screen-reader behaviour for no gain.
 */
export function PhotoForm({ photoUrl, name }: { photoUrl: string | null; name: string }) {
  const t = useT();
  const formRef = useRef<HTMLFormElement>(null);
  const [uploadState, uploadAction, uploading] = useActionState<ProfileState, FormData>(
    saveTeacherPhotoAction,
    undefined,
  );
  const [removeState, removeAction, removing] = useActionState<ProfileState, FormData>(
    removeTeacherPhotoAction,
    undefined,
  );

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-4">
        {photoUrl ? (
          <Image
            src={photoUrl}
            alt={t("web.settings.bookingPage.photoAlt")}
            width={96}
            height={96}
            className="h-20 w-20 shrink-0 rounded-2xl border object-cover"
          />
        ) : (
          <div
            aria-hidden
            className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border border-dashed bg-muted"
          >
            <span className="text-xl font-semibold text-muted-foreground">
              {initialsFrom(name)}
            </span>
          </div>
        )}

        <div className="min-w-0 flex-1 space-y-2">
          <form ref={formRef} action={uploadAction}>
            {/* Mirrors Button's `outline` variant. A <Button> cannot be used
                here: the control has to be a <label> for the file input, and a
                nested button would swallow the click.

                The ring is `focus-within`, NOT `peer-focus-visible`: the input
                is a CHILD of this label, and `peer-*` compiles to a sibling
                combinator, so a peer variant here draws no focus ring at all —
                a keyboard user tabbing onto the control would see nothing
                move. */}
            <label className="inline-flex h-11 cursor-pointer items-center justify-center rounded-md border border-border bg-transparent px-4 text-sm font-medium ring-offset-background transition-colors focus-within:ring-3 focus-within:ring-ring focus-within:ring-offset-2 hover:bg-muted hover:text-foreground active:bg-muted/70 lg:h-10">
              <input
                name="photo"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={uploading}
                // Picking a file IS the action — no second button to find.
                onChange={(e) => {
                  if (e.target.files?.length) formRef.current?.requestSubmit();
                }}
                className="sr-only"
              />
              {uploading
                ? t("web.settings.bookingPage.uploadingPhoto")
                : photoUrl
                  ? t("bookingPage.choosePhoto")
                  : t("bookingPage.addPhoto")}
            </label>
          </form>

          {/* The nudge leads when there is no photo: the format rules matter
              only once she is choosing a file, and she is not yet. */}
          {!photoUrl && (
            <p className="text-xs text-muted-foreground">{t("bookingPage.noPhotoNudge")}</p>
          )}

          <p className="text-xs text-muted-foreground">{t("web.settings.bookingPage.photoHelp")}</p>

          {photoUrl && (
            <form action={removeAction}>
              <Button type="submit" variant="ghost" size="sm" disabled={removing}>
                {removing
                  ? t("web.settings.bookingPage.removingPhoto")
                  : t("bookingPage.removePhoto")}
              </Button>
            </form>
          )}
        </div>
      </div>

      <FormStatus state={uploadState} savedMessage={t("bookingPage.photoUpdated")} />
      <FormStatus state={removeState} savedMessage={t("bookingPage.photoRemoved")} />
    </div>
  );
}
