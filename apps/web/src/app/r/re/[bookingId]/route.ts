import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverEnv } from "@/lib/env";
import { mintServerSideOtpSession } from "@/lib/auth/server-otp";
import { logger, correlationIdFrom } from "@/lib/logger";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { escapeHtml } from "@/lib/html-escape";

// Rebook redirect router (D-40). When a teacher cancels a class, the
// dispatcher sends the student a `teacher_cancel` (or
// `cancel_gte24h_with_reschedule`) notification whose button points at
// `/r/re/<bookingId>`. This route resolves the canceled booking, finds the
// student, mints a real better-auth session server-side
// (mintServerSideOtpSession — no email round trip), and redirects to
// /my-classes/book?packageId=<packageId> so the student lands on the booking
// page with the right credit pool pre-selected, session cookie already set.
//
// The reschedule page (/my-classes/<id>/reschedule) would immediately
// redirect away for a canceled booking (status ≠ "scheduled"), so we point
// at the book page instead.

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ bookingId: string }> },
): Promise<Response> {
  const log = logger({ surface: "r-re", correlationId: correlationIdFrom(req) });
  const { bookingId } = await ctx.params;
  const env = serverEnv();

  const booking = await prisma.booking.findFirst({
    where: { id: bookingId },
    select: {
      packageId: true,
      student: { select: { email: true } },
    },
  });
  if (!booking || !booking.student.email) {
    return await notFoundHtml();
  }

  try {
    await mintServerSideOtpSession(booking.student.email, req.headers);
  } catch (error) {
    log.warn("mintServerSideOtpSession failed", { error });
    return new NextResponse("sign-in link unavailable", { status: 503 });
  }

  const url = new URL("/my-classes/book", env.APP_URL);
  url.searchParams.set("packageId", booking.packageId);
  return NextResponse.redirect(url, { status: 302 });
}

// See the twin in /r/ml: rendered when the link in the email has stopped
// working, to a reader with no session, in whatever language the request asks
// for.
//
// The link out is its own sentence rather than an <a> spliced into the middle
// of the prose — a sentence wrapped around markup can only be translated by
// translating the markup with it, which is a shape the catalog cannot hold.
async function notFoundHtml(): Promise<Response> {
  const locale = await getPreferredLocale();
  const t = await getT();
  return new NextResponse(
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><title>${escapeHtml(t("web.expiredLink.title"))}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body><h1>${escapeHtml(t("web.expiredLink.heading"))}</h1><p>${escapeHtml(t("web.expiredLink.reschedule"))}</p><p><a href="/my-classes">${escapeHtml(t("web.expiredLink.rescheduleAction"))}</a></p></body></html>`,
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}
