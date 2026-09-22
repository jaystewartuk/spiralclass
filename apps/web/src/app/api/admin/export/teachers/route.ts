import { NextRequest } from "next/server";
import { requireAdmin, getAdminEmails } from "@/lib/admin";
import { buildTeacherWhere } from "@/lib/admin-filters";
import { prisma } from "@/lib/prisma";
import { csvResponse, toCsv } from "@/lib/csv";

const ROW_CAP = 5000;

export async function GET(req: NextRequest) {
  await requireAdmin("finance");

  const url = new URL(req.url);
  const adminEmails = await getAdminEmails();
  const where = buildTeacherWhere(
    {
      q: url.searchParams.get("q"),
      onboarded: url.searchParams.get("onboarded"),
      disabled: url.searchParams.get("disabled"),
      stalled: url.searchParams.get("stalled"),
    },
    adminEmails,
  );

  const teachers = await prisma.teacher.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: ROW_CAP,
    select: {
      id: true,
      email: true,
      name: true,
      timezone: true,
      createdAt: true,
      onboardingCompleteAt: true,
      disabledAt: true,
      disabledReason: true,
      stripeAccountId: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      _count: {
        select: { bookings: true, packages: true, teacherStudents: true },
      },
    },
  });

  const headers = [
    "teacher_id",
    "name",
    "email",
    "timezone",
    "created_at",
    "onboarded_at",
    "disabled_at",
    "disabled_reason",
    "stripe_account_id",
    "stripe_charges_enabled",
    "stripe_payouts_enabled",
    "student_count",
    "package_count",
    "booking_count",
  ];

  const csv = toCsv(
    headers,
    teachers.map((t) => [
      t.id,
      t.name,
      t.email,
      t.timezone,
      t.createdAt,
      t.onboardingCompleteAt,
      t.disabledAt,
      t.disabledReason,
      t.stripeAccountId,
      t.stripeChargesEnabled,
      t.stripePayoutsEnabled,
      t._count.teacherStudents,
      t._count.packages,
      t._count.bookings,
    ]),
  );

  return csvResponse("teachers", csv);
}
