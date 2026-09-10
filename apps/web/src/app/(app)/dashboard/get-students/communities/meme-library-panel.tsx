"use client";

import Image from "next/image";
import { useActionState, useState } from "react";
import { ImageOff, Trash2 } from "lucide-react";
import {
  MEME_STYLES,
  memeStyleSpec,
  SOCIAL_PREVIEW_TOPIC_MAX_CHARS,
  TEACHER_MEME_BRIEF_MAX_CHARS,
  type MemeStyle,
  type SocialPreviewImageView,
} from "@spiralclass/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FormStatus } from "@/components/ui/form-status";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useLocale, useT } from "@/components/locale-provider";
import { saveMemeSettingsAction, type MarketingState } from "@/app/actions/marketing";
import {
  deleteSocialPreviewImageAction,
  renameSocialPreviewImageAction,
  type SocialPreviewState,
} from "@/app/actions/social-preview";

// The image library: one place that owns the assets themselves, rather than a
// picker repeated under every community.
//
// The split with the per-community panel is the whole point. THERE she chooses
// which image a community shows; HERE the images exist, get named, and get
// deleted. Before this, the same eight thumbnails appeared under each community
// with no way to remove any of them, which read as "these belong to this
// community" and left every failed generation on screen forever.

export type MemeUsage = {
  communities: string[];
  isDefault: boolean;
  posted: boolean;
};

export type MemeLibraryPanelProps = {
  images: SocialPreviewImageView[];
  usage: Record<string, MemeUsage>;
  settings: { memeBrief: string | null; memeStyle: MemeStyle };
};

export function MemeLibraryPanel({ images, usage, settings }: MemeLibraryPanelProps) {
  const t = useT();
  return (
    <div className="space-y-6">
      <MemeSettingsForm settings={settings} />
      {images.length === 0 ? (
        <EmptyState
          icon={ImageOff}
          title={t("socialPreview.libraryEmptyTitle")}
          description={t("socialPreview.libraryEmptyBody")}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {images.map((image) => (
            <MemeCard
              key={image.id}
              image={image}
              usage={usage[image.id] ?? { communities: [], isDefault: false, posted: false }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Her general instructions and preferred look.
 *
 * Placed at the head of the library rather than buried in the acquisition
 * profile, because this is the screen where she is looking at the images these
 * settings produced — which is the only moment "my memes all look the same" is
 * a thought she is actually having.
 */
function MemeSettingsForm({
  settings,
}: {
  settings: { memeBrief: string | null; memeStyle: MemeStyle };
}) {
  const t = useT();
  const locale = useLocale();
  const [style, setStyle] = useState<MemeStyle>(settings.memeStyle);
  const [state, action, pending] = useActionState<MarketingState, FormData>(
    saveMemeSettingsAction,
    undefined,
  );

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <form action={action} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="meme-brief">{t("socialPreview.generalBrief")}</Label>
            <Textarea
              id="meme-brief"
              name="memeBrief"
              rows={5}
              maxLength={TEACHER_MEME_BRIEF_MAX_CHARS}
              defaultValue={settings.memeBrief ?? ""}
              placeholder={t("socialPreview.generalBriefPlaceholder")}
            />
            {/* Prompt engineering is not the ask. The placeholder shows the kind
                of sentence that helps, and the help text says what it is for —
                anything more technical would be the product handing her its own
                job back. */}
            <p className="text-muted-foreground text-xs">{t("socialPreview.generalBriefHelp")}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="meme-style">{t("socialPreview.styleLabel")}</Label>
            <select
              id="meme-style"
              name="memeStyle"
              value={style}
              onChange={(e) => setStyle(e.target.value as MemeStyle)}
              className="border-input bg-background h-9 w-full max-w-xs rounded-md border px-3 text-sm"
            >
              {MEME_STYLES.map((option) => (
                <option key={option} value={option}>
                  {memeStyleSpec(option).label[locale]}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-xs">{memeStyleSpec(style).summary[locale]}</p>
          </div>

          <FormStatus state={state} savedMessage={t("socialPreview.settingsSaved")} />
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            {pending ? t("socialPreview.saving") : t("socialPreview.saveSettings")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** One stored image: what it is, where it is in use, and the two things she can
 * do to it. Rename is inline (it is a label, not a form); delete is behind a
 * confirmation, because it takes the bytes with it. */
function MemeCard({ image, usage }: { image: SocialPreviewImageView; usage: MemeUsage }) {
  const t = useT();
  const [renameState, renameAction, renaming] = useActionState<SocialPreviewState, FormData>(
    renameSocialPreviewImageAction,
    undefined,
  );
  const [deleteState, deleteAction, deleting] = useActionState<SocialPreviewState, FormData>(
    deleteSocialPreviewImageAction,
    undefined,
  );

  const inUse = usage.communities.length > 0 || usage.isDefault;

  return (
    <Card className="overflow-hidden">
      <div className="aspect-social bg-muted relative w-full">
        {image.url && (
          <Image
            src={image.url}
            alt={image.topic ?? ""}
            fill
            sizes="(min-width: 1024px) 320px, (min-width: 640px) 45vw, 90vw"
            className="object-cover"
            unoptimized
          />
        )}
      </div>
      <CardContent className="space-y-3 pt-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">
            {image.source === "ai" ? t("socialPreview.sourceAi") : t("socialPreview.sourceUpload")}
          </Badge>
          {usage.isDefault && <Badge variant="secondary">{t("socialPreview.usedByDefault")}</Badge>}
          {usage.communities.map((name) => (
            <Badge key={name} variant="secondary">
              {name}
            </Badge>
          ))}
          {usage.posted && <Badge variant="success">{t("socialPreview.posted")}</Badge>}
        </div>

        <form action={renameAction} className="space-y-1">
          <input type="hidden" name="imageId" value={image.id} />
          <Label htmlFor={`rename-${image.id}`} className="text-xs">
            {t("socialPreview.imageLabel")}
          </Label>
          <div className="flex gap-2">
            <Input
              id={`rename-${image.id}`}
              name="topic"
              defaultValue={image.topic ?? ""}
              maxLength={SOCIAL_PREVIEW_TOPIC_MAX_CHARS}
              placeholder={t("socialPreview.untitled")}
            />
            <Button type="submit" size="sm" variant="outline" disabled={renaming}>
              {t("socialPreview.rename")}
            </Button>
          </div>
          {renameState?.error && (
            <p role="alert" className="text-destructive text-xs">
              {renameState.error}
            </p>
          )}
        </form>

        <div className="flex flex-wrap items-center gap-2">
          {image.url && (
            <Button asChild size="sm" variant="ghost">
              <a href={image.url} target="_blank" rel="noopener noreferrer">
                {t("socialPreview.download")}
              </a>
            </Button>
          )}
          <ConfirmDialog
            trigger={
              <Button size="sm" variant="ghost" className="text-destructive">
                <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />
                {t("socialPreview.delete")}
              </Button>
            }
            title={t("socialPreview.deleteTitle")}
            description={inUse ? t("socialPreview.deleteInUseBody") : t("socialPreview.deleteBody")}
            footer={(close) => (
              <form action={deleteAction} onSubmit={close}>
                <input type="hidden" name="imageId" value={image.id} />
                <Button type="submit" variant="destructive" size="sm" disabled={deleting}>
                  {deleting ? t("socialPreview.deleting") : t("socialPreview.delete")}
                </Button>
              </form>
            )}
          />
        </div>
        {deleteState?.error && (
          <p role="alert" className="text-destructive text-xs">
            {deleteState.error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
