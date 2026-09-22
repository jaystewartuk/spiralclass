import { NextResponse } from "next/server";

import { getCurrentTeacher, getCurrentStudent } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildTeacherExport, buildStudentIdentityExport } from "@/lib/account-deletion/export-data";
import { studentComplianceIds } from "@/lib/students/identity";

// Self-serve data export (audit MED-6). Returns the signed-in user's own
// data as a downloadable JSON file. Cookie-authed (web). A teacher gets
// the teacher export; otherwise we fall back to the student export. No
// query params — you can only ever export yourself.
export async function GET(): Promise<Response> {
  const teacher = await getCurrentTeacher();
  if (teacher) {
    // A disabled (moderated / mid-deletion) account can't pull its data,
    // mirroring requireTeacher's moderation guard.
    if (teacher.disabledAt) {
      return NextResponse.json({ ok: false, reason: "account-disabled" }, { status: 403 });
    }
    const envelope = await buildTeacherExport(prisma, teacher.id);
    return downloadJson(envelope, `spiralclass-export-teacher-${teacher.id}.json`);
  }

  const student = await getCurrentStudent();
  if (student) {
    if (student.disabledAt) {
      return NextResponse.json({ ok: false, reason: "account-disabled" }, { status: 403 });
    }
    // The access right covers every row the person's data lives on —
    // same-email siblings included (multi-teacher identity set).
    const envelope = await buildStudentIdentityExport(prisma, await studentComplianceIds(student));
    return downloadJson(envelope, `spiralclass-export-student-${student.id}.json`);
  }

  return NextResponse.json({ ok: false, reason: "no-session" }, { status: 401 });
}

function downloadJson(envelope: unknown, filename: string): Response {
  if (!envelope) {
    return NextResponse.json({ ok: false, reason: "not-found" }, { status: 404 });
  }
  return new NextResponse(JSON.stringify(envelope, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Never cache a personal data export at any hop.
      "Cache-Control": "no-store, private",
    },
  });
}
