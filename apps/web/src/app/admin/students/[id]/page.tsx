import { Heading } from "@/components/ui/heading";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { notFound } from "next/navigation";
import { requireSuperuser } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryBarChart } from "@/components/ui/chart";
import { notificationStatusChartData } from "@/lib/notifications/chart";
import { StudentModerationForm } from "./moderation-form";
import { StudentEmailForm } from "./email-form";
import { BackLink } from "@/components/back-link";
import { getT } from "@/lib/i18n";

export default async function AdminStudentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSuperuser();
  const { id } = await params;
  const t = await getT();

  const [student, notificationStatusCounts, recentNotifications] = await Promise.all([
    prisma.student.findUnique({
      where: { id },
      include: {
        teacherStudents: {
          include: { teacher: { select: { name: true, email: true, id: true } } },
        },
        _count: { select: { bookings: true, packages: true } },
      },
    }),
    prisma.notification.groupBy({
      by: ["status"],
      where: { recipientType: "student", recipientId: id },
      _count: { _all: true },
    }),
    prisma.notification.findMany({
      where: { recipientType: "student", recipientId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, templateName: true, channel: true, status: true, createdAt: true },
    }),
  ]);
  if (!student) notFound();

  const notificationChartData = notificationStatusChartData(
    Object.fromEntries(notificationStatusCounts.map((s) => [s.status, s._count._all])),
  );

  return (
    <div className="space-y-6">
      <BackLink href="/admin/students" label={t("web.admin.students.title")} />

      <header>
        <PageHeader title={student.name} />
        <p className="text-muted-foreground text-sm">
          {student.email ?? t("web.admin.students.noEmail")} · {student._count.bookings}{" "}
          {t("web.admin.students.bookingsLabel")} · {student._count.packages}{" "}
          {t("web.admin.students.packagesLabel")}
        </p>
        {student.disabledAt && (
          <Alert variant="destructive" className="mt-2">
            <AlertTitle>{t("web.admin.disabledBadge")}</AlertTitle>
            <AlertDescription>
              {t("web.admin.students.disabledSince")}{" "}
              {new Date(student.disabledAt).toLocaleString()}
              {student.disabledReason ? ` · ${student.disabledReason}` : ""}
            </AlertDescription>
          </Alert>
        )}
      </header>

      <StudentModerationForm studentId={student.id} disabled={Boolean(student.disabledAt)} />

      <StudentEmailForm
        studentId={student.id}
        currentEmail={student.email}
        hasLogin={Boolean(student.authUserId)}
      />

      <section className="space-y-2">
        <Heading level={3} as="h2">
          {t("web.admin.students.rostersTitle")}
        </Heading>
        {student.teacherStudents.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("web.admin.none")}</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-md border">
            {student.teacherStudents.map((ts) => (
              <li key={ts.teacherId} className="p-3 text-sm">
                <Link href={`/admin/teachers/${ts.teacher.id}`} className="hover:underline">
                  <div className="font-medium">{ts.teacher.name}</div>
                  <div className="text-muted-foreground text-xs">{ts.teacher.email}</div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t("web.admin.notificationsByStatus")}</CardTitle>
        </CardHeader>
        <CardContent>
          <CategoryBarChart data={notificationChartData} />
        </CardContent>
      </Card>

      <section className="space-y-2">
        <Heading level={3} as="h2">
          {t("web.admin.recentNotifications")}
        </Heading>
        {recentNotifications.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("web.admin.none")}</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-md border">
            {recentNotifications.map((n) => (
              <li key={n.id} className="flex items-center justify-between p-3 text-sm">
                <div>
                  <div className="font-medium">{n.templateName}</div>
                  <div className="text-muted-foreground text-xs">
                    {new Date(n.createdAt).toLocaleString()} · {n.channel}
                  </div>
                </div>
                <Badge variant={n.status === "failed" ? "destructive" : "outline"}>
                  {n.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
