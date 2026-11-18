import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";

// Classic-runtime JSX under vitest's esbuild (same shim as
// tests/students/student-detail-shell.test.ts).
(globalThis as Record<string, unknown>).React = React;

// WHAT THIS GUARDS. A teacher on Farid's page pressed "All classes" and got
// every student's classes: the link went to the bare past list, and the list
// had no way to narrow to one student. The link now carries `?student=`, and
// the page narrows the list to that student, but only after finding the
// student on this teacher's roster.

const TEACHER = { id: "t1", timezone: "America/Mexico_City" };
const FARID = "5f0c2a1e-7b3d-4c8e-9a6f-1d2e3f4a5b6c";
const NOT_ON_ROSTER = "0a0b0c0d-1e2f-4a5b-8c6d-7e8f9a0b1c2d";

vi.mock("@/lib/auth", () => ({ requireOnboardedTeacher: async () => TEACHER }));
vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: async () => "es",
  getT: async () => createT("es"),
}));
vi.mock("@/lib/clock-change-shifts", () => ({
  loadTeacherListClockShifts: async () => new Map(),
}));

const findManyCalls: { where: Record<string, unknown> }[] = [];
const rosterLookups: unknown[] = [];

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherStudent: {
      findUnique: async (args: {
        where: { teacherId_studentId: { teacherId: string; studentId: string } };
      }) => {
        rosterLookups.push(args.where);
        const { teacherId, studentId } = args.where.teacherId_studentId;
        return teacherId === "t1" && studentId === FARID ? { student: { name: " Farid " } } : null;
      },
    },
    booking: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        findManyCalls.push(args);
        return [];
      },
      count: async () => 0,
    },
  },
}));

const { default: TeacherClassesPage } = await import("@/app/(app)/dashboard/classes/page");

async function render(sp: Record<string, string>): Promise<string> {
  const el = await TeacherClassesPage({ searchParams: Promise.resolve(sp) });
  return renderToStaticMarkup(el);
}

/** The roster list's query: the first findMany the page issues. */
const listWhere = () => findManyCalls[0]?.where;

beforeEach(() => {
  findManyCalls.length = 0;
  rosterLookups.length = 0;
});

describe("the class list narrowed to one student", () => {
  it("lists only that student's classes, and names them", async () => {
    const out = await render({ show: "past", student: FARID });

    expect(listWhere()).toMatchObject({ teacherId: "t1", studentId: FARID });
    expect(out).toContain("Clases con Farid");
    // The way back to everyone keeps the view she is on.
    expect(out).toContain('href="/dashboard/classes?show=past"');
  });

  it("keeps the student when she switches view", async () => {
    const out = await render({ show: "past", student: FARID });
    expect(out).toContain(`href="/dashboard/classes?student=${FARID}"`);
    expect(out).toContain(`href="/dashboard/classes?show=materials&amp;student=${FARID}"`);
  });

  it("checks the id against this teacher's roster before filtering by it", async () => {
    const out = await render({ show: "past", student: NOT_ON_ROSTER });

    expect(rosterLookups).toEqual([
      { teacherId_studentId: { teacherId: "t1", studentId: NOT_ON_ROSTER } },
    ]);
    // Not her student: the whole list, rather than an empty one that reads
    // like lost history, and no name for a student she does not have.
    expect(listWhere()).not.toHaveProperty("studentId");
    expect(out).not.toContain("Clases con");
  });

  it("ignores a value that is not a student id at all", async () => {
    await render({ show: "past", student: "Farid" });
    expect(rosterLookups).toHaveLength(0);
    expect(listWhere()).not.toHaveProperty("studentId");
  });

  it("says when that student has no classes in this view", async () => {
    const out = await render({ show: "past", student: FARID });
    expect(out).toContain("Sin clases para «Farid»");
    expect(out).toContain("Todos los alumnos");
  });
});
