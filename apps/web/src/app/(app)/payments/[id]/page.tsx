import { notFound } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import type { TFunction } from "@spiralclass/shared";
import { BackLink } from "@/components/back-link";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatMinorUnits } from "@/lib/money";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RefundForm } from "./refund-form";
import { WiseConfirmForm } from "./wise-confirm-form";
import { PackageDetailsSheet } from "@/components/packages/package-details-sheet";

export default async function PaymentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    refunded?: string;
    error?: string;
    wise_confirmed?: string;
    wise_failed?: string;
  }>;
}) {
  const { id } = await params;
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const t = await getT();
  const sp = await searchParams;

  const payment = await prisma.payment.findFirst({
    where: { id, package: { teacherId: teacher.id } },
    include: {
      package: {
        select: {
          id: true,
          status: true,
          classesUsed: true,
          classesTotal: true,
          student: { select: { id: true, name: true, email: true } },
          template: { select: { name: true } },
        },
      },
    },
  });
  if (!payment) notFound();

  // Stripe: refundable if paid + has a PaymentIntent.
  // Wise refunds happen outside the system (the teacher returns the
  // money in their own Wise app); we don't surface a refund button for
  // Wise. If/when Wise gets a refund API we'll wire it in here.
  const isStripe = payment.provider === "stripe";
  const isWise = payment.provider === "manual_transfer";
  const refundable = isStripe && payment.status === "paid" && Boolean(payment.providerPaymentId);
  const wiseConfirmable = isWise && payment.status === "pending";

  return (
    <PageShell width="reading">
      <BackLink href="/payments" label={t("web.payments.title")} />

      {sp.refunded === "1" && (
        <div className="rounded-md border border-success/30 bg-success-bg px-4 py-3 text-sm text-success">
          {t("web.payments.detail.refundProcessed")}
        </div>
      )}
      {sp.wise_confirmed === "1" && (
        <div className="rounded-md border border-success/30 bg-success-bg px-4 py-3 text-sm text-success">
          {t("web.payments.detail.wiseConfirmed")}
        </div>
      )}
      {sp.wise_failed === "1" && (
        <div className="rounded-md border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning">
          {t("web.payments.detail.wiseFailed")}
        </div>
      )}
      {sp.error && (
        <div className="rounded-md border border-destructive/30 bg-destructive-bg px-4 py-3 text-sm text-destructive">
          {refundError(sp.error, t)}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{payment.package.student.name}</CardTitle>
          <CardDescription>{payment.package.student.email}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <PackageDetailsSheet packageId={payment.package.id} className="-mx-1 space-y-3 px-1 py-1">
            <Row
              label={t("web.payments.detail.package")}
              value={payment.package.template?.name ?? "—"}
            />
            <Row
              label={t("web.payments.detail.packageStatus")}
              value={packageStatusLabel(payment.package.status, t)}
            />
            <Row
              label={t("web.payments.detail.classesUsed")}
              value={`${payment.package.classesUsed} / ${payment.package.classesTotal}`}
            />
          </PackageDetailsSheet>
          <Row
            label={t("web.payments.detail.paymentStatus")}
            value={paymentStatusLabel(payment.status, t)}
          />
          <Row label={t("web.payments.detail.method")} value={providerLabel(payment.provider, t)} />
          <Row label={t("web.payments.detail.rail")} value={payment.rail} />
          <Row
            label={t("web.payments.detail.amount")}
            value={formatMinorUnits(payment.amountMinorUnits, payment.currency)}
          />
          {payment.providerPaymentId && (
            <Row
              label={
                isStripe ? t("web.payments.detail.stripeId") : t("web.payments.detail.providerId")
              }
              value={payment.providerPaymentId}
              mono
            />
          )}
          {payment.paymentReference && (
            <Row
              label={t("web.payments.detail.wiseReference")}
              value={payment.paymentReference}
              mono
            />
          )}
          {payment.confirmedAt && (
            <Row
              label={t("web.payments.detail.confirmed")}
              value={new Intl.DateTimeFormat(en ? "en-US" : "es-MX", {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(payment.confirmedAt)}
            />
          )}
          {payment.refundedAt && (
            <Row
              label={t("web.payments.detail.refunded")}
              value={new Intl.DateTimeFormat(en ? "en-US" : "es-MX", {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(payment.refundedAt)}
            />
          )}
        </CardContent>
      </Card>

      {wiseConfirmable && (
        <WiseConfirmForm paymentId={payment.id} reference={payment.paymentReference} />
      )}

      {refundable && <RefundForm paymentId={payment.id} />}
    </PageShell>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs" : ""}>{value}</span>
    </div>
  );
}

function providerLabel(provider: string, t: TFunction): string {
  switch (provider) {
    case "stripe":
      return t("web.payments.detail.providerStripe");
    case "wise":
      return t("web.payments.detail.providerWise");
    default:
      return provider;
  }
}

function paymentStatusLabel(status: string, t: TFunction): string {
  switch (status) {
    case "pending":
      return t("payment.status.pending");
    case "underpaid":
      return t("web.payments.status.underpaid");
    case "paid":
      return t("payment.status.paid");
    case "failed":
      return t("payment.status.failed");
    case "refunded":
      return t("payment.status.refunded");
    default:
      return status;
  }
}

function packageStatusLabel(status: string, t: TFunction): string {
  switch (status) {
    case "pending":
      return t("package.status.pending");
    case "active":
      return t("package.status.active");
    case "completed":
      return t("web.payments.packageStatus.completed");
    case "expired":
      return t("package.status.expired");
    case "cancelled":
      return t("web.payments.packageStatus.cancelled");
    case "refunded":
      return t("package.status.refunded");
    default:
      return status;
  }
}

function refundError(code: string, t: TFunction): string {
  switch (code) {
    case "no-payment-intent":
      return t("web.payments.detail.error.noPaymentIntent");
    case "not-paid":
      return t("web.payments.detail.error.notPaid");
    case "missing-reason":
      return t("web.payments.detail.error.missingReason");
    case "stripe-error":
      return t("web.payments.detail.error.stripeError");
    case "no-account":
      return t("web.payments.detail.error.noAccount");
    case "missing-payment":
      return t("web.payments.detail.error.missingPayment");
    case "missing-fields":
      return t("web.payments.detail.error.missingFields");
    case "not-wise":
      return t("web.payments.detail.error.notWise");
    case "not-pending":
      return t("web.payments.detail.error.notPending");
    default:
      return t("web.payments.detail.error.generic");
  }
}
