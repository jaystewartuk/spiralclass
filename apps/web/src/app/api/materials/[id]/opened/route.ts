import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { flushAnalytics } from "@/lib/analytics/posthog";
import { trackMaterialEngagement } from "@/lib/library/engagement";

// Fired by the web materials page's client-side open handler (a material
// link click or a native-content <details> expand) — see
// EntryRow/MaterialOpenTracker in (student)/my-classes/materials/page.tsx.
// Cookie-authed like the rest of the student portal; a fire-and-forget POST,
// so an unresolved student/material just no-ops rather than erroring the click.
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const student = await prisma.student.findFirst({
    where: { authUserId: user.id },
    select: { id: true },
  });
  if (!student) return NextResponse.json({ ok: false }, { status: 401 });

  const { id } = await ctx.params;
  const tracked = await trackMaterialEngagement(student.id, id, "opened", "web", undefined);
  await flushAnalytics();
  return NextResponse.json({ ok: tracked });
}
