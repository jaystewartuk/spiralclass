import {
  Banknote,
  BellRing,
  BookOpen,
  CalendarCheck,
  CalendarX2,
  ChevronRight,
  Clock,
  Layers,
  Lightbulb,
  MessageSquare,
  NotebookPen,
  ReceiptText,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatZonedDateTime, formatZonedTime } from "@/lib/date-display";
import type { AppLocale, TFunction } from "@/lib/i18n-translate";
import {
  groupInboxByDay,
  inboxCategoryFor,
  type InboxCategory,
} from "@/lib/notifications/inbox-view";
import { cn } from "@/lib/utils";
import { openNotificationAction } from "./actions";

/**
 * The notifications inbox, as one continuous sequence.
 *
 * WHAT THIS REPLACES, and why each change is a change. Every row used to be
 * the same shape — a two-pixel dot, a title, a body, a timestamp — so a sale
 * and a five-minute class reminder were indistinguishable until both had been
 * read in full. An inbox is scanned rather than read, so that is the one
 * failure it cannot afford. Three things carry the scan now:
 *
 *   - A MARK PER KIND. Fourteen categories over forty-nine templates
 *     (`inboxCategoryFor`), each with its own icon and a tone drawn from the
 *     semantic palette. The question a teacher opens this page with is "is
 *     there money, a class, or a chore in here?", and the mark answers it
 *     before she reads a word. Never hue alone: the icon differs per category
 *     and the title says it in words, which is what D-140 requires.
 *   - A DAY STRUCTURE. Rows are grouped by the calendar day they arrived on,
 *     in the teacher's own zone, under a sticky heading — so the timestamp
 *     column holds nothing but a clock and finally forms a column the eye can
 *     run down. It is `tabular-nums` for the same reason.
 *   - AN UNREAD EDGE, not a dot. A two-pixel dot was the smallest possible
 *     mark for the most important distinction on the page. Unread rows now
 *     carry a full-height rule in the brand hue, a heavier title and a tinted
 *     ground — and, for a reader who gets none of those, a word.
 */

/** Everything a row renders. Narrowed away from `InboxItem` so this file
 * neither knows nor cares how the read-model resolved the copy. */
export type NotificationListItem = {
  id: string;
  templateName: string;
  title: string;
  body: string;
  /** Relative in-app path, or null when the event has no destination. */
  href: string | null;
  createdAt: Date;
  read: boolean;
};

export type NotificationListContext = {
  locale: AppLocale;
  t: TFunction;
  /** The teacher's own zone. She is always the viewer on this screen. */
  timezone: string;
  now: Date;
  /** The view to come back to after opening a row that goes nowhere. */
  returnHref: string;
};

/**
 * How each category is marked.
 *
 * Tone is a GROUPING, not a severity ramp — `sage` covers the kinds where
 * someone has sent her something to look at, `clay` the ones where the product
 * is talking to her about her own account. The icon is what discriminates,
 * which is why categories may share a tone but none share an icon.
 */
const CATEGORY_MARK: Record<InboxCategory, { icon: LucideIcon; className: string }> = {
  payment: { icon: Banknote, className: "bg-success-bg text-success" },
  refund: { icon: ReceiptText, className: "bg-warning-bg text-warning" },
  booking: { icon: CalendarCheck, className: "bg-info-bg text-info" },
  reminder: { icon: Clock, className: "bg-info-bg text-info" },
  cancellation: { icon: CalendarX2, className: "bg-warning-bg text-warning" },
  message: { icon: MessageSquare, className: "bg-clay-bg text-clay" },
  homework: { icon: NotebookPen, className: "bg-sage-bg text-sage" },
  material: { icon: BookOpen, className: "bg-sage-bg text-sage" },
  package: { icon: Layers, className: "bg-warning-bg text-warning" },
  accountReady: { icon: ShieldCheck, className: "bg-success-bg text-success" },
  // The only category that gets the alarm colour, because it is the only one
  // that means she cannot be paid until she does something about it.
  accountAction: { icon: ShieldAlert, className: "bg-destructive-bg text-destructive" },
  subscription: { icon: Sparkles, className: "bg-clay-bg text-clay" },
  growth: { icon: TrendingUp, className: "bg-sage-bg text-sage" },
  insight: { icon: Lightbulb, className: "bg-clay-bg text-clay" },
  general: { icon: BellRing, className: "bg-muted text-muted-foreground" },
};

/**
 * A day heading, sticky under the app bar.
 *
 * `top-14` is not a guess: the app header is `h-14` (see app-nav.tsx), and the
 * class list's own day headings already pin themselves to the same number.
 */
function DayHeading({
  label,
  emphasis,
  first,
}: {
  label: string;
  emphasis: boolean;
  /** The card's own top border and radius stand in for this one's. */
  first: boolean;
}) {
  return (
    // `h2`, because the list carries no heading of its own — the page title
    // above already names the screen. The days are the list's top-level
    // structure, so they take the level.
    <h2
      className={cn(
        // An opaque ground, not a tint: a translucent sticky band lets the
        // rows it is meant to hide show through as they pass underneath.
        "sticky top-14 z-10 border-b bg-muted px-4 py-2 text-sm font-medium text-muted-foreground lg:px-5",
        first ? "rounded-t-lg" : "border-t",
        emphasis && "font-semibold text-foreground",
      )}
    >
      {label}
    </h2>
  );
}

/**
 * One notification.
 *
 * A FORM, not a link, and deliberately so: opening a notification marks it
 * read, which is a write, and a GET that mutates is a row that marks itself
 * read the moment a prefetcher touches it. The cost is real — no middle-click
 * into a new tab — and it is the right way round for a triage surface.
 * Everything else a link would give (keyboard focus, Enter to activate, a
 * 44px target) a submit button gives too.
 *
 * Deliberately no `aria-label`: one would REPLACE the row's content as the
 * accessible name, so a screen-reader user would hear "Open notification" and
 * lose the title, the body and the time — the things the row exists to say.
 */
function NotificationRow({
  item,
  ctx,
}: {
  item: NotificationListItem;
  ctx: NotificationListContext;
}) {
  const { t, locale, timezone } = ctx;
  const mark = CATEGORY_MARK[inboxCategoryFor(item.templateName)];
  const Icon = mark.icon;
  const unread = !item.read;

  return (
    <li className={cn("relative", unread && "bg-primary/5")}>
      {/* The unread edge.
          An OVERLAY, not a `border-l-2` on this element, and the difference is
          not cosmetic: the list's own `divide-border` compiles to a
          `border-color` on `> * ~ *`, which outranks any border colour set on
          the row itself — so a left border rendered grey on every row but the
          first, whether read or unread, and the page's most important
          distinction silently disappeared. Rendered visually only; the word
          "unread" reaches a screen reader from the row body below. */}
      {unread ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary" /> : null}
      <form action={openNotificationAction}>
        <input type="hidden" name="id" value={item.id} />
        <input type="hidden" name="href" value={item.href ?? ""} />
        <input type="hidden" name="return" value={ctx.returnHref} />
        <Button
          type="submit"
          variant="ghost"
          // A row, not a control: full width, left aligned, top aligned, and
          // free to grow with its own copy. The primitive still carries the
          // focus ring, the press state and the minimum touch target.
          className="flex h-auto min-h-target w-full items-start justify-start gap-3 rounded-none px-4 py-3 text-left text-base font-normal whitespace-normal lg:h-auto lg:gap-4 lg:px-5"
        >
          <span
            aria-hidden
            className={cn(
              "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md",
              mark.className,
            )}
          >
            <Icon className="size-5" />
          </span>

          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* Title and clock share a baseline so the times line up down the
                list. The title WRAPS rather than truncating: clipping the one
                line that says what happened is the opposite of what this page
                is for, and D-140 puts legibility above density. */}
            <span className="flex items-baseline justify-between gap-3">
              <span className={cn("min-w-0", unread ? "font-semibold" : "font-normal")}>
                {item.title}
              </span>
              <time
                dateTime={item.createdAt.toISOString()}
                title={formatZonedDateTime(item.createdAt, timezone, locale)}
                className="shrink-0 text-sm text-muted-foreground tabular-nums"
              >
                {formatZonedTime(item.createdAt, timezone, locale)}
              </time>
            </span>
            {item.body ? <span className="text-sm text-muted-foreground">{item.body}</span> : null}
            {/* Unread is carried visually by the edge, the ground and the
                weight — none of which reach a screen reader. This does, and it
                sits last so the row still announces what happened first. */}
            {unread ? <span className="sr-only">{t("web.notifications.unreadMarker")}</span> : null}
          </span>

          {/* Only where there is somewhere to go. A chevron on a row that only
              marks itself read promises a destination that does not exist. */}
          {item.href ? (
            <ChevronRight className="mt-2 size-5 shrink-0 text-muted-foreground" aria-hidden />
          ) : null}
        </Button>
      </form>
    </li>
  );
}

/**
 * The day-grouped list.
 *
 * One `<ul>` per day rather than one flat list: a screen reader announces
 * "list, 4 items" per day, which is the count a sighted reader gets from
 * seeing the group, and the day heading above it is a real heading rather than
 * a row that happens to sit there.
 */
export function NotificationList({
  items,
  ctx,
  /** False when a pager follows the list inside the card, so the last group
   * leaves its corners square and the card's own rule closes it. */
  roundedBottom = true,
}: {
  items: NotificationListItem[];
  ctx: NotificationListContext;
  roundedBottom?: boolean;
}) {
  const groups = groupInboxByDay(items, ctx.timezone, ctx.locale, ctx.now, ctx.t);

  return (
    <div>
      {groups.map((group, index) => (
        // A plain div, not a <section>. A named section becomes a `region`
        // landmark, and ninety of them — one per day in the retention window —
        // would bury the handful that actually orient someone.
        <div key={group.ymd}>
          <DayHeading label={group.label} emphasis={group.relative !== null} first={index === 0} />
          {/* `overflow-hidden` here and not on the card: it clips the last
              row's hover tint to the card's radius, and the sticky heading is
              this list's SIBLING, so nothing that sticks sits inside it. */}
          <ul
            className={cn(
              "divide-y divide-border",
              roundedBottom && index === groups.length - 1 && "overflow-hidden rounded-b-lg",
            )}
          >
            {group.items.map((item) => (
              <NotificationRow key={item.id} item={item} ctx={ctx} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
