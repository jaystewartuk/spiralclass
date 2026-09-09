import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import { mintServerSideOtpSession } from "@/lib/auth/server-otp";
import { resolveLinkedStudent } from "@/lib/auth/student-link";
import { logger, correlationIdFrom } from "@/lib/logger";

// Refunds notification auto-login redirect router (D-40). The dispatcher's
// `magic_link` template pushes `/r/ml/<notificationId>` through Meta's
// URL-button variable rule (whole URLs aren't allowed in variables). This
// route resolves the notification, mints a real better-auth session for the
// resolved student server-side (mintServerSideOtpSession — no email round
// trip), and redirects straight into /my-classes with the session cookie set.
//
// Single-use semantics: the planted OTP is consumed immediately in the same
// request. A second click mints and consumes a fresh one.

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ notificationId: string }> },
): Promise<Response> {
  const log = logger({ surface: "r-ml", correlationId: correlationIdFrom(req) });
  const { notificationId } = await ctx.params;
  const env = serverEnv();

  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, templateName: "magic_link" },
    select: {
      id: true,
      teacherId: true,
      recipientId: true,
      recipientType: true,
    },
  });
  if (!notification || notification.recipientType !== "student") {
    return notFoundHtml();
  }

  const student = await prisma.student.findFirst({
    where: {
      id: notification.recipientId,
      teacherStudents: { some: { teacherId: notification.teacherId } },
    },
    select: { email: true },
  });
  if (!student?.email) {
    return notFoundHtml();
  }

  let session: Awaited<ReturnType<typeof mintServerSideOtpSession>>;
  try {
    session = await mintServerSideOtpSession(student.email, req.headers);
  } catch (error) {
    log.warn("mintServerSideOtpSession failed", { error });
    return new NextResponse("sign-in link unavailable", { status: 503 });
  }

  // Link the auth identity to its Student row. This is the whole reason the
  // route exists — and it was missing, which broke every self-serve buyer.
  //
  // Minting a session is NOT the same as being recognized as a student: the
  // Student row created by checkout carries `authUserId: null` until some
  // sign-in path claims it, and only two did (the sign-in action and
  // invitation acceptance). This route was not one of
  // them, so a first-time buyer arrived signed in but role-less:
  // requireStudent() bounced her to `/`, whose CTA sent her to /dashboard,
  // which lazily minted a TEACHER row and started teacher onboarding — and
  // that row then made her permanently unclaimable as a student.
  //
  // Delegated to the shared resolver rather than writing authUserId directly
  // (same reasoning as lib/invitations/accept.ts) so the "oldest unlinked
  // roster row wins" and Teacher/Student mutual-exclusivity rules stay in one
  // place. A `conflict` (this identity already owns a Teacher row) is left to
  // requireStudent to report — the session is legitimately established either
  // way, so this must not 500.
  const authUser = session?.user;
  if (authUser?.id) {
    try {
      const linked = await resolveLinkedStudent({ id: authUser.id, email: authUser.email });
      if (linked.status !== "linked") {
        log.warn("magic-link sign-in did not resolve a student row", {
          notificationId,
          status: linked.status,
        });
      }
    } catch (error) {
      // The session is already valid; requireStudent will retry the link on
      // the next request. Better to land the user signed in than to 500.
      log.error("resolveLinkedStudent failed after magic-link sign-in", error, {
        notificationId,
      });
    }
  }

  const url = new URL("/my-classes", env.APP_URL);
  return NextResponse.redirect(url, { status: 302 });
}

function notFoundHtml(): Response {
  return new NextResponse(
    `<!doctype html><html lang="es-MX"><head><meta charset="utf-8"><title>Enlace expirado</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body><h1>Este enlace ya no funciona</h1><p>Pide a tu profe un nuevo enlace de inicio de sesión.</p></body></html>`,
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
