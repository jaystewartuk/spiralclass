"use client";

import { useActionState, useState } from "react";
import {
  contentKindSpec,
  platformSpec,
  promoPolicyLabel,
  type MarketingContentKind,
  type MarketingPlatform,
  type PromoPolicy,
} from "@spiralclass/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useLocale, useT } from "@/components/locale-provider";
import { CopyLinkButton } from "@/components/copy-link-button";
import {
  prepareActivityAction,
  saveActivityBodyAction,
  type MarketingState,
  type PrepareState,
} from "@/app/actions/marketing";

// The working surface for one prepared action: generate it, read why, edit it,
// copy it, open the destination, mark it done.
//
// Note what is deliberately absent — a "post it for me" button. Facebook
// removed Groups publishing in 2024 and Reddit treats automated promotion as
// spam; a product that automated the posting would be handing teachers a ban.
// So the app automates everything AROUND the act of posting and leaves the act
// itself to the person whose account it is.

export type PreparePanelProps = {
  activityId: string;
  kind: MarketingContentKind;
  platform: MarketingPlatform;
  promoPolicy: PromoPolicy;
  body: string | null;
  title: string | null;
  angleNote: string | null;
  trackedLink: string | null;
  imageUrl: string | null;
  communityUrl: string | null;
};

export function PreparePanel(props: PreparePanelProps) {
  const t = useT();
  const locale = useLocale();
  const [draft, setDraft] = useState(props.body ?? "");
  const [prepareState, prepareAction, preparing] = useActionState<PrepareState, FormData>(
    prepareActivityAction,
    undefined,
  );
  const [saveState, saveAction, saving] = useActionState<MarketingState, FormData>(
    saveActivityBodyAction,
    undefined,
  );

  const spec = contentKindSpec(props.kind);
  const platform = platformSpec(props.platform);
  const needsSourcePost = props.kind === "community_reply";
  const hasBody = draft.trim().length > 0;

  return (
    <div className="space-y-6">
      {/* The community's own rules, stated before anything is generated. This
          is the platform-safety contract made visible: what she is told here
          is exactly what constrained the generator. */}
      <Alert>
        <AlertDescription className="space-y-1">
          <div className="font-medium">{t("web.getStudents.rulesTitle")}</div>
          <div className="text-sm">{promoPolicyLabel(props.promoPolicy, locale)}</div>
          <ul className="list-inside list-disc text-sm">
            {platform.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
          {!spec.wantsLink || !props.trackedLink ? (
            <div className="text-sm">{t("web.getStudents.noLinkNotice")}</div>
          ) : null}
        </AlertDescription>
      </Alert>

      <form action={prepareAction} className="space-y-3">
        <input type="hidden" name="id" value={props.activityId} />
        {needsSourcePost && (
          <div className="space-y-1">
            <Label htmlFor="sourcePost">{t("web.getStudents.sourcePostLabel")}</Label>
            <Textarea id="sourcePost" name="sourcePost" rows={4} maxLength={2000} />
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="topic">{t("web.getStudents.topicLabel")}</Label>
          <Input
            id="topic"
            name="topic"
            maxLength={300}
            placeholder={t("web.getStudents.topicPlaceholder")}
          />
        </div>
        <Button type="submit" disabled={preparing}>
          {preparing
            ? t("web.getStudents.preparing")
            : hasBody
              ? t("web.getStudents.regenerateContent")
              : t("web.getStudents.prepare")}
        </Button>
        {prepareState?.reason === "not-configured" && (
          <p className="text-muted-foreground text-sm">{t("web.getStudents.notConfigured")}</p>
        )}
        {prepareState?.reason === "throttled" && (
          <p role="alert" className="text-destructive text-sm">
            {t("web.getStudents.throttled")}
          </p>
        )}
        {prepareState?.reason &&
          prepareState.reason !== "not-configured" &&
          prepareState.reason !== "throttled" && (
            <p role="alert" className="text-destructive text-sm">
              {t("web.getStudents.generateFailed")}
            </p>
          )}
      </form>

      {props.angleNote && (
        <div className="space-y-1">
          <div className="text-sm font-medium">{t("web.getStudents.theAngle")}</div>
          <p className="text-muted-foreground text-sm">{props.angleNote}</p>
        </div>
      )}

      <form action={saveAction} className="space-y-3">
        <input type="hidden" name="id" value={props.activityId} />
        <div className="space-y-1">
          <Label htmlFor="body">{t("web.getStudents.yourText")}</Label>
          <Textarea
            id="body"
            name="body"
            rows={12}
            maxLength={5000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">{t("web.getStudents.editHint")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="outline" size="sm" disabled={saving || !hasBody}>
            {t("web.getStudents.saveText")}
          </Button>
          {hasBody && <CopyLinkButton value={draft} label={t("web.getStudents.copyText")} />}
          {props.trackedLink && (
            <CopyLinkButton value={props.trackedLink} label={t("web.getStudents.copyLink")} />
          )}
          {props.communityUrl && (
            <Button asChild variant="outline" size="sm">
              <a href={props.communityUrl} target="_blank" rel="noopener noreferrer">
                {t("web.getStudents.openCommunity")}
              </a>
            </Button>
          )}
          {props.imageUrl && (
            <Button asChild variant="outline" size="sm">
              <a href={props.imageUrl} target="_blank" rel="noopener noreferrer">
                {t("web.getStudents.downloadImage")}
              </a>
            </Button>
          )}
        </div>
        {saveState?.error && (
          <p role="alert" className="text-destructive text-sm">
            {saveState.error}
          </p>
        )}
      </form>

      {props.trackedLink && (
        <p className="text-muted-foreground text-xs">{t("web.getStudents.trackedLinkNotice")}</p>
      )}
    </div>
  );
}
