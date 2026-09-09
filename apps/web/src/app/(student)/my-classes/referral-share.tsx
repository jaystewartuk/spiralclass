import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import { getOrCreateReferralCode } from "@/lib/referrals";
import { formatMinorUnits } from "@/lib/money";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyLinkButton } from "@/components/copy-link-button";
import { getT } from "@/lib/i18n";

// Student-facing "refer a friend" surface in the portal (slice 2b). For each
// teacher the student is actively rostered with whose referral program is on,
// show their personal share link (booking page + ?ref=code). The code is minted
// lazily here on first view — same pattern as the iCal feed token.
export async function ReferralShare({ studentIds }: { studentIds: string[] }) {
  const t = await getT();
  const appUrl = serverEnv().APP_URL.replace(/\/$/, "");

  const links = await prisma.teacherStudent.findMany({
    where: {
      studentId: { in: studentIds },
      archivedAt: null,
      teacher: { referralProgram: { enabled: true } },
    },
    select: {
      teacherId: true,
      studentId: true,
      teacher: {
        select: {
          name: true,
          bookingSlug: true,
          referralProgram: {
            select: {
              referredKind: true,
              referredPercentBps: true,
              referredAmountMinorUnits: true,
              currency: true,
            },
          },
        },
      },
    },
  });
  if (links.length === 0) return null;

  // The MOMENT (D-125). A referral ask lands when someone has just had a good
  // experience, and it is noise the rest of the time. The trigger is derived
  // from data we already hold rather than from a new table: a lesson completed
  // in the last two weeks.
  //
  // Deliberately an in-portal prompt rather than an unsolicited email: the
  // platform sending promotional mail to a teacher's students is a consent
  // decision neither of them made, and the teacher gets her own prepared,
  // personal ask through the weekly plan instead.
  const recentLesson = await prisma.booking.findFirst({
    where: {
      studentId: { in: studentIds },
      status: "completed",
      scheduledStart: { gte: new Date(Date.now() - 14 * 86400_000) },
    },
    select: { id: true },
  });
  const isGoodMoment = recentLesson !== null;

  const cards = await Promise.all(
    links.map(async (l) => {
      const code = await getOrCreateReferralCode(prisma, l.teacherId, l.studentId);
      const program = l.teacher.referralProgram!;
      const label =
        program.referredKind === "percent"
          ? `${(program.referredPercentBps ?? 0) / 100}%`
          : formatMinorUnits(program.referredAmountMinorUnits ?? 0, program.currency);
      const url = `${appUrl}/b/${l.teacher.bookingSlug}?ref=${code}`;
      const waText = t("web.studentHome.referral.waText", {
        teacherName: l.teacher.name,
        label,
        url,
      });
      return { teacherId: l.teacherId, teacherName: l.teacher.name, label, url, waText };
    }),
  );

  return (
    <Card className={isGoodMoment ? "border-primary" : undefined}>
      <CardHeader>
        <CardTitle className="text-lg">{t("web.studentHome.referral.title")}</CardTitle>
        <CardDescription>
          {isGoodMoment
            ? t("web.studentHome.referral.momentSubtitle")
            : t("web.studentHome.referral.subtitle")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {cards.map((c) => (
          <div key={c.teacherId} className="space-y-2">
            <p className="text-sm">
              {t("web.studentHome.referral.giveAFriendPrefix")}
              <span className="font-medium">{c.label}</span>
              {t("web.studentHome.referral.offClassesWith", { teacherName: c.teacherName })}
            </p>
            <div className="break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs">
              {c.url}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <CopyLinkButton value={c.url} />
              <Button asChild variant="secondary" size="sm">
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(c.waText)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("onboarding.preview.shareWhatsapp")}
                </a>
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
