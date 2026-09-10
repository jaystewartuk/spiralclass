import { Heading } from "@/components/ui/heading";
import {
  BellRing,
  BookOpen,
  Languages,
  MessageCircle,
  PencilLine,
  RefreshCw,
  Repeat,
  Sparkles,
  Video,
  type LucideIcon,
} from "lucide-react";
import { includedItemsFor, type IncludedItem } from "@spiralclass/shared";
import { getPublicFunnelT } from "@/lib/i18n";
import { funnelLocaleForSlug } from "@/lib/booking/funnel-locale";
import type { StringKey } from "@/lib/i18n-translate";

// "What's included with every class" — the buyer-reassurance band on the public
// booking page.
//
// This is deliberately NOT the home page's feature grid. That grid sells
// SpiralClass to TEACHERS ("keep ~100% of what you charge", "no marketplace
// commission"), none of which is a student benefit, and pasting it here would
// make the teacher read as a listing on someone else's platform — the exact
// marketplace shape D-24 rejected in favour of amplifying the teacher. What
// belongs here is the same underlying capabilities re-framed as answers to the
// questions a stranger asks before sending money up front: what if I can't make
// it, how do we actually meet, will I forget, what do I get between classes.
//
// Placement rule (see the call site): this renders BELOW the packages card,
// never above it. The purchase path leads; reassurance follows.
//
// Every line here is a public promise, so the two capability-gated items are
// held against their production enablement flags by
// `tests/config/ai-marketing-claims.test.ts`. That guard reads THIS FILE'S
// SOURCE for literal `t("web.bookingLanding.included.<item>.title|body")`
// calls — which is why the key strings below are spelled out per item instead
// of being built from `item` with a template literal. A dynamic key would
// silently render a claim the guard cannot see.
const ITEMS: Record<IncludedItem, { icon: LucideIcon; title: StringKey; body: StringKey }> = {
  continuity: {
    icon: Repeat,
    title: "web.bookingLanding.included.continuity.title",
    body: "web.bookingLanding.included.continuity.body",
  },
  homework: {
    icon: PencilLine,
    title: "web.bookingLanding.included.homework.title",
    body: "web.bookingLanding.included.homework.body",
  },
  vocabulary: {
    icon: Sparkles,
    title: "web.bookingLanding.included.vocabulary.title",
    body: "web.bookingLanding.included.vocabulary.body",
  },
  reschedule: {
    icon: RefreshCw,
    title: "web.bookingLanding.included.reschedule.title",
    body: "web.bookingLanding.included.reschedule.body",
  },
  video: {
    icon: Video,
    title: "web.bookingLanding.included.video.title",
    body: "web.bookingLanding.included.video.body",
  },
  captions: {
    icon: Languages,
    title: "web.bookingLanding.included.captions.title",
    body: "web.bookingLanding.included.captions.body",
  },
  reminders: {
    icon: BellRing,
    title: "web.bookingLanding.included.reminders.title",
    body: "web.bookingLanding.included.reminders.body",
  },
  materials: {
    icon: BookOpen,
    title: "web.bookingLanding.included.materials.title",
    body: "web.bookingLanding.included.materials.body",
  },
  messages: {
    icon: MessageCircle,
    title: "web.bookingLanding.included.messages.title",
    body: "web.bookingLanding.included.messages.body",
  },
};

export async function WhatsIncluded({
  slug,
  teacherName,
  liveCaptions,
  progressSharing,
}: {
  /** The teacher's booking slug — this section renders in HER locale like the
   * rest of the funnel, and `funnelLocaleForSlug` is request-cached, so taking
   * the slug costs no extra query over receiving the locale itself. */
  slug: string;
  teacherName: string;
  /** `liveCaptionsEnabled()` — the flag AND the ASR/translation vendor keys. */
  liveCaptions: boolean;
  /** This teacher's `shareProgressByDefault` — no platform flag behind it. */
  progressSharing: boolean;
}) {
  const t = getPublicFunnelT(await funnelLocaleForSlug(slug));
  const items = includedItemsFor({ liveCaptions, progressSharing });

  return (
    <section className="mt-12 space-y-5">
      <div className="space-y-2 text-center">
        <Heading level={2}>{t("web.bookingLanding.included.title")}</Heading>
        <p className="text-muted-foreground mx-auto max-w-prose text-sm">
          {t("web.bookingLanding.included.subtitle")}
        </p>
      </div>
      <ul className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => {
          const { icon: Icon, title, body } = ITEMS[item];
          return (
            <li key={item} className="bg-card/50 flex gap-3 rounded-2xl border p-4">
              <Icon className="text-primary mt-0.5 h-5 w-5 shrink-0" aria-hidden />
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">{t(title)}</p>
                {/* `name` is interpolated only by some bodies; the others
                    ignore it, which keeps one call shape here. */}
                <p className="text-muted-foreground text-sm">{t(body, { name: teacherName })}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
