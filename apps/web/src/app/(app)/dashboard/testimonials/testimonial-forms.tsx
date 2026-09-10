"use client";

import { useActionState, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Quote,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import type { TestimonialSource } from "@prisma/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CharacterCounter } from "@/components/ui/character-counter";
import { Collapsible } from "@/components/ui/collapsible";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormStatus } from "@/components/ui/form-status";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/components/locale-provider";
import {
  addTestimonial,
  updateTestimonial,
  setTestimonialPublished,
  moveTestimonial,
  deleteTestimonial,
  deleteTestimonialPhoto,
  type TestimonialState,
} from "@/app/actions/testimonials";
import {
  TESTIMONIAL_AUTHOR_MAX,
  TESTIMONIAL_BODY_MAX,
  TESTIMONIAL_NOTE_MAX,
} from "@/lib/testimonials/limits";
import {
  ALLOWED_TESTIMONIAL_PHOTO_TYPES,
  TESTIMONIAL_PHOTO_MAX_BYTES,
  testimonialPhotoPublicUrl,
} from "@/lib/storage/testimonial-photos-public-url";
import { cn } from "@/lib/utils";

// The teacher's editor for her public-page social proof.
//
// The screen's one rule, borrowed from the communities editor it sits beside:
// READ FIRST, EDIT ON REQUEST. Every testimonial used to render as four
// expanded inputs, so five testimonials were twenty form fields and the answer
// to "what do my students actually say about me?" — the reason she opened the
// page — was not on it. Now each card shows the quote the way the booking page
// shows it, and the editor folds away behind its own header.
//
// The other half is that publishing ORDER is public and was unreachable:
// `sortOrder` decides which quote a visitor reads first and nothing in either
// client could change it. It is a pair of arrows here rather than drag-and-drop
// because arrows work on a phone, from a keyboard and through a screen reader,
// and the list is short enough that a step is never far.

const ACCEPTED_PHOTO_TYPES = Object.keys(ALLOWED_TESTIMONIAL_PHOTO_TYPES).join(",");

export type TestimonialItem = {
  id: string;
  authorName: string;
  authorNote: string | null;
  body: string;
  published: boolean;
  photoPath: string | null;
  source: TestimonialSource;
  verifiedAt: Date | null;
};

/**
 * The photo picker: the avatar that will be saved, and a check against the
 * server's own limits before an upload is spent on a file it would reject.
 *
 * The preview is the point. A file input reports "IMG_0421.jpeg" and nothing
 * else, which tells her the name of a file rather than whether she picked the
 * right face — and this one is cropped to a 40px circle on a page strangers
 * read.
 */
function PhotoField({
  idPrefix,
  currentUrl,
  label,
  hint,
}: {
  idPrefix: string;
  currentUrl: string | null;
  label: string;
  hint: string;
}) {
  const t = useT();
  const [preview, setPreview] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const hintId = `${idPrefix}-photo-hint`;
  const errorId = `${idPrefix}-photo-error`;

  // Object URLs are leaked memory until revoked; the cleanup runs on every
  // change (revoking the value being replaced) and on unmount.
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    setPreview(null);
    setRejected(null);
    if (!file) return;

    // Clearing the input on a rejected file is deliberate: it can hold only one
    // file, so leaving the bad one selected means the next Save spends an
    // upload to be told the same thing by the server.
    if (!ALLOWED_TESTIMONIAL_PHOTO_TYPES[file.type]) {
      setRejected(t("web.dashboard.testimonials.errorPhotoType"));
      input.value = "";
      return;
    }
    if (file.size > TESTIMONIAL_PHOTO_MAX_BYTES) {
      setRejected(t("web.dashboard.testimonials.errorPhotoSize"));
      input.value = "";
      return;
    }
    setPreview(URL.createObjectURL(file));
  }

  const shownUrl = preview ?? currentUrl;
  const caption = preview
    ? t("web.dashboard.testimonials.newPhoto")
    : currentUrl
      ? t("web.dashboard.testimonials.currentPhoto")
      : t("web.dashboard.testimonials.noPhotoYet");

  return (
    <div className="space-y-2">
      <Label htmlFor={`${idPrefix}-photo`}>{label}</Label>
      <div className="flex items-center gap-3">
        {shownUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={shownUrl}
            alt=""
            width={40}
            height={40}
            className="border-border h-10 w-10 shrink-0 rounded-full border object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="bg-muted text-muted-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
          >
            <UserRound className="h-4 w-4" />
          </span>
        )}
        <span className="text-muted-foreground text-xs">{caption}</span>
      </div>
      <Input
        id={`${idPrefix}-photo`}
        name="photo"
        type="file"
        accept={ACCEPTED_PHOTO_TYPES}
        onChange={onPick}
        // Whichever of the two lines below is rendered — a dangling
        // aria-describedby loses the description exactly when it matters.
        aria-describedby={rejected ? errorId : hintId}
        invalid={Boolean(rejected)}
        className="cursor-pointer"
      />
      {rejected ? (
        <p id={errorId} role="alert" className="text-destructive text-xs">
          {rejected}
        </p>
      ) : (
        <p id={hintId} className="text-muted-foreground text-xs">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * The four fields, shared by the add form and each card's edit disclosure, so
 * the two can never drift apart on labels, limits or field order — and so the
 * caps come from the same module the server validates against rather than from
 * a `maxLength` typed twice.
 */
function TestimonialFields({ idPrefix, item }: { idPrefix: string; item?: TestimonialItem }) {
  const t = useT();
  const [body, setBody] = useState(item?.body ?? "");
  const counterId = `${idPrefix}-body-counter`;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-name`}>{t("web.dashboard.testimonials.studentName")}</Label>
          <Input
            id={`${idPrefix}-name`}
            name="authorName"
            required
            maxLength={TESTIMONIAL_AUTHOR_MAX}
            defaultValue={item?.authorName}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-note`}>
            {t("web.dashboard.testimonials.contextOptional")}
          </Label>
          <Input
            id={`${idPrefix}-note`}
            name="authorNote"
            maxLength={TESTIMONIAL_NOTE_MAX}
            defaultValue={item?.authorNote ?? ""}
            placeholder={t("web.dashboard.testimonials.contextPlaceholder")}
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-body`}>
          {t("web.dashboard.testimonials.testimonialLabel")}
        </Label>
        <Textarea
          id={`${idPrefix}-body`}
          name="body"
          required
          rows={4}
          maxLength={TESTIMONIAL_BODY_MAX}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          aria-describedby={counterId}
          className="min-h-28"
        />
        {/* The cap is hard — the browser stops accepting characters at it
            without saying so — which is exactly the case a live count is for. */}
        <CharacterCounter
          id={counterId}
          length={body.length}
          max={TESTIMONIAL_BODY_MAX}
          className="text-right"
        />
      </div>

      <PhotoField
        idPrefix={idPrefix}
        currentUrl={testimonialPhotoPublicUrl(item?.photoPath)}
        label={
          item
            ? t("web.dashboard.testimonials.replacePhoto")
            : t("web.dashboard.testimonials.photoOptional")
        }
        hint={
          item
            ? t("web.dashboard.testimonials.replacePhotoHint")
            : t("web.dashboard.testimonials.photoHint")
        }
      />
    </div>
  );
}

/**
 * Adding is the rare act; reading the list is the common one. So the form
 * starts folded behind its own button — except for a teacher who has none,
 * where the form IS the empty state and there is nothing for it to push down.
 */
export function AddTestimonialPanel({ hasItems }: { hasItems: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(!hasItems);
  const [formKey, setFormKey] = useState(0);
  const [state, formAction, pending] = useActionState<TestimonialState, FormData>(
    addTestimonial,
    undefined,
  );

  // Remount the form to clear it. Uncontrolled inputs keep their DOM values
  // across a server action, so the saved words used to sit in the "Add" field
  // afterwards, reading as "that didn't save" — and inviting a second submit
  // that really would add the quote twice.
  useEffect(() => {
    if (state?.ok) setFormKey((key) => key + 1);
  }, [state]);

  // Fold away once there is a list, because the new card below is the receipt.
  useEffect(() => {
    if (state?.ok && hasItems) setOpen(false);
  }, [state, hasItems]);

  if (!open) {
    return (
      <div className="space-y-2">
        <Button type="button" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          {t("web.dashboard.testimonials.addTestimonial")}
        </Button>
        <FormStatus state={state} savedMessage={t("web.dashboard.testimonials.added")} />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="text-lg">
          {hasItems
            ? t("web.dashboard.testimonials.addTestimonial")
            : t("web.dashboard.testimonials.addFirst")}
        </CardTitle>
        <CardDescription>
          {hasItems
            ? t("web.dashboard.testimonials.addTestimonialDescription")
            : t("web.dashboard.testimonials.emptyBody")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form key={formKey} action={formAction} className="space-y-4" encType="multipart/form-data">
          <TestimonialFields idPrefix="add" />
          <FormStatus state={state} savedMessage={t("web.dashboard.testimonials.added")} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {pending
                ? t("web.dashboard.testimonials.adding")
                : t("web.dashboard.testimonials.addTestimonial")}
            </Button>
            {hasItems && (
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * One testimonial, read-first: the quote as her students see it, the two
 * controls that change what they see (order and publish), and the editor
 * folded behind a header.
 */
export function TestimonialCard({
  item,
  index,
  total,
}: {
  item: TestimonialItem;
  /** Position in the published order — drives which arrows are available. */
  index: number;
  total: number;
}) {
  const t = useT();
  const [editOpen, setEditOpen] = useState(false);
  const [editState, editAction, editPending] = useActionState<TestimonialState, FormData>(
    updateTestimonial,
    undefined,
  );
  const [publishState, publishAction, publishPending] = useActionState<TestimonialState, FormData>(
    setTestimonialPublished,
    undefined,
  );
  const [moveState, moveAction, movePending] = useActionState<TestimonialState, FormData>(
    moveTestimonial,
    undefined,
  );
  const [deleteState, deleteAction, deletePending] = useActionState<TestimonialState, FormData>(
    deleteTestimonial,
    undefined,
  );
  const [photoState, photoAction, photoPending] = useActionState<TestimonialState, FormData>(
    deleteTestimonialPhoto,
    undefined,
  );

  // A failure inside a collapsed section is a failure she never sees, so a
  // rejected save opens its own disclosure.
  useEffect(() => {
    if (editState?.error) setEditOpen(true);
  }, [editState]);

  const photoUrl = testimonialPhotoPublicUrl(item.photoPath);
  const note = item.authorNote?.trim();
  const verified = item.source === "student_submitted";
  const headerError = publishState?.error ?? moveState?.error ?? deleteState?.error;
  const StatusIcon = item.published ? Eye : EyeOff;

  return (
    <li>
      {/* Hidden reads as dashed as well as labelled: status is never carried by
          colour alone (D-140), and dimming the quote would trade legibility for
          a signal the badge already gives in words. */}
      <Card className={cn("p-4 sm:p-6", !item.published && "border-dashed")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge variant={item.published ? "success" : "outline"}>
            <StatusIcon className="h-3 w-3" aria-hidden />
            {item.published
              ? t("web.dashboard.testimonials.published")
              : t("web.dashboard.testimonials.hidden")}
          </Badge>

          {/* Provenance, a different fact from visibility: whether the platform
              can vouch for the quote, or the teacher typed it herself. */}
          {verified ? (
            <Badge variant="secondary" className="gap-1">
              <ShieldCheck className="h-3 w-3" aria-hidden />
              {t("web.dashboard.testimonials.verifiedBadge")}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground font-normal">
              {t("web.dashboard.testimonials.addedByYou")}
            </Badge>
          )}

          <div className="flex items-center gap-1">
            {total > 1 && (
              <>
                <form action={moveAction}>
                  <input type="hidden" name="id" value={item.id} />
                  <input type="hidden" name="direction" value="up" />
                  <Button
                    type="submit"
                    size="icon"
                    variant="ghost"
                    disabled={index === 0 || movePending}
                  >
                    <ChevronUp className="h-4 w-4" aria-hidden />
                    <span className="sr-only">
                      {t("web.dashboard.testimonials.moveUp", { name: item.authorName })}
                    </span>
                  </Button>
                </form>
                <form action={moveAction}>
                  <input type="hidden" name="id" value={item.id} />
                  <input type="hidden" name="direction" value="down" />
                  <Button
                    type="submit"
                    size="icon"
                    variant="ghost"
                    disabled={index === total - 1 || movePending}
                  >
                    <ChevronDown className="h-4 w-4" aria-hidden />
                    <span className="sr-only">
                      {t("web.dashboard.testimonials.moveDown", { name: item.authorName })}
                    </span>
                  </Button>
                </form>
              </>
            )}
            {/* Publishing a hidden quote is the action worth reaching for, so it
                carries more weight than hiding a live one. */}
            <form action={publishAction}>
              <input type="hidden" name="id" value={item.id} />
              <input type="hidden" name="published" value={item.published ? "false" : "true"} />
              <Button
                type="submit"
                size="sm"
                variant={item.published ? "ghost" : "secondary"}
                disabled={publishPending}
              >
                {publishPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {item.published
                  ? t("web.dashboard.testimonials.hide")
                  : t("web.dashboard.testimonials.publish")}
              </Button>
            </form>
          </div>
        </div>

        {headerError && (
          <p role="alert" className="text-destructive mt-3 text-sm">
            {headerError}
          </p>
        )}

        {/* The quote, composed the way the booking page composes it — quote
            mark, body, avatar, name · context — so the editor is also the
            preview. <figure>/<blockquote>/<figcaption> rather than the public
            page's divs: it is a quotation with an attribution, which is the
            one thing those elements are for. */}
        <figure className="mt-4 space-y-3">
          <Quote className="text-primary/60 h-5 w-5" aria-hidden />
          <blockquote className="text-foreground/80 text-sm whitespace-pre-line">
            {item.body}
          </blockquote>
          <figcaption className="flex items-center gap-2 text-sm font-medium">
            {photoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photoUrl}
                alt=""
                width={32}
                height={32}
                className="h-8 w-8 shrink-0 rounded-full object-cover"
              />
            )}
            <span>
              {item.authorName}
              {note && <span className="text-muted-foreground font-normal">{` · ${note}`}</span>}
            </span>
          </figcaption>
        </figure>

        <div className="mt-4 border-t pt-4">
          {verified ? (
            /* D-151: the words are the student's. She can hide this or delete
               it — both below — but there is no edit affordance at all, because
               every teacher-side write filters on `teacher_curated` and a CHECK
               constraint backs that up. Offering an edit that would be refused
               is worse than not offering one. */
            <p className="text-muted-foreground pb-4 text-sm">
              {t("web.dashboard.testimonials.verifiedLocked", { name: item.authorName })}
            </p>
          ) : (
            <Collapsible
              title={t("web.dashboard.testimonials.edit")}
              open={editOpen}
              onOpenChange={setEditOpen}
            >
              <form action={editAction} className="space-y-4 pt-1" encType="multipart/form-data">
                <input type="hidden" name="id" value={item.id} />
                <TestimonialFields idPrefix={item.id} item={item} />
                <FormStatus
                  state={editState}
                  savedMessage={t("web.dashboard.testimonials.saved")}
                />
                <Button type="submit" variant="outline" size="sm" disabled={editPending}>
                  {editPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  {editPending
                    ? t("web.dashboard.testimonials.saving")
                    : t("web.dashboard.testimonials.saveChanges")}
                </Button>
              </form>

              {/* Their own forms, below the save row, so neither can read as the
                other half of a Save/Cancel pair. */}
            </Collapsible>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {item.photoPath && (
              <form action={photoAction}>
                <input type="hidden" name="id" value={item.id} />
                <Button type="submit" variant="ghost" size="sm" disabled={photoPending}>
                  {t("web.dashboard.testimonials.removePhoto")}
                </Button>
              </form>
            )}
            <ConfirmDialog
              trigger={
                <Button type="button" variant="ghost" size="sm" className="text-destructive">
                  {t("web.dashboard.testimonials.deleteAction")}
                </Button>
              }
              title={t("web.dashboard.testimonials.deleteTitle")}
              description={t("web.dashboard.testimonials.deleteBody", {
                name: item.authorName,
              })}
              footer={(close) => (
                <>
                  <Button type="button" variant="outline" onClick={close}>
                    {t("common.cancel")}
                  </Button>
                  <form action={deleteAction}>
                    <input type="hidden" name="id" value={item.id} />
                    <Button type="submit" variant="destructive" disabled={deletePending}>
                      {deletePending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                      {deletePending
                        ? t("web.dashboard.testimonials.deleting")
                        : t("common.delete")}
                    </Button>
                  </form>
                </>
              )}
            />
          </div>
          <FormStatus state={photoState} />
        </div>
      </Card>
    </li>
  );
}
