import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, Users } from "lucide-react";
import {
  allowsDirectPromotion,
  eligibleContentKinds,
  promotionWindow,
  weekdayLabels,
  type MarketingContentKind,
  type SocialPreviewView,
} from "@spiralclass/shared";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { requireOnboardedTeacher } from "@/lib/auth";
import { serverEnv, socialPreviewAiEnabled } from "@/lib/env";
import { getT, getPreferredLocale } from "@/lib/i18n";
import { formatZonedDate } from "@/lib/date-display";
import { weekdayInZone } from "@/lib/tz";
import { communityDrafts, lastPromotedAt } from "@/lib/marketing/activities";
import { listCommunities } from "@/lib/marketing/communities";
import { buildTeacherContext, getMarketingProfile } from "@/lib/marketing/profile";
import {
  listSocialPreviewImages,
  listSocialPreviews,
  socialPreviewImageUsage,
  socialPreviewQuota,
} from "@/lib/social-preview/store";
import { loadEntitlements } from "@/lib/subscriptions/service";
import { SectionNav } from "../section-nav";
import { SocialPreviewPanel } from "./social-preview-panel";
import { MemeLibraryPanel, type MemeUsage } from "./meme-library-panel";
import { CommunityPostPanel, CommunityPostSummary } from "./community-post-panel";
import {
  AddCommunityPanel,
  ArchivedCommunityRow,
  CommunityCard,
  type CommunityWindow,
} from "./community-forms";

// The communities editor — the generalised successor to the Facebook-groups
// page (D-125). Same rows, same ids, same per-community social previews
// (D-123): a teacher who had three Facebook groups saved finds them here,
// already tagged as Facebook groups, with their previews intact.
//
// The two surfaces were merged rather than left side by side because they were
// always one decision: "where do I post, and what does my link look like when I
// do".
//
// The layout has one rule: READ FIRST, EDIT ON REQUEST.
//
//   * The page opens on an ANSWER — how many communities she has and what state
//     they are in — and then the communities themselves. Nothing above them
//     except the count and one button, because the previous version put a whole
//     add-community form there and pushed the list she came to read off-screen.
//   * A community is prose — its name, where it is, what its rules let us
//     prepare for it, and whether today is a day she may promote there — plus
//     the tracked link, which is the reason she opened the screen. The three
//     working surfaces (post, image, settings) fold away behind their own
//     headers, each with a summary so a closed one still answers "is there
//     anything here".
//   * Her images live in ONE library section of their own, below the list. That
//     is where they are named and deleted; a community's panel only chooses
//     among them. Repeating the whole library under every community was what
//     made the same eight thumbnails read as four different sets.
export default async function CommunitiesPage() {
  const teacher = await requireOnboardedTeacher();
  const t = await getT();
  const locale = await getPreferredLocale();

  const entitlements = await loadEntitlements(teacher.id);
  const [all, previews, images, imageUsage, quota, drafts, promoted, profile, context] =
    await Promise.all([
      listCommunities(teacher.id, { includeArchived: true }),
      listSocialPreviews(teacher.id),
      listSocialPreviewImages(teacher.id),
      socialPreviewImageUsage(teacher.id),
      socialPreviewQuota(teacher.id, entitlements.isPro),
      communityDrafts(teacher.id),
      lastPromotedAt(teacher.id),
      getMarketingProfile(teacher.id),
      buildTeacherContext(teacher.id),
    ]);

  const aiEnabled = socialPreviewAiEnabled();
  const defaultPreview = previews.find((p) => p.shareGroupId === null) ?? null;
  const previewByCommunity = new Map(
    previews.filter((p) => p.shareGroupId).map((p) => [p.shareGroupId!, p]),
  );
  const bookingUrl = teacher.bookingSlug
    ? `${serverEnv().APP_URL.replace(/\/$/, "")}/b/${teacher.bookingSlug}`
    : null;

  const live = all.filter((c) => !c.archived);
  const archived = all.filter((c) => c.archived);
  const promotable = live.filter((c) => allowsDirectPromotion(c.promoPolicy)).length;

  const memeSettings = { memeBrief: profile.memeBrief, memeStyle: profile.memeStyle };
  const usageRecord: Record<string, MemeUsage> = Object.fromEntries(imageUsage);

  // Decided HERE, on the server, against the teacher's own timezone — the
  // community's rules are about her posting day, so a UTC weekday would tell a
  // teacher west of Greenwich that Monday's window closed on Sunday evening.
  // The card then renders a fact rather than recomputing a clock it cannot
  // agree with the server about.
  const now = new Date();
  const todayWeekday = weekdayInZone(now, teacher.timezone);
  const dayNames = weekdayLabels(locale, "long");
  const windowFor = (community: (typeof live)[number]): CommunityWindow => {
    const result = promotionWindow({
      rules: community.rules,
      weekday: todayWeekday,
      now,
      lastPromotedAt: promoted.get(community.id) ?? null,
    });
    if (result.allowed) return { allowed: true };
    if (result.reason === "frequency") {
      return {
        allowed: false,
        reason: "frequency",
        nextDateLabel: formatZonedDate(result.nextAllowedAt, teacher.timezone, locale),
      };
    }
    return {
      allowed: false,
      reason: "weekday",
      nextDayLabel: result.inDays === null ? null : dayNames[(todayWeekday + result.inDays) % 7],
    };
  };

  // What a folded preview section says about itself: the actual image, or the
  // fact that this one is still the standard card. Scanning the column of
  // chips answers "which of my links look like mine?" without opening any.
  const previewChip = (preview: SocialPreviewView | null) =>
    preview?.image.url ? (
      <span className="relative h-8 w-14 shrink-0 overflow-hidden rounded border">
        <Image
          src={preview.image.url}
          alt=""
          fill
          sizes="56px"
          className="object-cover"
          unoptimized
        />
      </span>
    ) : (
      <span className="shrink-0 text-xs text-muted-foreground">
        {t("socialPreview.standardShort")}
      </span>
    );

  return (
    <PageShell width="default">
      <SectionNav current="communities" />

      <PageHeader
        title={t("web.getStudents.communitiesTitle")}
        description={t("web.getStudents.communitiesSubtitle")}
      />

      {live.length > 0 ? (
        <>
          {/* The count, immediately under the title and above everything else.
              It is the first question the page has to answer, and the previous
              version answered it only by scrolling. */}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span>{t("web.getStudents.communityCount", { count: live.length })}</span>
            <span className="font-normal text-muted-foreground">
              {t("web.getStudents.communitiesPromotable", { count: promotable })}
            </span>
          </p>

          {/* Below the count, above the list: adding is rare, reading is not,
              so it is one button here rather than a form the list has to
              scroll past. */}
          <AddCommunityPanel hasCommunities />

          <section className="space-y-4">
            {live.map((c) => {
              const draft = drafts.get(c.id) ?? null;
              const kinds: MarketingContentKind[] = context
                ? eligibleContentKinds({
                    platform: c.platform,
                    promoPolicy: c.promoPolicy,
                    capabilities: context.capabilities,
                  })
                : [];
              return (
                <CommunityCard
                  key={c.id}
                  item={c}
                  bookingUrl={bookingUrl}
                  window={windowFor(c)}
                  postSummary={<CommunityPostSummary ready={Boolean(draft?.body)} />}
                  post={
                    <CommunityPostPanel
                      communityId={c.id}
                      platform={c.platform}
                      kinds={kinds}
                      communityUrl={c.url}
                      draft={
                        draft
                          ? {
                              id: draft.id,
                              kind: draft.kind,
                              body: draft.body,
                              title: draft.title,
                              angleNote: draft.angleNote,
                              trackedLink: draft.trackedLink,
                              imageUrl: draft.imageUrl,
                              ready: draft.status === "ready",
                            }
                          : null
                      }
                    />
                  }
                  previewSummary={previewChip(previewByCommunity.get(c.id) ?? null)}
                  preview={
                    <SocialPreviewPanel
                      shareGroupId={c.id}
                      preview={previewByCommunity.get(c.id) ?? null}
                      images={images}
                      quota={quota}
                      aiEnabled={aiEnabled}
                      settings={memeSettings}
                      communityBrief={c.memeBrief}
                    />
                  }
                />
              );
            })}
          </section>
        </>
      ) : (
        // No list to push down, so the add form IS the empty state.
        <AddCommunityPanel hasCommunities={false} />
      )}

      {/* Her assets, once, with the operations that belong to an asset rather
          than to a placement: name it, download it, throw it away. */}
      <Panel
        title={t("socialPreview.libraryTitle")}
        description={t("socialPreview.libraryPanelHelp")}
      >
        <MemeLibraryPanel images={images} usage={usageRecord} settings={memeSettings} />
      </Panel>

      {/* The teacher's DEFAULT preview: what an untagged /b/<slug> share uses —
          a WhatsApp broadcast, a bio link, a post with no community tag (D-123).
          A ruled section rather than a Card, and below the list rather than
          above it, because as the second card on the page it read as a
          community named "Default social preview". */}
      <Panel
        title={t("socialPreview.defaultTitle")}
        description={t("socialPreview.defaultSubtitle")}
        actions={previewChip(defaultPreview)}
      >
        <SocialPreviewPanel
          shareGroupId={null}
          preview={defaultPreview}
          images={images}
          quota={quota}
          aiEnabled={aiEnabled}
          settings={memeSettings}
        />
      </Panel>

      {archived.length > 0 && (
        <Panel
          title={t("web.getStudents.archivedCount", { count: archived.length })}
          description={t("web.getStudents.archivedHelp")}
        >
          <div className="space-y-2">
            {archived.map((c) => (
              <ArchivedCommunityRow key={c.id} item={c} />
            ))}
          </div>
        </Panel>
      )}
    </PageShell>
  );
}
