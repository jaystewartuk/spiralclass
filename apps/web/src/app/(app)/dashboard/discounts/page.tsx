import { Tag } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PageShell } from "@/components/ui/page-shell";
import { StatCard } from "@/components/ui/stat";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { formatMinorUnits } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { publicUrl } from "@/lib/public-url";
import {
  NO_TOTALS,
  compareForList,
  discountState,
  totalsByCode,
  totalsByCurrency,
  type RedemptionFact,
} from "@/lib/discounts/status";
import { CreateDiscountForm } from "./discount-forms";
import { DiscountGroup, type DiscountRow, type ListContext } from "./discount-list";

// The teacher's own promo codes (slice 2a). Codes are teacher-funded — the
// discount is simply a lower charge — so there is no money to grant and nothing
// to reconcile; what there IS, and what this screen exists to show, is what
// each code has cost her and whether it still works.
//
// THE SHAPE FOLLOWS THE STATE, because the two states ask opposite questions.
// With no codes the screen is "what is this for, and make me one" — one column,
// the form in the middle of it. With codes it is "is my promo working, and what
// do I send" — the list leads, the form moves to a rail beside it. The old
// screen had one layout for both, which meant the create form permanently
// occupied the top of a page whose actual content was underneath it.

export default async function DiscountsPage() {
  const teacher = await requireOnboardedTeacher();
  const [t, locale] = await Promise.all([getT(), getPreferredLocale()]);
  const now = new Date();

  const [codes, redemptions] = await Promise.all([
    prisma.discountCode.findMany({
      where: { teacherId: teacher.id, origin: "promo" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        code: true,
        kind: true,
        percentBps: true,
        amountMinorUnits: true,
        currency: true,
        active: true,
        maxRedemptions: true,
        perStudentLimit: true,
        expiresAt: true,
        createdAt: true,
      },
    }),
    // The redemptions themselves rather than a `_count` on each code: the count
    // was all the old page could get out of a sub-select, and the row that was
    // being counted carries the two facts worth reading — what the discount
    // took off, and what the student paid anyway. One extra query for both,
    // folded in a pure function (lib/discounts/status.ts) rather than in here.
    //
    // The filter is the CHECKOUT's definition of a spent use — a redemption
    // counts while its purchase is pending or active, so a refund frees it —
    // and must stay identical to resolveAndValidateDiscount's, or the dashboard
    // and the till disagree about whether a capped code has room.
    prisma.discountRedemption.findMany({
      where: {
        teacherId: teacher.id,
        discountCode: { origin: "promo" },
        package: { status: { in: ["pending", "active"] } },
      },
      select: {
        discountCodeId: true,
        amountMinorUnits: true,
        currency: true,
        payment: { select: { status: true, amountMinorUnits: true, currency: true } },
      },
    }),
  ]);

  const facts: RedemptionFact[] = redemptions.map((r) => ({
    discountCodeId: r.discountCodeId,
    amountMinorUnits: r.amountMinorUnits,
    currency: r.currency,
    // Only settled money counts as a sale: the manual-transfer rail creates the
    // package the moment the student commits, long before anything arrives.
    paidMinorUnits: r.payment?.status === "paid" ? r.payment.amountMinorUnits : null,
    paidCurrency: r.payment?.status === "paid" ? r.payment.currency : null,
  }));
  const perCode = totalsByCode(facts);

  const rows: DiscountRow[] = codes
    .map((c) => {
      const totals = perCode.get(c.id) ?? NO_TOTALS;
      return {
        ...c,
        kind: c.kind as "percent" | "fixed",
        totals,
        state: discountState({ ...c, usedCount: totals.used }, now),
      };
    })
    .sort(compareForList);

  const live = rows.filter((r) => r.state === "live");
  const inactive = rows.filter((r) => r.state !== "live");
  const money = totalsByCurrency(facts);
  // Settled money only, and only where there is some: an unconfirmed transfer
  // is a use spent, not a sale made.
  const sales = money
    .filter((m) => m.salesMinorUnits > 0)
    .map((m) => formatMinorUnits(m.salesMinorUnits, m.currency));

  const ctx: ListContext = {
    t,
    locale,
    now,
    // Absolute, and against APP_URL rather than the request origin — the point
    // of the button is that the link survives being pasted into WhatsApp.
    // `/buy` and not the landing page: `?ref=` is read by the checkout, which
    // is where it opens the discount box and fills the code in.
    checkoutBase: publicUrl(`/b/${encodeURIComponent(teacher.bookingSlug)}/buy`).toString(),
  };

  const header = (
    <PageHeader
      title={t("web.dashboard.discounts.title")}
      description={t("web.dashboard.discounts.subtitle")}
    />
  );

  const createCard = (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="text-lg">
          {t("web.dashboard.discounts.newCode")}
        </CardTitle>
        <CardDescription>{t("web.dashboard.discounts.newCodeDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <CreateDiscountForm />
      </CardContent>
    </Card>
  );

  const howCard = (
    <Card>
      <CardHeader>
        <CardTitle as="h2" className="text-lg">
          {t("web.dashboard.discounts.howTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="text-muted-foreground list-disc space-y-2 pl-5 text-sm">
          <li>{t("web.dashboard.discounts.howType")}</li>
          <li>{t("web.dashboard.discounts.howLink")}</li>
          <li>{t("web.dashboard.discounts.howCost")}</li>
          <li>{t("web.dashboard.discounts.howRefund")}</li>
        </ul>
      </CardContent>
    </Card>
  );

  // Nothing yet: one column, and the form is the page rather than a rail beside
  // an empty list. The three lines above it are the only place this product
  // ever explains what a discount code is FOR — a teacher who has never made
  // one is exactly the reader who needs that, and she is on this screen once.
  if (rows.length === 0) {
    return (
      <PageShell width="reading">
        {header}
        <Card>
          <CardContent className="space-y-4 py-8">
            <div className="flex items-start gap-3">
              <Tag className="text-muted-foreground/40 mt-0.5 h-8 w-8 shrink-0" aria-hidden />
              <div className="space-y-1">
                <p className="font-bold">{t("web.dashboard.discounts.emptyTitle")}</p>
                <p className="text-muted-foreground text-sm">
                  {t("web.dashboard.discounts.emptyBody")}
                </p>
              </div>
            </div>
            <ul className="text-muted-foreground list-disc space-y-2 pl-5 text-sm">
              <li>{t("web.dashboard.discounts.emptyUseWinBack")}</li>
              <li>{t("web.dashboard.discounts.emptyUseQuietWeek")}</li>
              <li>{t("web.dashboard.discounts.emptyUseFirstBuy")}</li>
            </ul>
          </CardContent>
        </Card>
        {createCard}
      </PageShell>
    );
  }

  return (
    <PageShell width="wide">
      {header}

      {/* The numbers appear the moment there is a number — and not before. A
          KPI row reading "1 code · 0 uses · 0.00" on the day she makes her
          first code is furniture that teaches her the page is empty. */}
      {money.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <StatCard label={t("web.dashboard.discounts.summary.liveCodes")} value={live.length} />
          <StatCard
            label={t("web.dashboard.discounts.summary.timesUsed")}
            value={redemptions.length}
          />
          {/* The money needs the whole row on a phone: two counts fit side by
              side, a formatted amount with its ISO code does not. */}
          <div className="col-span-2 sm:col-span-1">
            <StatCard
              label={t("web.dashboard.discounts.summary.givenAway")}
              // One line per currency rather than one total: there is no exchange
              // rate in this codebase, and inventing one to fill a tile would be
              // making up her money. In practice her pricing currency is chosen
              // once at onboarding, so this is one line.
              value={money.map((m) => formatMinorUnits(m.givenMinorUnits, m.currency)).join(" · ")}
              hint={
                sales.length > 0
                  ? t("web.dashboard.discounts.summary.onSales", { amount: sales.join(" · ") })
                  : undefined
              }
            />
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3 lg:items-start">
        <div className="space-y-6 lg:col-span-2">
          <DiscountGroup title={t("web.dashboard.discounts.group.live")} rows={live} ctx={ctx} />
          <DiscountGroup
            title={t("web.dashboard.discounts.group.inactive")}
            rows={inactive}
            ctx={ctx}
            muted
          />
        </div>

        {/* Below the list on a phone, beside it on a desktop: she came to read
            the codes, and making one is the second thing she does here. */}
        <div className="space-y-6">
          {createCard}
          {howCard}
        </div>
      </div>
    </PageShell>
  );
}
