import { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { buildPaymentWhere } from "@/lib/admin-filters";
import { prisma } from "@/lib/prisma";
import { csvResponse, toCsv } from "@/lib/csv";

const ROW_CAP = 5000;

export async function GET(req: NextRequest) {
  await requireAdmin("finance");

  const url = new URL(req.url);
  const where = buildPaymentWhere({
    q: url.searchParams.get("q"),
    status: url.searchParams.get("status"),
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
  });

  const rows = await prisma.payment.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: ROW_CAP,
    include: {
      package: {
        select: {
          template: { select: { name: true } },
          teacher: { select: { name: true, email: true } },
          student: { select: { name: true, email: true } },
        },
      },
    },
  });

  const headers = [
    "payment_id",
    "created_at",
    "status",
    "amount_minor_units",
    "currency",
    "rail",
    "provider",
    "provider_payment_id",
    "stripe_checkout_session_id",
    "paid_at",
    "refunded_at",
    "refund_provider_id",
    "teacher_name",
    "teacher_email",
    "student_name",
    "student_email",
    "package_template",
  ];

  const csv = toCsv(
    headers,
    rows.map((p) => [
      p.id,
      p.createdAt,
      p.status,
      p.amountMinorUnits,
      p.currency,
      p.rail,
      p.provider,
      p.providerPaymentId,
      p.stripeCheckoutSessionId,
      p.paidAt,
      p.refundedAt,
      p.refundProviderId,
      p.package.teacher.name,
      p.package.teacher.email,
      p.package.student.name,
      p.package.student.email,
      p.package.template?.name,
    ]),
  );

  return csvResponse("payments", csv);
}
