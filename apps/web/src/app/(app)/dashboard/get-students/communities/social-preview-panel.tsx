"use client";

import Image from "next/image";
import { useActionState, useState } from "react";
import {
  MEME_FIXED_RULES,
  memeStyleLabel,
  SOCIAL_PREVIEW_ANGLES,
  SOCIAL_PREVIEW_CAPTION_MAX_CHARS,
  SOCIAL_PREVIEW_TOPIC_MAX_CHARS,
  SOCIAL_PREVIEW_UPLOAD_TYPES,
  type MemeStyle,
  type SocialPreviewAngle,
  type SocialPreviewImageView,
  type SocialPreviewView,
} from "@spiralclass/shared";
import { Button } from "@/components/ui/button";
import { Collapsible } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLocale, useT } from "@/components/locale-provider";
import {
  generateSocialPreview,
  removeSocialPreview,
  uploadSocialPreview,
  useSocialPreview,
  type SocialPreviewState,
} from "@/app/actions/social-preview";

// The teacher-facing image editor (D-123), rendered once per community and once
// for the "default" placement.
//
// Three deliberate UX calls:
//
//  * She picks an ANGLE and optionally says what THIS image is about. The
//    reusable half of the brief — her general instructions, her preferred look,
//    what this community's audience responds to — lives on the settings that
//    own it, not retyped here every time.
//  * She never writes a raw prompt, but she is never left guessing either.
//    "What we'll ask for" restates the whole brief in her own words, including
//    the three rules we always add. The version this replaces showed nothing,
//    which is why an image that came back different from what she typed read as
//    the tool ignoring her.
//  * The CAPTION is a plain text field that we render over the image, not
//    something the model is asked to draw. So it is editable for free, edits
//    apply instantly, and it is always spelled correctly — which matters more
//    than usual when the person posting it teaches the language.

const ACCEPT = Object.keys(SOCIAL_PREVIEW_UPLOAD_TYPES).join(",");

export type SocialPreviewPanelProps = {
  /** null for the teacher's default preview (untagged shares). */
  shareGroupId: string | null;
  preview: SocialPreviewView | null;
  images: SocialPreviewImageView[];
  quota: { used: number; cap: number };
  /** False when the platform has no image provider configured — upload stays
   * available, so the panel is never useless. */
  aiEnabled: boolean;
  /** Her general instructions and preferred look, for the brief summary. */
  settings: { memeBrief: string | null; memeStyle: MemeStyle };
  /** This community's own instructions, when the panel is for one. */
  communityBrief?: string | null;
};

export function SocialPreviewPanel({
  shareGroupId,
  preview,
  images,
  quota,
  aiEnabled,
  settings,
  communityBrief,
}: SocialPreviewPanelProps) {
  const t = useT();
  const locale = useLocale();
  const [angle, setAngle] = useState<SocialPreviewAngle>("meme");
  // Seeded from the saved caption so opening the panel on a configured group
  // shows what is actually live, not an empty box.
  const [caption, setCaption] = useState(preview?.caption ?? "");
  const [selectedImageId, setSelectedImageId] = useState<string | null>(preview?.image.id ?? null);

  const [generateState, generateAction, generating] = useActionState<SocialPreviewState, FormData>(
    generateSocialPreview,
    undefined,
  );
  const [uploadState, uploadAction, uploading] = useActionState<SocialPreviewState, FormData>(
    uploadSocialPreview,
    undefined,
  );
  const [selectState, selectAction, saving] = useActionState<SocialPreviewState, FormData>(
    useSocialPreview,
    undefined,
  );
  const [resetState, resetAction, resetting] = useActionState<SocialPreviewState, FormData>(
    removeSocialPreview,
    undefined,
  );

  // A freshly generated or uploaded image is what the teacher is looking at, so
  // it becomes the selection without a second click. `images` has already been
  // revalidated by the action, so the new row is present.
  const newestId = generateState?.imageId ?? uploadState?.imageId ?? null;
  const activeImageId = newestId ?? selectedImageId;
  const activeImage = images.find((i) => i.id === activeImageId) ?? null;

  const outOfQuota = quota.used >= quota.cap;
  const error =
    generateState?.error ?? uploadState?.error ?? selectState?.error ?? resetState?.error ?? null;

  return (
    // No heading of its own: the panel is always rendered inside a section that
    // has already named it (a community's "Image" disclosure, or the
    // default-preview section), and titling it twice was the reason those
    // sections read as two stacked things rather than one.
    <div className="space-y-4">
      {/* What is live right now. Shows the standard card by name rather than
          rendering it, so the teacher can always tell "I haven't changed this"
          apart from "I chose something". */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{t("socialPreview.current")}</p>
        {preview?.image.url ? (
          <PreviewThumb url={preview.image.url} caption={preview.caption} />
        ) : (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {t("socialPreview.standard")}
          </p>
        )}
      </div>

      {/* --- Generate --- */}
      {aiEnabled ? (
        <form action={generateAction} className="space-y-3">
          <input type="hidden" name="angle" value={angle} />
          {/* So her instructions FOR THIS AUDIENCE reach the brief. Ownership
              is re-checked server-side; a forged id yields no context. */}
          <input type="hidden" name="communityId" value={shareGroupId ?? ""} />
          <div className="space-y-2">
            <Label>{t("socialPreview.angle")}</Label>
            <div className="flex flex-wrap gap-2">
              {SOCIAL_PREVIEW_ANGLES.map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant={angle === option ? "default" : "outline"}
                  aria-pressed={angle === option}
                  onClick={() => setAngle(option)}
                >
                  {t(`socialPreview.angle.${option}`)}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor={`topic-${shareGroupId ?? "default"}`}>{t("socialPreview.topic")}</Label>
            <Input
              id={`topic-${shareGroupId ?? "default"}`}
              name="topic"
              maxLength={SOCIAL_PREVIEW_TOPIC_MAX_CHARS}
              placeholder={t("socialPreview.topicPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">{t("socialPreview.topicHelp")}</p>
          </div>

          <BriefSummary
            style={settings.memeStyle}
            teacherBrief={settings.memeBrief}
            communityBrief={communityBrief ?? null}
            locale={locale}
          />

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={generating || outOfQuota}>
              {generating
                ? t("socialPreview.generating")
                : activeImage
                  ? t("socialPreview.generateAnother")
                  : t("socialPreview.generate")}
            </Button>
            <span className="text-xs text-muted-foreground">
              {outOfQuota
                ? t("socialPreview.quotaSpent")
                : t("socialPreview.quota", { used: quota.used, cap: quota.cap })}
            </span>
          </div>
          {generating && (
            <p role="status" className="text-xs text-muted-foreground">
              {t("socialPreview.generatingHelp")}
            </p>
          )}
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">{t("socialPreview.aiUnavailable")}</p>
      )}

      {/* --- Upload. A peer of generation, never a fallback: a teacher who
              already makes images elsewhere shouldn't be pushed through the
              expensive path to use them. --- */}
      <form action={uploadAction} className="flex flex-wrap items-center gap-3">
        <Input
          type="file"
          name="file"
          accept={ACCEPT}
          className="max-w-xs"
          aria-label={t("socialPreview.upload")}
        />
        <Button type="submit" size="sm" variant="outline" disabled={uploading}>
          {uploading ? t("socialPreview.uploading") : t("socialPreview.upload")}
        </Button>
      </form>

      {/* --- Library + caption + commit --- */}
      {images.length > 0 && (
        <form action={selectAction} className="space-y-3">
          <input type="hidden" name="shareGroupId" value={shareGroupId ?? ""} />
          <input type="hidden" name="imageId" value={activeImageId ?? ""} />

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              {t("socialPreview.library")}
            </p>
            {/* The library is ONE library, shown under every community. Said
                out loud, because seeing the same thumbnails under each one
                otherwise reads as "these images belong to this community". */}
            <p className="text-xs text-muted-foreground">{t("socialPreview.libraryHelp")}</p>
            <div className="flex flex-wrap gap-2">
              {images.map((image) => (
                <button
                  key={image.id}
                  type="button"
                  onClick={() => setSelectedImageId(image.id)}
                  aria-pressed={activeImageId === image.id}
                  aria-label={image.topic ?? t("socialPreview.untitled")}
                  className={`relative h-16 w-28 overflow-hidden rounded-md border-2 ${
                    activeImageId === image.id ? "border-primary" : "border-transparent"
                  }`}
                >
                  {image.url && (
                    <Image
                      src={image.url}
                      alt=""
                      fill
                      sizes="112px"
                      className="object-cover"
                      unoptimized
                    />
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor={`caption-${shareGroupId ?? "default"}`}>
              {t("socialPreview.caption")}
            </Label>
            <Input
              id={`caption-${shareGroupId ?? "default"}`}
              name="caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              maxLength={SOCIAL_PREVIEW_CAPTION_MAX_CHARS}
              placeholder={t("socialPreview.captionPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">{t("socialPreview.captionHelp")}</p>
          </div>

          {activeImage?.url && <PreviewThumb url={activeImage.url} caption={caption} />}

          <Button type="submit" size="sm" disabled={saving || !activeImageId}>
            {saving ? t("socialPreview.saving") : t("socialPreview.use")}
          </Button>
        </form>
      )}

      {/* Reverting is always available and never destroys the image — she may
          well re-select it, and it is hers. */}
      {preview && (
        <form action={resetAction}>
          <input type="hidden" name="previewId" value={preview.id} />
          <Button type="submit" size="sm" variant="ghost" disabled={resetting}>
            {t("socialPreview.reset")}
          </Button>
        </form>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {/* Sets the expectation the crawler caches create: without this, a
          teacher who changes her image and sees the old one on an existing post
          concludes the feature is broken. */}
      <p className="text-xs text-muted-foreground">{t("socialPreview.cacheNote")}</p>
    </div>
  );
}

/**
 * The whole brief, in her own words, folded away until she asks.
 *
 * This is the transparency contract. She never sees the provider prompt — that
 * is prompt engineering and handing it to her would move the work back onto her
 * — but she can always see WHAT WENT IN: her look, her general instructions,
 * this community's instructions, and the three things we always add. Anything
 * she has not written yet is named as missing with a pointer to where it lives,
 * so an empty brief reads as "not set up" rather than as nothing at all.
 */
function BriefSummary({
  style,
  teacherBrief,
  communityBrief,
  locale,
}: {
  style: MemeStyle;
  teacherBrief: string | null;
  communityBrief: string | null;
  locale: Parameters<typeof memeStyleLabel>[1];
}) {
  const t = useT();
  return (
    <div className="rounded-md border">
      <Collapsible title={t("socialPreview.whatWeAsk")} defaultOpen={false} className="px-3 py-2">
        <dl className="space-y-2 pb-1 text-xs">
          <div>
            <dt className="font-medium">{t("socialPreview.styleLabel")}</dt>
            <dd className="text-muted-foreground">{memeStyleLabel(style, locale)}</dd>
          </div>
          <div>
            <dt className="font-medium">{t("socialPreview.generalBrief")}</dt>
            <dd className="whitespace-pre-wrap text-muted-foreground">
              {teacherBrief?.trim() || t("socialPreview.generalBriefEmpty")}
            </dd>
          </div>
          <div>
            <dt className="font-medium">{t("socialPreview.communityBrief")}</dt>
            <dd className="whitespace-pre-wrap text-muted-foreground">
              {communityBrief?.trim() || t("socialPreview.communityBriefEmpty")}
            </dd>
          </div>
          <div>
            <dt className="font-medium">{t("socialPreview.alwaysTitle")}</dt>
            <dd>
              <ul className="list-inside list-disc text-muted-foreground">
                {MEME_FIXED_RULES[locale].map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            </dd>
          </div>
        </dl>
      </Collapsible>
    </div>
  );
}

/** A rough client-side approximation of the composed card, so the teacher sees
 * roughly what a share will look like before committing. The authoritative
 * render is the Satori route — this only has to be close enough to judge
 * legibility and framing. */
function PreviewThumb({ url, caption }: { url: string; caption: string }) {
  return (
    <div className="relative aspect-social w-full max-w-sm overflow-hidden rounded-md border">
      <Image src={url} alt="" fill sizes="384px" className="object-cover" unoptimized />
      {caption.trim().length > 0 && (
        <div className="absolute inset-0 flex items-center justify-center bg-scrim-1 p-4">
          <span className="text-center text-sm leading-tight font-bold text-white drop-shadow">
            {caption}
          </span>
        </div>
      )}
    </div>
  );
}
