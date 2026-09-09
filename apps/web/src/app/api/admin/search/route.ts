import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { prisma } from "@/lib/prisma";

const RESULT_LIMIT = 5;

// Powers the nav bar's quick-jump: a small, fast lookup across the two
// entities the operator actually needs to jump straight to (teacher/student), not a
// general-purpose search over every admin entity — see the plan's explicit
// scope note on the nav "supercharge."
export async function GET(req: NextRequest) {
  await requireAdmin("support");

  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ teachers: [], students: [] });

  const [teachers, students] = await Promise.all([
    prisma.teacher.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
      take: RESULT_LIMIT,
      select: { id: true, name: true, email: true },
    }),
    prisma.student.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
      take: RESULT_LIMIT,
      select: { id: true, name: true, email: true },
    }),
  ]);

  return NextResponse.json({ teachers, students });
}
