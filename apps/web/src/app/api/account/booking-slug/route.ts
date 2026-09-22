import { NextResponse } from "next/server";

import { getCurrentTeacher } from "@/lib/auth";
import { checkBookingSlugAvailability } from "@/lib/booking-slug";

// Live availability for the booking-slug editor (Settings → Account and the
// onboarding preview). Cookie-authed; you can only ever check on your own
// behalf, so the current slug used to exempt "is this taken by me" comes from
// the session, never the query string. Advisory only — the save action's
// unique-constraint write is the real gate.
export async function GET(req: Request): Promise<Response> {
  const teacher = await getCurrentTeacher();
  if (!teacher) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }
  const input = new URL(req.url).searchParams.get("slug") ?? "";
  const result = await checkBookingSlugAvailability(teacher.id, teacher.bookingSlug, input);
  return NextResponse.json(result);
}
