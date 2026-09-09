import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AppLocale } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { formatMinorUnits } from "@/lib/money";
import { formatDateInZone, toYMD } from "@/lib/tz";
import type { BillingHistoryEntry } from "@/lib/subscriptions/invoices";

// What she has actually paid us.
//
// `subscription_invoices` has been written on every billing cycle since the
// rail shipped and read only by the admin console — the teacher being charged
// had to leave the product for the Stripe portal to answer "what did I pay
// last month". This is her own copy of her own history.
//
// Each row is formatted in the currency THAT charge settled in, not the
// platform's current one: a pre-D-99 subscriber's history is genuinely in MXN,
// and re-denominating it into GBP would invent a number she was never charged.

const STATUS_VARIANT = {
  paid: "success",
  open: "warning",
  failed: "destructive",
  void: "outline",
} as const;

export function BillingHistory({
  entries,
  locale,
  timezone,
  hasPortal,
  t,
}: {
  entries: BillingHistoryEntry[];
  locale: AppLocale;
  timezone: string;
  /** Whether a Stripe Customer Portal exists for this teacher. */
  hasPortal: boolean;
  t: TFunction;
}) {
  if (entries.length === 0) return null;

  const statusLabel = (status: BillingHistoryEntry["status"]) => {
    switch (status) {
      case "paid":
        return t("web.settings.billing.historyPaid");
      case "failed":
        return t("web.settings.billing.historyFailed");
      default:
        return t("web.settings.billing.historyPending");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-h3" as="h2">
          {t("web.settings.billing.historyTitle")}
        </CardTitle>
        <CardDescription>{t("web.settings.billing.historyDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Table>
          <caption className="sr-only">{t("web.settings.billing.historyDescription")}</caption>
          <TableHeader>
            <TableRow>
              <TableHead>{t("web.settings.billing.historyDate")}</TableHead>
              {/* The period is context for the date, not a second date to scan,
                  so it only earns a column once there is room for one. */}
              <TableHead className="hidden sm:table-cell">
                {t("web.settings.billing.historyPeriod")}
              </TableHead>
              <TableHead className="text-right">
                {t("web.settings.billing.historyAmount")}
              </TableHead>
              <TableHead className="text-right">
                {t("web.settings.billing.historyStatus")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => {
              // The charge date when there is one; otherwise the period it
              // covers, which is the only date an unpaid invoice has.
              const shown = entry.paidAt ?? entry.periodStart;
              return (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap font-medium">
                    <time dateTime={toYMD(shown, timezone)}>
                      {formatDateInZone(shown, timezone, locale)}
                    </time>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">
                    {t("web.settings.billing.historyRange", {
                      start: formatDateInZone(entry.periodStart, timezone, locale),
                      end: formatDateInZone(entry.periodEnd, timezone, locale),
                    })}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMinorUnits(entry.amountMinorUnits, entry.currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant={STATUS_VARIANT[entry.status]}>
                      {statusLabel(entry.status)}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {/* Only pointed at the portal when there is one. A subscription
            recorded by an admin from a Wise transfer has invoices here and no
            Stripe customer, so this note would be sending her to a door that
            does not open for her. */}
        {hasPortal && (
          <p className="text-xs text-muted-foreground">{t("web.settings.billing.historyNote")}</p>
        )}
      </CardContent>
    </Card>
  );
}
