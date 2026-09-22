import { NextResponse } from "next/server";
import { getCurrentTeacher, getCurrentStudent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { studentIdentityIds } from "@/lib/students/identity";
import { classesLeftToTeach } from "@/lib/package-usage";
import type { Package, PackageTemplate } from "@prisma/client";

// Viewer-scoped package details for the reusable PackageDetailsSheet — the
// one endpoint both the student portal and the teacher dashboard fetch from
// when a package summary is clicked. Financial fields (price) only ever
// reach a teacher; a student never sees what they (or their package) cost —
// same boundary the rest of the student portal already keeps.

type PackageWithRelations = Package & {
  template: Pick<PackageTemplate, "name" | "subject"> | null;
  teacher?: { id: string; name: string };
  student?: { id: string; name: string };
  bookings: { id: string }[];
};

function toDetails(pkg: PackageWithRelations, viewer: "teacher" | "student") {
  const base = {
    id: pkg.id,
    templateName: pkg.template?.name ?? null,
    subject: pkg.template?.subject ?? null,
    classesTotal: pkg.classesTotal,
    classesUsed: pkg.classesUsed,
    classesLeftToTeach: classesLeftToTeach({
      classesTotal: pkg.classesTotal,
      classesUsed: pkg.classesUsed,
      scheduled: pkg.bookings.length,
    }),
    status: pkg.status,
    purchasedAt: pkg.purchasedAt.toISOString(),
    expiresAt: pkg.expiresAt?.toISOString() ?? null,
  };

  if (viewer === "teacher") {
    return {
      ...base,
      counterpart: pkg.student ? { ...pkg.student, role: "student" as const } : null,
      price: { amountMinorUnits: pkg.pricePaidMinorUnits, currency: pkg.currency },
    };
  }
  return {
    ...base,
    counterpart: pkg.teacher ? { ...pkg.teacher, role: "teacher" as const } : null,
    price: null,
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const teacher = await getCurrentTeacher();
  if (teacher) {
    const pkg = await prisma.package.findFirst({
      where: { id, teacherId: teacher.id },
      include: {
        template: { select: { name: true, subject: true } },
        student: { select: { id: true, name: true } },
        bookings: { where: { status: "scheduled" }, select: { id: true } },
      },
    });
    if (!pkg) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(toDetails(pkg, "teacher"));
  }

  const student = await getCurrentStudent();
  if (student) {
    const studentIds = await studentIdentityIds(student);
    const pkg = await prisma.package.findFirst({
      where: { id, studentId: { in: studentIds } },
      include: {
        template: { select: { name: true, subject: true } },
        teacher: { select: { id: true, name: true } },
        bookings: { where: { status: "scheduled" }, select: { id: true } },
      },
    });
    if (!pkg) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(toDetails(pkg, "student"));
  }

  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
