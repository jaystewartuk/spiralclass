import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createT } from "@spiralclass/shared";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const { teacherSearchRecords, CLASS_WINDOW_FUTURE_DAYS, CLASS_WINDOW_PAST_DAYS } =
  await import("@/lib/search/teacher-records");
const { studentSearchRecords } = await import("@/lib/search/student-records");

// The records half of the site-search index. What these pin:
//  1. Every query is scoped by the caller's own id — the property the whole
//     feature rests on, since the index ships to the browser. (The real-DB
//     version of this, with two tenants, is records.integration.test.ts.)
//  2. The shapes a teacher sees: upcoming classes before past ones, archived
//     rows marked rather than hidden, no "message" shortcut to an archived
//     student, each link aimed at the page that shows that record.

const NOW = new Date("2026-09-30T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function teacherDb() {
  return {
    teacherStudent: {
      findMany: vi.fn(async () => [
        { archivedAt: null, student: { id: "s1", name: "Marco López", email: "ana@x.test" } },
        { archivedAt: new Date(), student: { id: "s2", name: "Old Student", email: null } },
      ]),
    },
    booking: {
      // In the order the query asks for: scheduledStart ascending.
      findMany: vi.fn(async () => [
        {
          id: "b-older",
          scheduledStart: new Date("2026-09-10T15:00:00Z"),
          student: { name: "Marco López" },
          package: { template: null },
        },
        {
          id: "b-past",
          scheduledStart: new Date("2026-09-20T15:00:00Z"),
          student: { name: "Marco López" },
          package: { template: null },
        },
        {
          id: "b-next",
          scheduledStart: new Date("2026-10-02T15:00:00Z"),
          student: { name: "Marco López" },
          package: { template: { name: "8 classes" } },
        },
      ]),
    },
    packageTemplate: {
      findMany: vi.fn(async () => [{ id: "p1", name: "8 classes", subject: "Guitar" }]),
    },
    lead: {
      findMany: vi.fn(async () => [
        { id: "l1", name: "Bea", email: "bea@x.test", status: "contacted" },
        { id: "l2", name: "Cal", email: "cal@x.test", status: "archived" },
      ]),
    },
    libraryMaterial: {
      findMany: vi.fn(async () => [{ id: "m1", label: "Past tense drills", unit: "Unit 3" }]),
    },
  };
}

describe("teacherSearchRecords", () => {
  let db: ReturnType<typeof teacherDb>;
  beforeEach(() => {
    db = teacherDb();
  });

  const run = () =>
    teacherSearchRecords(
      {
        teacher: { id: "t1", timezone: "America/Mexico_City" },
        locale: "en",
        t: createT("en"),
        now: NOW,
      },
      db as unknown as PrismaClient,
    );

  it("scopes every query to the acting teacher", async () => {
    await run();
    for (const model of Object.values(db)) {
      const [args] = model.findMany.mock.calls[0] as unknown as [{ where: { teacherId: string } }];
      expect(args.where.teacherId).toBe("t1");
    }
  });

  it("bounds classes to a window either side of now, and only real ones", async () => {
    await run();
    const [args] = db.booking.findMany.mock.calls[0] as unknown as [
      { where: { status: unknown; scheduledStart: { gte: Date; lte: Date } } },
    ];
    expect(args.where.status).toEqual({ in: ["scheduled", "completed"] });
    expect(args.where.scheduledStart.gte).toEqual(
      new Date(NOW.getTime() - CLASS_WINDOW_PAST_DAYS * DAY),
    );
    expect(args.where.scheduledStart.lte).toEqual(
      new Date(NOW.getTime() + CLASS_WINDOW_FUTURE_DAYS * DAY),
    );
  });

  it("indexes only library materials, never one class's own content", async () => {
    await run();
    const [args] = db.libraryMaterial.findMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ];
    expect(args.where).toMatchObject({ bookingId: null, archived: false });
  });

  it("links a student to her page and offers to message her", async () => {
    const entries = await run();
    expect(entries).toContainEqual(
      expect.objectContaining({
        id: "student.s1",
        kind: "student",
        label: "Marco López",
        detail: "ana@x.test",
        href: "/dashboard/students/s1",
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        id: "message.s1",
        kind: "action",
        label: "Message Marco López",
        href: "/dashboard/messages/s1",
      }),
    );
  });

  it("keeps an archived student findable, marked, and without a message shortcut", async () => {
    const entries = await run();
    expect(entries.find((e) => e.id === "student.s2")?.archived).toBe(true);
    expect(entries.find((e) => e.id === "message.s2")).toBeUndefined();
  });

  it("lists the next class first, then the past from most recent back", async () => {
    const classes = (await run()).filter((e) => e.kind === "class");
    expect(classes.map((c) => c.id)).toEqual(["class.b-next", "class.b-past", "class.b-older"]);
    expect(classes[0]).toMatchObject({
      label: "Class with Marco López",
      href: "/dashboard/classes/b-next",
    });
    // In her own timezone, with the package it came from.
    expect(classes[0]?.detail).toMatch(/^Fri\b.*\b9:00\b.* · 8 classes$/);
  });

  it("sends a package to the packages page and a lead to its own tab, searched", async () => {
    const entries = await run();
    expect(entries.find((e) => e.id === "package.p1")).toMatchObject({
      href: "/settings/templates",
      detail: "Guitar",
    });
    expect(entries.find((e) => e.id === "lead.l1")?.href).toBe("/dashboard/leads?q=Bea");
    expect(entries.find((e) => e.id === "lead.l2")).toMatchObject({
      href: "/dashboard/leads?show=archived&q=Cal",
      archived: true,
    });
  });

  it("sends a material to the library, searched for it across every level", async () => {
    const entries = await run();
    const href = entries.find((e) => e.id === "material.m1")?.href ?? "";
    const url = new URL(href, "https://x.test");
    expect(url.pathname).toBe("/dashboard/materials");
    expect(url.searchParams.get("q")).toBe("Past tense drills");
    expect(url.searchParams.get("level")).toBe("all");
  });
});

describe("studentSearchRecords", () => {
  function studentDb() {
    return {
      student: { findMany: vi.fn(async () => [{ id: "s-other-row" }]) },
      teacherStudent: {
        findMany: vi.fn(async () => [
          { teacher: { id: "t1", name: "Mira" } },
          // The same teacher paired with a second row of the same person.
          { teacher: { id: "t1", name: "Mira" } },
          { teacher: { id: "t2", name: "Noé" } },
        ]),
      },
      booking: {
        findMany: vi.fn(async () => [
          {
            id: "b1",
            scheduledStart: new Date("2026-10-01T15:00:00Z"),
            teacher: { name: "Mira" },
            package: { template: { name: "Trial" } },
          },
        ]),
      },
    };
  }

  const run = (db: ReturnType<typeof studentDb>, timezone: string | null = "Europe/Paris") =>
    studentSearchRecords(
      {
        student: { id: "s1", email: "ana@x.test", timezone },
        locale: "en",
        t: createT("en"),
        now: NOW,
      },
      db as unknown as PrismaClient,
    );

  it("scopes every query to the signed-in identity's own student rows", async () => {
    const db = studentDb();
    await run(db);
    for (const model of [db.teacherStudent, db.booking]) {
      const [args] = model.findMany.mock.calls[0] as unknown as [
        { where: { studentId: { in: string[] } } },
      ];
      expect(args.where.studentId).toEqual({ in: ["s1", "s-other-row"] });
    }
  });

  it("lists each teacher once, with a shortcut to message them", async () => {
    const entries = await run(studentDb());
    expect(entries.filter((e) => e.kind === "teacher").map((e) => e.id)).toEqual([
      "teacher.t1",
      "teacher.t2",
    ]);
    expect(entries.find((e) => e.id === "message.t2")).toMatchObject({
      label: "Message Noé",
      href: "/my-classes/messages/t2",
    });
  });

  it("links a class to the portal's class page, in her own timezone", async () => {
    const entries = await run(studentDb());
    expect(entries.find((e) => e.id === "class.b1")).toMatchObject({
      label: "Class with Mira",
      href: "/my-classes/b1",
    });
    expect(entries.find((e) => e.id === "class.b1")?.detail).toMatch(/17:00|5:00/);
  });

  it("falls back to UTC, never a market's zone, when she has none", async () => {
    const entries = await run(studentDb(), null);
    expect(entries.find((e) => e.id === "class.b1")?.detail).toMatch(/15:00|3:00/);
  });
});
