import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { flushAnalytics } from "@/lib/analytics/posthog";
import { trackMaterialEngagement } from "@/lib/library/engagement";

const bodySchema = z.object({ durationSeconds: z.number().nonnegative().optional() });

// Fired when a material's generated podcast finishes playing to the end
// (the one reliable "finished consuming this" signal today — see the
// <audio onEnded> handler on web). Same auth posture as the opened route.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getAuthUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const student = await prisma.student.findFirst({
    where: { authUserId: user.id },
    select: { id: true },
  });
  if (!student) return NextResponse.json({ ok: false }, { status: 401 });

  const { durationSeconds } = bodySchema.parse(await req.json().catch(() => ({})));
  const { id } = await ctx.params;
  const tracked = await trackMaterialEngagement(
    student.id,
    id,
    "completed",
    "web",
    durationSeconds,
  );
  await flushAnalytics();
  return NextResponse.json({ ok: tracked });
}
