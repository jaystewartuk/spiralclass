import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { csvResponse, toCsv } from "@/lib/csv";
import {
  PAYMENTS_SCOPE_STATUSES,
  normalizePaymentSearch,
  resolvePaymentsScope,
} from "@/lib/payments-list";

/**
 * The teacher's own payments, as a spreadsheet.
 *
 * Her books are her problem to file, and until now the only export in the
 * product was the operator's cross-tenant one under /admin. This is the same
 * machinery (`toCsv` escapes the formula-injection triggers a name or email
 * can carry) scoped to one teacher by `requireOnboardedTeacher`.
 *
 * It mirrors the screen: whatever view and search the page was showing when
 * she clicked Download is what lands in the file, so what she exports is what
 * she was looking at rather than a second, differently-filtered set she has to
 * reconcile against it.
 *
 * Amounts go out in MINOR UNITS beside their currency code, not as a formatted
 * string. A spreadsheet reading "$1,500.00 MXN" is text, not a number, and
 * cannot be summed; the integer is the value every accounting tool wants, and
 * the currency column is what stops it being ambiguous.
 */

/**
 * Generous enough that no real teacher reaches it — a teacher at ten sales a
 * week is nineteen years in — and low enough that one request cannot pull an
 * unbounded table into memory to build a string (see the note in lib/csv.ts).
 */
const ROW_CAP = 10_000;

export async function GET(req: NextRequest) {
  const teacher = await requireOnboardedTeacher();

  const url = new URL(req.url);
  const scope = resolvePaymentsScope(url.searchParams.get("show") ?? undefined);
  const search = normalizePaymentSearch(url.searchParams.get("q") ?? undefined);
  const statuses = PAYMENTS_SCOPE_STATUSES[scope];

  // Same `AND` composition as the page, for the same reason: tenancy is its
  // own clause and cannot be displaced by a later edit to the search branches.
  const where: Prisma.PaymentWhereInput = {
    AND: [
      { package: { teacherId: teacher.id } },
      ...(statuses ? [{ status: { in: [...statuses] } }] : []),
      ...(search
        ? [
            {
              OR: [
                {
                  package: {
                    student: { name: { contains: search, mode: "insensitive" as const } },
                  },
                },
                {
                  package: {
                    student: { email: { contains: search, mode: "insensitive" as const } },
                  },
                },
                { paymentReference: { contains: search, mode: "insensitive" as const } },
              ],
            },
          ]
        : []),
    ],
  };

  const rows = await prisma.payment.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: ROW_CAP,
    select: {
      id: true,
      createdAt: true,
      status: true,
      provider: true,
      rail: true,
      amountMinorUnits: true,
      currency: true,
      paymentReference: true,
      paidAt: true,
      refundedAt: true,
      confirmedAt: true,
      package: {
        select: {
          classesTotal: true,
          student: { select: { name: true, email: true } },
          template: { select: { name: true } },
        },
      },
    },
  });

  const headers = [
    "payment_id",
    "created_at",
    "student_name",
    "student_email",
    "package",
    "classes",
    "status",
    "method",
    "rail",
    "amount_minor_units",
    "currency",
    "reference",
    "paid_at",
    "confirmed_at",
    "refunded_at",
  ];

  const csv = toCsv(
    headers,
    rows.map((p) => [
      p.id,
      p.createdAt,
      p.package.student.name,
      p.package.student.email,
      p.package.template?.name ?? "",
      p.package.classesTotal,
      p.status,
      p.provider,
      p.rail,
      p.amountMinorUnits,
      p.currency,
      p.paymentReference ?? "",
      p.paidAt,
      p.confirmedAt,
      p.refundedAt,
    ]),
  );

  return csvResponse("payments", csv);
}
