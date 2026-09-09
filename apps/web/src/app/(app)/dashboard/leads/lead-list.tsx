import { Clock } from "lucide-react";
import { initialsFrom } from "@spiralclass/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatZonedShortDate } from "@/lib/date-display";
import type { TFunction } from "@/lib/i18n-translate";
import {
  elapsedSince,
  RELATIVE_MAX_DAYS,
  replyUrgency,
  type Elapsed,
  type ReplyUrgency,
} from "@/lib/leads/list";
import type { LeadStatus } from "@/lib/leads/status";
import { cn } from "@/lib/utils";
import { LeadActions } from "./lead-actions";
import { LeadMessage } from "./lead-message";

export type LeadItem = {
  id: string;
  name: string;
  email: string;
  phoneE164: string | null;
  message: string | null;
  status: LeadStatus;
  createdAt: Date;
};

/** Everything a row needs that is the same for every row on the screen. */
export type LeadContext = {
  t: TFunction;
  locale: string;
  timezone: string;
  now: Date;
  /** The reply's subject line, already resolved in the teacher's BOOKING PAGE
   * language rather than her dashboard one — see the page for why. */
  replySubject: string;
};

/**
 * The lifecycle state, as a chip.
 *
 * `new` is the only SOLID one. It is the only state that is a job rather than
 * a record, and on a screen whose whole purpose is "who am I yet to answer"
 * the unanswered chip has to be the one that carries weight. The rest are
 * tinted grounds from the palette — `info` for a conversation in progress,
 * `success` for one that ended in a student, and a plain outline for the
 * archive, which is deliberately the quietest thing on the page.
 */
const STATUS_VARIANT: Record<LeadStatus, "default" | "info" | "success" | "outline"> = {
  new: "default",
  contacted: "info",
  converted: "success",
  archived: "outline",
};

function statusLabel(status: LeadStatus, t: TFunction): string {
  return status === "new"
    ? t("web.dashboard.leads.statusNew")
    : status === "contacted"
      ? t("web.dashboard.leads.statusContacted")
      : status === "converted"
        ? t("web.dashboard.leads.statusConverted")
        : t("web.dashboard.leads.statusArchived");
}

/**
 * When the enquiry arrived, in the shortest true form.
 *
 * Relative up to a week (`elapsedSince` decides the unit), then an actual
 * date — see RELATIVE_MAX_DAYS. Plural selection is the catalog's, via the
 * `count` variable, rather than a hand-rolled `=== 1`: French and Spanish do
 * not agree with English on where the boundaries fall.
 */
function arrivedLabel(elapsed: Elapsed, createdAt: Date, ctx: LeadContext): string {
  const { t, timezone, locale } = ctx;
  if (elapsed.unit === "days" && elapsed.count >= RELATIVE_MAX_DAYS) {
    return formatZonedShortDate(createdAt, timezone, locale);
  }
  if (elapsed.unit === "now") return t("web.dashboard.leads.ageNow");
  if (elapsed.unit === "minutes")
    return t("web.dashboard.leads.ageMinutes", { count: elapsed.count });
  if (elapsed.unit === "hours") return t("web.dashboard.leads.ageHours", { count: elapsed.count });
  return t("web.dashboard.leads.ageDays", { count: elapsed.count });
}

const URGENCY_VARIANT: Record<Exclude<ReplyUrgency, "none">, "warning" | "destructive"> = {
  due: "warning",
  overdue: "destructive",
};

/**
 * How long a message has been sitting unanswered — chosen over an escalating
 * ROW TREATMENT (a tinted background, a coloured left edge) because a badge
 * says the number. "Waiting 4 days" is actionable; a slightly redder row is a
 * feeling, and one that a reader who does not perceive the hue difference
 * never gets at all.
 */
function WaitingBadge({
  elapsed,
  urgency,
  t,
}: {
  elapsed: Elapsed;
  urgency: ReplyUrgency;
  t: TFunction;
}) {
  if (urgency === "none") return null;
  return (
    <Badge variant={URGENCY_VARIANT[urgency]}>
      <Clock className="size-3" aria-hidden />
      {t("web.dashboard.leads.waitingDays", { count: elapsed.count })}
    </Badge>
  );
}

/**
 * One enquiry.
 *
 * THE ADDRESS AND THE PHONE ARE PLAIN TEXT, not links, which is a reversal.
 * They used to be the only way to contact anyone from this screen — a
 * `mailto:` and a `wa.me` disguised as body copy, underlined on hover and so
 * invisible until the pointer happened to cross them, and unreachable to
 * anyone who does not use a pointer at all. The two contact buttons below the
 * row are the affordance now, which leaves these free to be what they are
 * better at: text you can select and copy into whatever you actually use.
 */
export function LeadRow({ lead, ctx }: { lead: LeadItem; ctx: LeadContext }) {
  const { t } = ctx;
  const elapsed = elapsedSince(lead.createdAt, ctx.now);
  const urgency = replyUrgency(lead.status, lead.createdAt, ctx.now);
  const headingId = `lead-${lead.id}`;

  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-3 px-4 py-4 lg:px-6">
      <div className="flex items-start gap-3">
        {/* Decorative: it is the first letters of the name three pixels to its
            right, so a screen reader announcing it would say the name twice. */}
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground"
        >
          {initialsFrom(lead.name, lead.email)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 id={headingId} className="min-w-0 break-words font-semibold">
              {lead.name}
            </h3>
            <Badge variant={STATUS_VARIANT[lead.status]}>{statusLabel(lead.status, t)}</Badge>
            <WaitingBadge elapsed={elapsed} urgency={urgency} t={t} />
          </div>
          <p className="break-words text-sm text-muted-foreground">
            {lead.email}
            {lead.phoneE164 ? ` · ${lead.phoneE164}` : ""}
          </p>
        </div>

        {/* `dateTime` carries the exact instant for anything parsing the page;
            the visible text is the useful approximation. */}
        <time
          dateTime={lead.createdAt.toISOString()}
          className="shrink-0 text-xs text-muted-foreground"
        >
          {arrivedLabel(elapsed, lead.createdAt, ctx)}
        </time>
      </div>

      {lead.message && <LeadMessage message={lead.message} />}

      <LeadActions
        leadId={lead.id}
        status={lead.status}
        name={lead.name}
        email={lead.email}
        phoneE164={lead.phoneE164}
        replySubject={ctx.replySubject}
      />
    </article>
  );
}

/**
 * A titled run of enquiries.
 *
 * The heading is optional because it is only ever earned: on the open view it
 * separates the two halves of the working set and each half's title says what
 * to do with it, but on the converted and archived views the toolbar tab above
 * already names the list, and a card headed "Archived" directly beneath a tab
 * reading "Archived" is the same word twice.
 */
export function LeadGroup({
  title,
  description,
  leads,
  ctx,
  className,
}: {
  title?: string;
  description?: string;
  leads: LeadItem[];
  ctx: LeadContext;
  className?: string;
}) {
  if (leads.length === 0) return null;
  return (
    <Card className={className}>
      {title ? (
        <CardHeader className="pb-3">
          <CardTitle className="text-base" as="h2">
            {title}
          </CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
      ) : null}
      <CardContent className={cn("p-0", title && "border-t")}>
        <ul className="divide-y divide-border">
          {leads.map((lead) => (
            <li key={lead.id}>
              <LeadRow lead={lead} ctx={ctx} />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
