"use client";

import { useActionState, useEffect, useState } from "react";
import { CalendarClock, ExternalLink, LinkIcon, Plus } from "lucide-react";
import {
  COMMUNITY_MEME_BRIEF_MAX_CHARS,
  MARKETING_PLATFORMS,
  PROMO_EVERY_DAYS_MAX,
  PROMO_NOTES_MAX_CHARS,
  PROMO_POLICIES,
  allowsDirectPromotion,
  describePromotionRules,
  platformLabel,
  promoPolicyLabel,
  shareTaggedUrl,
  weekdayLabels,
  WEEKDAYS,
  type MarketingPlatform,
  type PromoPolicy,
  type PromotionRules,
} from "@spiralclass/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible } from "@/components/ui/collapsible";
import { FormStatus } from "@/components/ui/form-status";
import { Heading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useLocale, useT } from "@/components/locale-provider";
import { CopyLinkButton } from "@/components/copy-link-button";
import {
  addCommunityAction,
  archiveCommunityAction,
  restoreCommunityAction,
  updateCommunityAction,
  type MarketingState,
} from "@/app/actions/marketing";

export type CommunityItem = {
  id: string;
  name: string;
  url: string | null;
  platform: MarketingPlatform;
  promoPolicy: PromoPolicy;
  audienceNote: string | null;
  rules: PromotionRules;
  memeBrief: string | null;
  archived: boolean;
};

/**
 * Whether she may promote here TODAY, decided on the server against her own
 * timezone and handed down as a fact. A client-side `new Date()` would make the
 * card's first paint disagree with the server's and hydrate wrong.
 */
export type CommunityWindow =
  | { allowed: true }
  | { allowed: false; reason: "weekday"; nextDayLabel: string | null }
  | { allowed: false; reason: "frequency"; nextDateLabel: string };

// The promotion policy is the one field on this screen with consequences —
// it decides what the planner is allowed to write for a community (D-125) —
// so it is shown as a coloured badge with its consequence spelled out, on the
// card and again live under the picker. A teacher who reads only the badges
// still knows what each community will get.
const POLICY_TONE: Record<PromoPolicy, "success" | "info" | "outline" | "warning"> = {
  open: "success",
  limited: "info",
  prohibited: "outline",
  // Amber, not grey: unconfirmed is the one value she can improve by acting.
  unknown: "warning",
};

function PlatformSelect({ id, defaultValue }: { id: string; defaultValue?: MarketingPlatform }) {
  const locale = useLocale();
  return (
    <select
      id={id}
      name="platform"
      defaultValue={defaultValue ?? "facebook_group"}
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
    >
      {MARKETING_PLATFORMS.map((p) => (
        <option key={p} value={p}>
          {platformLabel(p, locale)}
        </option>
      ))}
    </select>
  );
}

/**
 * The specifics of a promotion policy.
 *
 * Rendered only when the policy actually permits promotion, because there is
 * nothing to schedule for a community that forbids it and a disabled block of
 * six controls is worse than no block. It is a CHILD of the policy picker in
 * every sense: it appears when she answers "open" or "limited", and it
 * disappears — leaving the stored values untouched — when she does not.
 *
 * The hidden marker is load-bearing. A checkbox group posts nothing at all
 * when every box is cleared, so without it "she unchecked every day" and "this
 * form has no day picker" are the same request, and the second must never blank
 * a stored rule.
 */
function PromotionRulesFields({ idPrefix, rules }: { idPrefix: string; rules: PromotionRules }) {
  const t = useT();
  const locale = useLocale();
  const labels = weekdayLabels(locale);

  return (
    <div className="space-y-4 rounded-md border bg-muted/30 p-3 sm:col-span-2">
      <input type="hidden" name="promoRulesPresent" value="1" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("web.getStudents.rulesSectionTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("web.getStudents.rulesSectionHelp")}</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("web.getStudents.promoDays")}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {WEEKDAYS.map((day) => (
            <div key={day} className="flex items-center gap-2">
              <Checkbox
                id={`${idPrefix}-day-${day}`}
                name="promoWeekdays"
                value={String(day)}
                defaultChecked={rules.weekdays.includes(day)}
              />
              <Label htmlFor={`${idPrefix}-day-${day}`} className="text-sm font-normal">
                {labels[day]}
              </Label>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("web.getStudents.promoDaysHelp")}</p>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-every`}>{t("web.getStudents.promoEveryDays")}</Label>
          <div className="flex items-center gap-2">
            <Input
              id={`${idPrefix}-every`}
              name="promoEveryDays"
              type="number"
              inputMode="numeric"
              min={1}
              max={PROMO_EVERY_DAYS_MAX}
              className="max-w-24"
              defaultValue={rules.everyDays ?? ""}
            />
            <span className="text-sm text-muted-foreground">
              {t("web.getStudents.promoEveryDaysUnit")}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t("web.getStudents.promoEveryDaysHelp")}</p>
        </div>

        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-links`}>{t("web.getStudents.promoLinks")}</Label>
          <select
            id={`${idPrefix}-links`}
            name="promoLinksAllowed"
            defaultValue={
              rules.linksAllowed === null ? "default" : rules.linksAllowed ? "yes" : "no"
            }
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="default">{t("web.getStudents.promoLinksDefault")}</option>
            <option value="yes">{t("web.getStudents.promoLinksYes")}</option>
            <option value="no">{t("web.getStudents.promoLinksNo")}</option>
          </select>
          <p className="text-xs text-muted-foreground">{t("web.getStudents.promoLinksHelp")}</p>
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-notes`}>{t("web.getStudents.promoNotes")}</Label>
        <Textarea
          id={`${idPrefix}-notes`}
          name="promoNotes"
          rows={3}
          maxLength={PROMO_NOTES_MAX_CHARS}
          defaultValue={rules.notes ?? ""}
          placeholder={t("web.getStudents.promoNotesPlaceholder")}
        />
        {/* Said plainly rather than implied: a sentence in a textarea is
            context for the writer, not a rule the app can enforce, and a
            teacher who believes otherwise will trust it with something that
            matters. */}
        <p className="text-xs text-muted-foreground">{t("web.getStudents.promoNotesHelp")}</p>
      </div>
    </div>
  );
}

/** Self-describing: changing the value restates what it will mean for her,
 * rather than leaving the consequence in help text next to the submit button.
 * It also decides whether the rule block below it exists at all. */
function PolicyFields({
  idPrefix,
  defaultValue,
  rules,
}: {
  idPrefix: string;
  defaultValue?: PromoPolicy;
  rules: PromotionRules;
}) {
  const locale = useLocale();
  const t = useT();
  const [policy, setPolicy] = useState<PromoPolicy>(defaultValue ?? "unknown");
  return (
    <>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-policy`}>{t("web.getStudents.communityPolicy")}</Label>
        <select
          id={`${idPrefix}-policy`}
          name="promoPolicy"
          value={policy}
          onChange={(e) => setPolicy(e.target.value as PromoPolicy)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        >
          {PROMO_POLICIES.map((p) => (
            <option key={p} value={p}>
              {promoPolicyLabel(p, locale)}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {t(`web.getStudents.communityPolicyEffect.${policy}`)}
        </p>
      </div>
      {allowsDirectPromotion(policy) && <PromotionRulesFields idPrefix={idPrefix} rules={rules} />}
    </>
  );
}

const EMPTY_RULES: PromotionRules = {
  weekdays: [],
  everyDays: null,
  linksAllowed: null,
  notes: null,
};

/** The fields, shared by the add form and each card's edit disclosure, so the
 * two can never drift apart on labels, limits or field order. */
function CommunityFields({ idPrefix, item }: { idPrefix: string; item?: CommunityItem }) {
  const t = useT();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-name`}>{t("web.getStudents.communityName")}</Label>
        <Input
          id={`${idPrefix}-name`}
          name="name"
          required
          maxLength={80}
          defaultValue={item?.name}
          placeholder={t("web.dashboard.shareGroups.groupNamePlaceholder")}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-url`}>{t("web.getStudents.communityUrl")}</Label>
        <Input
          id={`${idPrefix}-url`}
          name="url"
          type="url"
          maxLength={300}
          defaultValue={item?.url ?? ""}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-platform`}>{t("web.getStudents.communityPlatform")}</Label>
        <PlatformSelect id={`${idPrefix}-platform`} defaultValue={item?.platform} />
      </div>
      <PolicyFields
        idPrefix={idPrefix}
        defaultValue={item?.promoPolicy}
        rules={item?.rules ?? EMPTY_RULES}
      />
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-audience`}>{t("web.getStudents.communityAudience")}</Label>
        <Input
          id={`${idPrefix}-audience`}
          name="audienceNote"
          maxLength={160}
          defaultValue={item?.audienceNote ?? ""}
          placeholder={t("web.getStudents.communityAudiencePlaceholder")}
        />
      </div>
      {/* Beside the audience note on purpose: the two answer one question —
          who is in here, and what lands with them. */}
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-meme`}>{t("socialPreview.communityBrief")}</Label>
        <Textarea
          id={`${idPrefix}-meme`}
          name="memeBrief"
          rows={3}
          maxLength={COMMUNITY_MEME_BRIEF_MAX_CHARS}
          defaultValue={item?.memeBrief ?? ""}
          placeholder={t("socialPreview.communityBriefPlaceholder")}
        />
        <p className="text-xs text-muted-foreground">{t("socialPreview.communityBriefHelp")}</p>
      </div>
    </div>
  );
}

/**
 * Adding a community is a rare act; reading the list is the common one. So the
 * form starts folded behind its own button and only unfolds on request —
 * except for a teacher who has none, where the form IS the empty state and
 * there is nothing to push down.
 */
export function AddCommunityPanel({ hasCommunities }: { hasCommunities: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(!hasCommunities);
  const [state, action, pending] = useActionState<MarketingState, FormData>(
    addCommunityAction,
    undefined,
  );

  // Fold away once the community exists — the new card below is the receipt,
  // and a still-filled form reads as "that didn't save".
  useEffect(() => {
    if (state?.ok && hasCommunities) setOpen(false);
  }, [state, hasCommunities]);

  if (!open) {
    return (
      <div>
        <Button type="button" onClick={() => setOpen(true)}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
          {t("web.getStudents.addCommunity")}
        </Button>
        <FormStatus state={state} savedMessage={t("web.getStudents.communityAdded")} />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg" as="h2">
          {t("web.getStudents.addCommunity")}
        </CardTitle>
        {!hasCommunities && (
          <p className="text-sm text-muted-foreground">
            {t("web.getStudents.communitiesEmptyBody")}
          </p>
        )}
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <CommunityFields idPrefix="add" />
          <p className="text-xs text-muted-foreground">
            {t("web.getStudents.communityPolicyHelp")}
          </p>
          <FormStatus state={state} savedMessage={t("web.getStudents.communityAdded")} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? t("web.dashboard.shareGroups.adding") : t("web.getStudents.addCommunity")}
            </Button>
            {hasCommunities && (
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

/** Today's answer for this community, stated once at the top of the card so
 * she never has to open the settings to find out why a post is not due. */
function WindowNotice({ window: w }: { window: CommunityWindow }) {
  const t = useT();
  if (w.allowed) return null;
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        {w.reason === "frequency"
          ? t("web.getStudents.tooSoon", { date: w.nextDateLabel })
          : w.nextDayLabel
            ? t("web.getStudents.notPromoDay", { day: w.nextDayLabel })
            : t("web.getStudents.notPromoDayEver")}
      </span>
    </p>
  );
}

/**
 * One community, read-first.
 *
 * The top of the card is prose she can scan — name, where it is, what its rules
 * allow, whether today is a day she may promote — and the tracked link she came
 * for is one button. Everything that is work rather than reading (writing the
 * post, making the image, changing the settings) folds away behind its own
 * header, each with a one-line summary so the closed state still answers "is
 * there anything here".
 */
export function CommunityCard({
  item,
  bookingUrl,
  window: promoWindow,
  post,
  postSummary,
  // The community's image editor (D-123), passed in from the server page so
  // this client component never loads or knows about preview data.
  preview,
  previewSummary,
}: {
  item: CommunityItem;
  bookingUrl?: string | null;
  window: CommunityWindow;
  post?: React.ReactNode;
  postSummary?: React.ReactNode;
  preview?: React.ReactNode;
  previewSummary?: React.ReactNode;
}) {
  const t = useT();
  const locale = useLocale();
  // The pre-D-125 per-group tagged link, kept exactly as it was. Links posted
  // with it are live in real community feeds and still attribute correctly —
  // lib/marketing/events.ts resolves this slug alongside the newer /g/ codes.
  const taggedUrl = bookingUrl ? shareTaggedUrl(bookingUrl, "facebook", item) : "";
  const ruleChips = describePromotionRules(item.rules, locale);
  const [state, action, pending] = useActionState<MarketingState, FormData>(
    updateCommunityAction,
    undefined,
  );
  const [, archive, archiving] = useActionState<MarketingState, FormData>(
    archiveCommunityAction,
    undefined,
  );

  return (
    <Card className="p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Heading level={4} as="h3" className="min-w-0 break-words">
              {item.name}
            </Heading>
            <Badge variant="outline">{platformLabel(item.platform, locale)}</Badge>
            <Badge variant={POLICY_TONE[item.promoPolicy]}>
              {promoPolicyLabel(item.promoPolicy, locale)}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {t(`web.getStudents.communityPolicyEffect.${item.promoPolicy}`)}
          </p>
          {ruleChips.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {ruleChips.map((chip) => (
                <Badge key={chip} variant="secondary">
                  {chip}
                </Badge>
              ))}
            </div>
          )}
          <WindowNotice window={promoWindow} />
          {item.audienceNote && <p className="text-sm">{item.audienceNote}</p>}
        </div>
        {item.url && (
          <Button asChild variant="ghost" size="sm" className="shrink-0">
            <a href={item.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">{t("web.getStudents.communityOpenLink")}</span>
            </a>
          </Button>
        )}
      </div>

      {/* The link that makes this community's students traceable back to it.
          It is the one thing on the card that is never folded away. */}
      {bookingUrl && (
        <div className="mt-4 space-y-2 rounded-md border bg-muted/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-medium">
              <LinkIcon className="h-4 w-4" aria-hidden="true" />
              {t("web.dashboard.shareGroups.linkForThisGroup")}
            </p>
            <CopyLinkButton value={taggedUrl} />
          </div>
          <p className="text-xs text-muted-foreground">
            {t("web.dashboard.shareGroups.linkForThisGroupHelp")}
          </p>
          <p className="truncate font-mono text-xs text-muted-foreground" title={taggedUrl}>
            {taggedUrl}
          </p>
        </div>
      )}

      {post && (
        <div className="mt-4 border-t pt-4">
          <Collapsible
            title={t("web.getStudents.postSection")}
            defaultOpen={false}
            headerRight={postSummary}
          >
            <p className="text-xs text-muted-foreground">{t("web.getStudents.postSectionHelp")}</p>
            {post}
          </Collapsible>
        </div>
      )}

      {preview && (
        <div className="mt-4 border-t pt-4">
          <Collapsible
            title={t("socialPreview.title")}
            defaultOpen={false}
            headerRight={previewSummary}
          >
            <p className="text-xs text-muted-foreground">{t("socialPreview.subtitle")}</p>
            {preview}
          </Collapsible>
        </div>
      )}

      <div className="mt-4 border-t pt-4">
        <Collapsible title={t("web.getStudents.communityEdit")} defaultOpen={false}>
          <form action={action} className="space-y-4 pt-1">
            <input type="hidden" name="id" value={item.id} />
            <CommunityFields idPrefix={item.id} item={item} />
            <FormStatus state={state} savedMessage={t("web.getStudents.communitySaved")} />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="outline" size="sm" disabled={pending}>
                {pending
                  ? t("web.dashboard.shareGroups.saving")
                  : t("web.getStudents.saveCommunity")}
              </Button>
            </div>
          </form>
          {/* Its own form, below the save row, so it can never read as the
              other half of a Save/Cancel pair. */}
          <form action={archive} className="pt-1">
            <input type="hidden" name="id" value={item.id} />
            <Button type="submit" variant="ghost" size="sm" disabled={archiving}>
              {t("web.getStudents.archive")}
            </Button>
          </form>
        </Collapsible>
      </div>
    </Card>
  );
}

/** Archived communities are history, not work: a quiet row and a way back,
 * rather than the full editor they used to render. */
export function ArchivedCommunityRow({ item }: { item: CommunityItem }) {
  const t = useT();
  const locale = useLocale();
  const [, restore, restoring] = useActionState<MarketingState, FormData>(
    restoreCommunityAction,
    undefined,
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="truncate text-sm text-muted-foreground">{item.name}</span>
        <Badge variant="secondary">{platformLabel(item.platform, locale)}</Badge>
      </div>
      <form action={restore}>
        <input type="hidden" name="id" value={item.id} />
        <Button type="submit" variant="ghost" size="sm" disabled={restoring}>
          {t("web.getStudents.restore")}
        </Button>
      </form>
    </div>
  );
}
