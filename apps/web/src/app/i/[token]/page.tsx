import type { Metadata } from "next";
import { getAuthUser } from "@/lib/auth";
import { getInvitationLanding } from "@/lib/invitations/accept";
import { teacherPhotoPublicUrl } from "@/lib/storage/teacher-photo";
import { trackServerEvent, flushAnalytics } from "@/lib/analytics/posthog";
import { prisma } from "@/lib/prisma";
import { hashInvitationToken, isWellFormedInvitationToken } from "@/lib/invitations/token";
import { AcceptInvitationView } from "./accept-invitation";

// Invitation accept landing. Public (no auth gate) — reachable by an invited
// student before they have any account.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  // Token-bearing URL — never index.
  robots: { index: false, follow: false },
};

export default async function InvitationAcceptPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const landing = await getInvitationLanding(token);

  // Fire the funnel `opened` event once per view, keyed on the teacher (the
  // student isn't identified yet). Best-effort — never blocks render.
  if (landing) {
    const teacherId = await teacherIdForToken(token);
    if (teacherId) {
      trackServerEvent({
        name: "invitation_opened",
        distinctId: teacherId,
        properties: { teacherId, channel: "web" },
      });
      await flushAnalytics();
    }
  }

  const user = await getAuthUser();
  const teacherPhotoUrl = landing
    ? teacherPhotoPublicUrl(landing.teacherPhotoPath, landing.teacherPhotoVersion)
    : null;

  const userEmail = user?.email?.trim().toLowerCase() ?? null;
  const invitedEmail = landing?.invitedEmail.toLowerCase() ?? null;
  const emailMatches = userEmail != null && userEmail === invitedEmail;

  return (
    <AcceptInvitationView
      token={token}
      state={landing?.state ?? "invalid"}
      teacherName={landing?.teacherName ?? ""}
      studentName={landing?.studentName ?? null}
      invitedEmail={landing?.invitedEmail ?? ""}
      teacherPhotoUrl={teacherPhotoUrl}
      isAuthed={user != null}
      emailMatches={emailMatches}
    />
  );
}

// A tiny second lookup so the page doesn't have to expose the teacherId through
// the landing DTO just for analytics.
async function teacherIdForToken(rawToken: string): Promise<string | null> {
  if (!isWellFormedInvitationToken(rawToken)) return null;
  const row = await prisma.studentInvitation.findUnique({
    where: { tokenHash: hashInvitationToken(rawToken) },
    select: { teacherId: true },
  });
  return row?.teacherId ?? null;
}
