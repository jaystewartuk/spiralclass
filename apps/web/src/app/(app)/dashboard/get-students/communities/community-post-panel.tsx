"use client";

import Image from "next/image";
import { useActionState, useState } from "react";
import {
  contentKindLabel,
  contentKindSummary,
  contentKindSpec,
  type MarketingContentKind,
  type MarketingPlatform,
} from "@spiralclass/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useLocale, useT } from "@/components/locale-provider";
import { CopyLinkButton } from "@/components/copy-link-button";
import {
  generateCommunityPostAction,
  saveActivityBodyAction,
  type MarketingState,
  type PrepareState,
} from "@/app/actions/marketing";

// The post for one community: the words, the picture and the tracked link, in
// one place and in the order she uses them.
//
// The Communities page used to hand her a link and stop there, which left the
// hardest part — what to actually write — outside the product. This panel
// closes that, and it does it WITHOUT a second content pipeline: it drives the
// same MarketingActivity the weekly plan drives, through the same
// prepareActivity, so a post written here is measured by the same results
// screen and is editable from the same place. The only thing that is new is the
// entry point.
//
// Note what is deliberately absent — a "post it for me" button. Facebook
// removed Groups publishing in 2024 and Reddit treats automated promotion as
// spam; a product that automated the posting would be handing teachers a ban.

export type CommunityPostPanelProps = {
  communityId: string;
  platform: MarketingPlatform;
  /** Content kinds this community's platform, policy and her own account allow.
   * Computed on the server from `eligibleContentKinds` — a kind that cannot be
   * posted honestly here is never offered, rather than offered and refused. */
  kinds: MarketingContentKind[];
  draft: {
    id: string;
    kind: MarketingContentKind;
    body: string | null;
    title: string | null;
    angleNote: string | null;
    trackedLink: string | null;
    imageUrl: string | null;
    /** True once content has been generated or written. */
    ready: boolean;
  } | null;
  /** The community's own page, so posting is one click from here. */
  communityUrl: string | null;
};

export function CommunityPostPanel(props: CommunityPostPanelProps) {
  const t = useT();
  const locale = useLocale();
  const [kind, setKind] = useState<MarketingContentKind>(
    props.draft?.kind ?? props.kinds[0] ?? "tip",
  );
  const [draftBody, setDraftBody] = useState(props.draft?.body ?? "");

  const [generateState, generateAction, generating] = useActionState<PrepareState, FormData>(
    generateCommunityPostAction,
    undefined,
  );
  const [saveState, saveAction, saving] = useActionState<MarketingState, FormData>(
    saveActivityBodyAction,
    undefined,
  );

  const hasBody = draftBody.trim().length > 0;
  const link = props.draft?.trackedLink ?? null;
  // What she actually pastes. The link is appended rather than assumed to be in
  // the body: the generator is instructed to include it, but she owns the text
  // and may have edited it out, and a copy button that silently drops her link
  // is the failure this whole attribution system exists to prevent.
  const composed =
    hasBody && link && !draftBody.includes(link)
      ? `${draftBody.trim()}\n\n${link}`
      : draftBody.trim();

  const spec = contentKindSpec(kind);

  if (props.kinds.length === 0) {
    // Every kind was filtered out — a prohibited community with nothing
    // educational left, or an account with no packages, photo or testimonials
    // yet. Saying which is the planner's job, not this panel's.
    return <p className="text-sm text-muted-foreground">{t("web.getStudents.postNoKinds")}</p>;
  }

  return (
    <div className="space-y-4">
      <form action={generateAction} className="space-y-3">
        <input type="hidden" name="communityId" value={props.communityId} />
        <input type="hidden" name="platform" value={props.platform} />
        <input type="hidden" name="kind" value={kind} />

        <div className="space-y-1">
          <Label htmlFor={`kind-${props.communityId}`}>{t("web.getStudents.postKind")}</Label>
          <select
            id={`kind-${props.communityId}`}
            value={kind}
            onChange={(e) => setKind(e.target.value as MarketingContentKind)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            {props.kinds.map((k) => (
              <option key={k} value={k}>
                {contentKindLabel(k, locale)}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{contentKindSummary(kind, locale)}</p>
        </div>

        <div className="space-y-1">
          <Label htmlFor={`topic-${props.communityId}`}>{t("web.getStudents.topicLabel")}</Label>
          <Input
            id={`topic-${props.communityId}`}
            name="topic"
            maxLength={300}
            placeholder={t("web.getStudents.topicPlaceholder")}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={generating}>
            {generating
              ? t("web.getStudents.postWriting")
              : hasBody
                ? t("web.getStudents.rewritePost")
                : t("web.getStudents.writePost")}
          </Button>
          {/* Whether this post will carry a link, said BEFORE she generates —
              the community's own rules decided it, and finding out afterwards
              reads as the feature having failed. */}
          <span className="text-xs text-muted-foreground">
            {spec.wantsLink
              ? link
                ? t("web.getStudents.postIncludesLink")
                : t("web.getStudents.postNoLink")
              : t("web.getStudents.postNeverLink")}
          </span>
        </div>

        {generateState?.reason === "not-configured" && (
          <p className="text-sm text-muted-foreground">{t("web.getStudents.notConfigured")}</p>
        )}
        {generateState?.reason === "throttled" && (
          <p role="alert" className="text-sm text-destructive">
            {t("web.getStudents.throttled")}
          </p>
        )}
        {generateState?.reason &&
          generateState.reason !== "not-configured" &&
          generateState.reason !== "throttled" && (
            <p role="alert" className="text-sm text-destructive">
              {t("web.getStudents.generateFailed")}
            </p>
          )}
      </form>

      {props.draft?.angleNote && (
        <div className="space-y-1">
          <div className="text-sm font-medium">{t("web.getStudents.theAngle")}</div>
          <p className="text-sm text-muted-foreground">{props.draft.angleNote}</p>
        </div>
      )}

      {props.draft ? (
        <form action={saveAction} className="space-y-3">
          <input type="hidden" name="id" value={props.draft.id} />
          <div className="space-y-1">
            <Label htmlFor={`body-${props.communityId}`}>{t("web.getStudents.yourText")}</Label>
            <Textarea
              id={`body-${props.communityId}`}
              name="body"
              rows={10}
              maxLength={5000}
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              placeholder={t("web.getStudents.postBodyPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">{t("web.getStudents.editHint")}</p>
          </div>

          {/* The finished thing, exactly as it will be pasted. Shown rather
              than described, because "post + link + image" is a promise that
              only means something once she can see it assembled. */}
          {hasBody && (
            <div className="space-y-3 rounded-md border bg-muted/40 p-3">
              <p className="text-xs font-medium">{t("web.getStudents.postPreview")}</p>
              <p className="whitespace-pre-wrap text-sm">{composed}</p>
              {props.draft.imageUrl && (
                <div className="relative aspect-social w-full max-w-sm overflow-hidden rounded-md border">
                  <Image
                    src={props.draft.imageUrl}
                    alt=""
                    fill
                    sizes="384px"
                    className="object-cover"
                    unoptimized
                  />
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="outline" size="sm" disabled={saving || !hasBody}>
              {saving ? t("web.dashboard.shareGroups.saving") : t("web.getStudents.saveText")}
            </Button>
            {hasBody && (
              <CopyLinkButton value={composed} label={t("web.getStudents.copyPostAndLink")} />
            )}
            {props.communityUrl && (
              <Button asChild variant="outline" size="sm">
                <a href={props.communityUrl} target="_blank" rel="noopener noreferrer">
                  {t("web.getStudents.openCommunity")}
                </a>
              </Button>
            )}
          </div>
          {saveState?.error && (
            <p role="alert" className="text-sm text-destructive">
              {saveState.error}
            </p>
          )}
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">{t("web.getStudents.postNone")}</p>
      )}
    </div>
  );
}

/** The folded-state summary: whether there is a post waiting here at all.
 * Scanning the column of these answers "what have I got ready?" without
 * opening anything. */
export function CommunityPostSummary({ ready }: { ready: boolean }) {
  const t = useT();
  return ready ? (
    <Badge variant="success">{t("web.getStudents.postReadyBadge")}</Badge>
  ) : (
    <span className="shrink-0 text-xs text-muted-foreground">
      {t("web.getStudents.postNoneShort")}
    </span>
  );
}
