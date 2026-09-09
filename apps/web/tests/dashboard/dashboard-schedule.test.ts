import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";

// The page's JSX compiles to the classic runtime (React.createElement) under
// vitest's esbuild; the web suite otherwise never renders components, so make
// React available globally before the page module evaluates.
(globalThis as Record<string, unknown>).React = React;

// The dashboard leads on the teacher's schedule. Before this it held NO
// temporal information at all — the screen a teacher opens at 8am could not
// tell her what was on today — and its first card was a URL to copy.
//
// What this file pins:
//   * the soonest class is rendered, in HER zone, and it is the one marked
//     "next up";
//   * a student in a different zone gets the second clock, and one in the same
//     zone does not (an identical second time on every row is noise);
//   * the week-ahead count is surfaced;
//   * an empty schedule renders the empty state rather than an empty card, and
//     says something different to a teacher who has never had a student.

const TEACHER: Record<string, unknown> = {
  id: "t1",
  name: "Mira",
  timezone: "America/Mexico_City",
  bookingSlug: "mira",
  onboardingCompleteAt: new Date("2026-01-01"),
  photoPath: "teachers/t1/photo.jpg",
  bio: "Profesora de inglés.",
  templatesTouchedAt: new Date("2026-01-01"),
  availabilityTouchedAt: new Date("2026-01-01"),
  dashboardTileOrder: null,
  stripeAccountId: "acct_1",
  stripeChargesEnabled: true,
  pricingCurrency: "MXN",
  country: "GB",
};

type UpcomingRow = {
  id: string;
  scheduledStart: Date;
  student: { name: string; timezone: string | null };
  package: { classDurationMin: number | null; template: { name: string } | null } | null;
};

let upcoming: UpcomingRow[] = [];
let weekAhead = 0;
let studentCount = 1;

// 2026-09-01 20:00Z is 14:00 in Mexico City — comfortably mid-afternoon, so
// "today" is unambiguous on both sides of the date line for these fixtures.
const NOW = new Date("2026-09-01T20:00:00.000Z");

vi.mock("@/lib/auth", () => ({ requireOnboardedTeacher: async () => TEACHER }));
vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: async () => "en",
  getT: async () => createT("en"),
}));
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ APP_URL: "https://app.test" }),
  hasStripeCreds: () => true,
}));
vi.mock("@/lib/cashflow", () => ({
  computeTeacherCashFlow: async () => ({
    primary: { totalPaidCents: 0 },
    byCurrency: [{ totalPaidCents: 0 }],
  }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherPayoutInstrument: { findMany: async () => [] },
    teacher: {
      findUnique: async () => ({
        _count: { teacherStudents: studentCount, bookings: studentCount },
      }),
    },
    lead: { count: async () => 0 },
    testimonial: { count: async () => 0 },
    booking: { findMany: async () => upcoming, count: async () => weekAhead },
  },
}));

vi.mock("@/components/cashflow-summary", () => ({ SafeToSpendTile: () => null }));
vi.mock("@/components/copy-link-button", () => ({ CopyLinkButton: () => null }));
vi.mock("@/components/growth-checklist", () => ({ GrowthChecklist: () => null }));

const { default: DashboardPage } = await import("@/app/(app)/dashboard/page");

// D-142 split the dashboard into a data page and a presentational
// <DashboardView>, so the page returns an element whose type is itself an
// async component — renderToStaticMarkup cannot await one. Resolving that
// extra level keeps these assertions on the real rendered output.
//
// The page reads `new Date()` for its own `now`; pinning the system clock is
// what makes "Today" and the wall-clock times deterministic here.
async function html(): Promise<string> {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  try {
    const el = (await DashboardPage()) as React.ReactElement;
    const View = el.type as (props: unknown) => Promise<React.ReactElement>;
    return renderToStaticMarkup(await View(el.props));
  } finally {
    vi.useRealTimers();
  }
}

function row(over: Partial<UpcomingRow> & { id: string; scheduledStart: Date }): UpcomingRow {
  return {
    student: { name: "María González", timezone: "America/Mexico_City" },
    package: { classDurationMin: 50, template: { name: "Conversation" } },
    ...over,
  };
}

describe("teacher dashboard — the schedule leads the page", () => {
  it("renders the soonest class in the teacher's own zone and marks it next up", async () => {
    studentCount = 1;
    weekAhead = 4;
    upcoming = [
      row({ id: "b1", scheduledStart: new Date("2026-09-01T22:00:00.000Z") }),
      row({
        id: "b2",
        scheduledStart: new Date("2026-09-02T15:00:00.000Z"),
        student: { name: "Diego Ruiz", timezone: "America/Mexico_City" },
      }),
    ];

    const out = await html();

    expect(out).toContain("Your schedule");
    expect(out).toContain("Next up");
    // 22:00Z is 16:00 in Mexico City — the TEACHER's clock, which is the whole
    // point of rendering her as the dual-zone "viewer".
    // 4, not 04 — the hour carries no leading zero in a 12-hour locale (packages/shared/src/time-format.ts).
    expect(out).toContain("4:00 PM");
    expect(out).toContain("María González");
    expect(out).toContain("Diego Ruiz");
    expect(out).toContain("Conversation");
    expect(out).toContain("50 min");
    // Each row links to its own class, so the schedule is a way IN, not just a
    // readout.
    expect(out).toContain("/dashboard/classes/b1");
    expect(out).toContain("/dashboard/classes/b2");
    // The zone is named as a place, not as the raw IANA id it is stored as.
    expect(out).toContain("Times shown in Mexico City.");
    expect(out).not.toContain("America/Mexico_City");
  });

  it("names the week ahead so the card says more than the four rows it shows", async () => {
    studentCount = 1;
    weekAhead = 9;
    upcoming = [row({ id: "b1", scheduledStart: new Date("2026-09-01T22:00:00.000Z") })];

    expect(await html()).toContain("9 classes in the next 7 days");
  });

  it("uses the singular when exactly one class falls in the week", async () => {
    studentCount = 1;
    weekAhead = 1;
    upcoming = [row({ id: "b1", scheduledStart: new Date("2026-09-01T22:00:00.000Z") })];

    const out = await html();
    expect(out).toContain("1 class in the next 7 days");
    expect(out).not.toContain("1 classes in the next 7 days");
  });

  it("adds the student's own clock only when the two zones actually disagree", async () => {
    studentCount = 1;
    weekAhead = 2;
    upcoming = [
      // Same zone as the teacher — a second identical time here would be noise
      // that trains the eye to skip the line on the row where it matters.
      row({ id: "b1", scheduledStart: new Date("2026-09-01T22:00:00.000Z") }),
      row({
        id: "b2",
        scheduledStart: new Date("2026-09-01T23:00:00.000Z"),
        student: { name: "Tom Whitfield", timezone: "Europe/London" },
      }),
    ];

    const out = await html();
    expect(out).toContain("Tom Whitfield&#x27;s time");
    expect(out).not.toContain("María González&#x27;s time");
  });

  it("survives a class with no package template or duration", async () => {
    studentCount = 1;
    weekAhead = 1;
    upcoming = [
      row({ id: "b1", scheduledStart: new Date("2026-09-01T22:00:00.000Z"), package: null }),
    ];

    const out = await html();
    expect(out).toContain("María González");
    // 4, not 04 — the hour carries no leading zero in a 12-hour locale (packages/shared/src/time-format.ts).
    expect(out).toContain("4:00 PM");
  });

  it("shows an empty state rather than an empty card when nothing is scheduled", async () => {
    studentCount = 1;
    weekAhead = 0;
    upcoming = [];

    const out = await html();
    expect(out).toContain("Nothing scheduled");
    expect(out).toContain("the moment a student books one");
    expect(out).not.toContain("Next up");
    // No classes means no week-ahead badge either — "0 classes in the next 7
    // days" beside "Nothing scheduled" says the same thing twice.
    expect(out).not.toContain("in the next 7 days");
  });

  it("tells a teacher who has never had a student to share her link instead", async () => {
    studentCount = 0; // hasNoActivityYet
    weekAhead = 0;
    upcoming = [];

    const out = await html();
    expect(out).toContain("Share your booking link");
    // And her link leads the main column rather than sitting in the aside —
    // for her, sharing it IS the job, so it comes before the empty schedule.
    expect(out.indexOf("Your booking link")).toBeLessThan(out.indexOf("Nothing scheduled"));
  });
});
