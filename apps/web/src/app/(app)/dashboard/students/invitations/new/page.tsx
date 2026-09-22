import Link from "next/link";
import { PageShell } from "@/components/ui/page-shell";
import { PageHeader } from "@/components/ui/page-header";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { InviteForm, type EligibleStudent } from "./invite-form";

// "Invite students" — single, paste-a-list / CSV, or multi-select from the
// roster, with a confirmation preview before sending.
export const dynamic = "force-dynamic";

export default async function InviteStudentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const teacher = await requireOnboardedTeacher();
  const t = await getT();
  const params = await searchParams;
  const preselectStudent = typeof params.student === "string" ? params.student : null;

  // Roster students eligible to be invited: active link, no login yet, has an
  // email, and no outstanding pending invitation.
  const [links, pending] = await Promise.all([
    prisma.teacherStudent.findMany({
      where: {
        teacherId: teacher.id,
        archivedAt: null,
        student: { authUserId: null, NOT: { email: null } },
      },
      select: { student: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.studentInvitation.findMany({
      where: { teacherId: teacher.id, status: "pending" },
      select: { email: true },
    }),
  ]);
  const pendingEmails = new Set(pending.map((p) => p.email.toLowerCase()));
  const eligible: EligibleStudent[] = links
    .map((l) => l.student)
    .filter((s): s is { id: string; name: string; email: string } => s.email != null)
    .filter((s) => !pendingEmails.has(s.email.toLowerCase()))
    .map((s) => ({ id: s.id, name: s.name, email: s.email }));

  return (
    <PageShell width="reading">
      <header>
        <Link
          href="/dashboard/students/invitations"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {t("web.dashboard.invitations.backToStudents")}
        </Link>
        <PageHeader title={t("web.dashboard.invitations.form.title")} />
        <p className="text-sm text-muted-foreground">
          {t("web.dashboard.invitations.form.description")}
        </p>
      </header>

      <InviteForm eligible={eligible} preselectStudentId={preselectStudent} />
    </PageShell>
  );
}
