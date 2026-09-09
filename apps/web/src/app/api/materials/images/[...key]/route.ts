import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { ImageViewer } from "@/lib/materials/image-access";
import { imageKeyFromSegments, serveMaterialImage } from "@/lib/materials/image-serve";

// Serves an image embedded in a material body (`material-image:<key>`) —
// cookie-authed, like the rest of the dashboard and the student portal. The
// access rule and the not-found discipline live in lib/materials/image-serve.ts
// rather than here; that split exists because a sibling route once had to
// answer identically, and survives it.
//
// The viewer may be either role, so both are tried: a teacher sees her own
// images, a student sees the images of any teacher on whose roster they sit
// (see lib/materials/image-access.ts for why the check is teacher-scoped).

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const user = await getAuthUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "no-session" }, { status: 401 });
  }

  const { key: segments } = await ctx.params;

  const teacher = await prisma.teacher.findUnique({
    where: { id: user.id },
    select: { id: true },
  });
  let viewer: ImageViewer | null = teacher ? { kind: "teacher", teacherId: teacher.id } : null;
  if (!viewer) {
    const student = await prisma.student.findFirst({
      where: { authUserId: user.id, disabledAt: null },
      select: { id: true, email: true },
    });
    if (student) viewer = { kind: "student", studentId: student.id, email: student.email };
  }

  return serveMaterialImage(imageKeyFromSegments(segments), viewer);
}
