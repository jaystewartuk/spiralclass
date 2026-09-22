import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { bookingPageUrl, isConnectCountrySupported } from "@spiralclass/shared";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { serverEnv } from "@/lib/env";
import { loadEntitlements } from "@/lib/subscriptions/service";
import { TemplatesForm } from "@/app/(app)/onboarding/templates/templates-form";

// Settings → Packages. The teacher's whole offer, on one page: what a student
// can buy, what it costs, and what it costs per class.
//
// Three things the page loads that the editor cannot work out for itself, and
// none of them is decoration:
//
//   * The BOOKING PAGE LINK. This screen decides what strangers see on
//     /b/<slug>, and until now there was no way to go and look.
//   * The PLAN CAP. A Free teacher who adds a fourth package is refused by
//     `gateTemplateSet` AFTER filling the whole card in. The cap comes from
//     the same entitlements resolver the gate uses, so the editor can say so
//     before she types.
//   * SALES PER TEMPLATE. Removing a package archives the template; it does
//     not touch the packages already bought from it. That is the one fact a
//     teacher needs before she removes one, and nothing on the screen said it.
export default async function TemplatesSettingsPage() {
  const teacher = await requireOnboardedTeacher();
  const t = await getT();
  // A teacher outside the Stripe Connect payout circle never gets a Stripe
  // rail — Wise is her only rail (D-58) — so the form drops the "Stripe
  // price" / Wise-discount split for a single plain price. Mirrors the gate
  // in the settings payments page.
  const payoutCountrySupported = isConnectCountrySupported(teacher.country);

  const [templates, entitlements] = await Promise.all([
    prisma.packageTemplate.findMany({
      where: { teacherId: teacher.id, archived: false },
      orderBy: { createdAt: "asc" },
    }),
    loadEntitlements(teacher.id),
  ]);

  // Purchases that still mean something to a student: `pending` is an
  // unconfirmed intent and `refunded` was unwound, so neither is a person who
  // would notice this template disappearing.
  const sales = templates.length
    ? await prisma.package.groupBy({
        by: ["templateId"],
        where: {
          teacherId: teacher.id,
          templateId: { in: templates.map((tpl) => tpl.id) },
          status: { in: ["active", "paused", "expired"] },
        },
        _count: { _all: true },
      })
    : [];
  const soldByTemplateId = Object.fromEntries(
    sales.flatMap((row) => (row.templateId ? [[row.templateId, row._count._all]] : [])),
  );

  // Infinity is how the resolver spells "Pro" — not serializable, and not a
  // number to render, so it becomes the null the editor reads as unlimited.
  const cap = Number.isFinite(entitlements.templateLimit) ? entitlements.templateLimit : null;

  // The one place `${base}/b/${slug}` is built, rather than a tenth inline copy
  // — it also refuses to produce a bare `/b/` from a blank slug.
  const bookingUrl = bookingPageUrl(serverEnv().APP_URL, teacher.bookingSlug);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("settings.templates.title")}
        description={t("web.settings.packages.intro")}
        actions={
          bookingUrl ? (
            <Button asChild variant="outline" size="sm">
              <Link href={bookingUrl} target="_blank" rel="noopener noreferrer">
                {t("web.settings.packages.viewBookingPage")}
                <ExternalLink className="size-4" aria-hidden />
              </Link>
            </Button>
          ) : null
        }
      />

      <TemplatesForm
        initial={templates.map((tpl) => ({
          id: tpl.id,
          name: tpl.name,
          subject: tpl.subject,
          classCount: tpl.classCount,
          singleClass: tpl.singleClass,
          classDurationMin: tpl.classDurationMin,
          priceMinorUnits: tpl.priceMinorUnits,
          transferPriceMinorUnits: tpl.transferPriceMinorUnits,
          expirationMonths: tpl.expirationMonths,
        }))}
        redirectTo="/settings/templates"
        submitLabel={t("settings.templates.save")}
        payoutCountrySupported={payoutCountrySupported}
        stickyActions
        cap={cap}
        soldByTemplateId={soldByTemplateId}
      />
    </div>
  );
}
