"use client";

import { useActionState, useRef } from "react";
import { AccountAvatar } from "@/components/account-avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FormStatus } from "@/components/ui/form-status";
import { Heading } from "@/components/ui/heading";
import { useT } from "@/components/locale-provider";
import {
  removeStudentPhotoAction,
  saveStudentPhotoAction,
  type ProfileState,
} from "@/app/actions/student-photo";

/**
 * Who you are signed in as — the block the page opens with.
 *
 * It replaces a "Profile photo" card that sat FIRST in a stack of twelve
 * equals, which put the least consequential setting on the page above the name
 * and the sign-in address, and left the page unable to answer the first
 * question anyone brings to an account screen: whose account is this. Here the
 * photo is what it actually is — the picture of the person named beside it —
 * and the upload is an action on that picture rather than a topic of its own.
 *
 * The file input is driven by a real `<Button>` instead of being rendered raw.
 * A bare `<input type="file">` is unstyleable across browsers, carries a
 * browser-language label ("Choose File" in English on a Spanish desktop), and
 * needed a second click on a separate Upload button to do anything. Choosing a
 * file IS the intent, so selection submits.
 */
export function AccountIdentityCard({
  name,
  email,
  photoUrl,
  meta,
}: {
  name: string;
  email: string | null;
  photoUrl: string | null;
  /** At-a-glance facts whose controls live further down (timezone, language). */
  meta: string[];
}) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [uploadState, uploadAction, uploading] = useActionState<ProfileState, FormData>(
    saveStudentPhotoAction,
    undefined,
  );
  const [removeState, removeAction, removing] = useActionState<ProfileState, FormData>(
    removeStudentPhotoAction,
    undefined,
  );

  return (
    <Card className="space-y-3 p-5 lg:p-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <AccountAvatar name={name} email={email} photoUrl={photoUrl} size="xl" />
        <div className="min-w-0 flex-1 space-y-1">
          <Heading level={3} as="h2" className="break-words">
            {name}
          </Heading>
          {email ? <p className="text-sm break-all text-muted-foreground">{email}</p> : null}
          {meta.length > 0 ? (
            <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
              {meta.map((item, index) => (
                // The separator travels INSIDE the item it precedes, so a wrap
                // on a narrow screen takes it down with its own fact rather
                // than leaving a dot dangling at the end of the line above.
                // `aria-hidden` because read aloud it interrupts the two facts.
                <span key={item} className="whitespace-nowrap">
                  {index > 0 ? (
                    <span aria-hidden className="mr-2">
                      {"\u00b7"}
                    </span>
                  ) : null}
                  {item}
                </span>
              ))}
            </p>
          ) : null}
        </div>

        {/* Beside the identity from `lg` up, on its own line below it under
            that — a full-width basis is what makes the row wrap rather than
            squeezing a long name into nothing to keep the buttons alongside. */}
        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
          <form ref={formRef} action={uploadAction}>
            {/* Hidden from the accessibility tree and out of the tab order: the
              button beside it is the control, and a second, invisible stop for
              the same job is noise to anyone tabbing through. */}
            <input
              ref={fileRef}
              name="photo"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(event) => {
                if (event.currentTarget.files?.length) formRef.current?.requestSubmit();
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploading}
              aria-describedby="photo-hint"
              onClick={() => fileRef.current?.click()}
            >
              {uploading
                ? t("web.myClasses.account.photo.uploading")
                : photoUrl
                  ? t("web.myClasses.account.photo.change")
                  : t("web.myClasses.account.photo.add")}
            </Button>
          </form>

          {photoUrl ? (
            <form action={removeAction}>
              <Button type="submit" variant="ghost" size="sm" disabled={removing}>
                {removing
                  ? t("web.myClasses.account.photo.removing")
                  : t("web.myClasses.account.photo.remove")}
              </Button>
            </form>
          ) : null}
        </div>
      </div>

      <p id="photo-hint" className="text-sm text-muted-foreground">
        {t("web.myClasses.account.photo.hint")}
      </p>
      <FormStatus state={uploadState} savedMessage={t("web.myClasses.account.photo.saved")} />
      <FormStatus state={removeState} savedMessage={t("web.myClasses.account.photo.removed")} />
    </Card>
  );
}
