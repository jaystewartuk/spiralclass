import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import type { Teacher } from "@prisma/client";
import { createT } from "@spiralclass/shared";

// Classic-runtime JSX under vitest's esbuild (same shim as
// tests/students/student-detail-shell.test.ts).
(globalThis as Record<string, unknown>).React = React;

// A teacher on one student's Overview pressed "All classes" under Recent
// classes and got every student's classes. The link must name the student
// whose page it is on (tests/classes/student-filter.test.ts covers the list
// that link opens).

const STUDENT = "5f0c2a1e-7b3d-4c8e-9a6f-1d2e3f4a5b6c";
const NOW = new Date("2026-11-18T15:00:00Z");

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findMany: async (args: { where: { scheduledEnd?: { lt?: Date } } }) =>
        args.where.scheduledEnd?.lt
          ? [{ id: "b1", scheduledStart: new Date("2026-11-10T15:00:00Z"), status: "completed" }]
          : [],
    },
    studentNote: { findMany: async () => [] },
    studentLearningProfile: { findUnique: async () => null },
  },
}));
vi.mock("@/app/(app)/dashboard/students/[studentId]/student-notes-form", () => ({
  StudentNotes: () => null,
}));

const { OverviewTab } = await import("@/app/(app)/dashboard/students/[studentId]/tab-overview");

describe("the student Overview's All classes link", () => {
  it("opens that student's past classes, not everyone's", async () => {
    const el = await OverviewTab({
      studentId: STUDENT,
      studentName: "Farid",
      teacher: { id: "t1", timezone: "America/Mexico_City" } as Teacher,
      locale: "es",
      t: createT("es"),
      now: NOW,
      limit: 5,
      studentTimezone: "America/Mexico_City",
      goals: null,
      interests: null,
      levelLabel: null,
      liveBookingId: null,
    });
    const out = renderToStaticMarkup(el);

    const anchor = out.match(/<a[^>]*href="([^"]*)"[^>]*>Todas las clases<\/a>/);
    expect(anchor?.[1]).toBe(`/dashboard/classes?show=past&amp;student=${STUDENT}`);
  });
});
