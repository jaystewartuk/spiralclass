import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isSameOrigin } from "@/lib/auth/csrf";

// — capture the student's IANA timezone on first sign-in so the
// portal can render times in their wall clock alongside the teacher's.
// Called client-side once the session is established; fire-and-forget so a
// flaky network never blocks sign-in.
//
// Auth: the better-auth session cookie is required. We resolve the student
// row by `auth_user_id` and refuse if there's no match. The teacher
// dashboard never calls this — teachers' tz is captured at onboarding.

const bodySchema = z.object({
  timezone: z
    .string()
    .min(1)
    .max(64)
    // Lazy IANA shape match. Real validation happens at render via
    // Intl.DateTimeFormat throwing on a bad zone — we just keep crap out
    // of the DB.
    .regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/, "invalid tz shape"),
});

export async function POST(req: NextRequest): Promise<Response> {
  // CSRF: this route authorizes purely via the session cookie, so reject a
  // cross-origin caller before doing any work. See src/lib/auth/csrf.ts.
  if (!isSameOrigin(req)) {
    return NextResponse.json({ ok: false, reason: "cross-origin" }, { status: 403 });
  }

  const json = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, reason: "invalid-body" }, { status: 400 });
  }

  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "no-session" }, { status: 401 });
  }

  const student = await prisma.student.findFirst({
    where: { authUserId: user.id },
    select: { id: true, timezone: true },
  });
  if (!student) {
    return NextResponse.json({ ok: false, reason: "no-student" }, { status: 403 });
  }

  // Only set if missing — capture is a one-shot at first sign-in. A
  // student who later moves can update via a future settings UI; we
  // don't want every login to clobber a manually-set value.
  if (student.timezone) {
    return NextResponse.json({ ok: true, updated: false });
  }

  await prisma.student.update({
    where: { id: student.id },
    data: { timezone: parsed.data.timezone },
  });
  return NextResponse.json({ ok: true, updated: true });
}
