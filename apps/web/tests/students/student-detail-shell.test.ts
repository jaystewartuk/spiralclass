import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";

// The page's JSX compiles to the classic runtime (React.createElement) under
// vitest's esbuild; the web suite otherwise never renders components, so make
// React available globally before the page module evaluates (same shim as
// tests/legal/terminos-draft-ribbon.test.ts).
(globalThis as Record<string, unknown>).React = React;

// WHAT THIS GUARDS, and why it replaces "section order".
//
// The original complaint was that Alicia Moreno had to scroll to the very bottom of
// a long single-column page to reach Packages, and the guard that came out of
// it pinned Packages above Contact in one continuous stack. The stack is gone:
// the screen is five URL-addressed views with a header that carries the four
// numbers on all of them, so "Packages is above Contact" no longer describes
// anything real.
//
// The complaint underneath it does still describe something real, and it is
// what this file pins now:
//
//   1. the number she was scrolling FOR — classes left — is answered before any
//      view is chosen, in the header,
//   2. Packages is one click away from every view, and ahead of Settings in the
//      nav, and
//   3. the views actually separate: Overview must not be quietly rendering the
//      whole old page.

const TEACHER = {
  id: "t1",
  timezone: "America/Mexico_City",
  country: "MX",
  pricingCurrency: "MXN",
};

vi.mock("@/lib/auth", () => ({ requireOnboardedTeacher: async () => TEACHER }));
vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: async () => "es-MX",
  getT: async () => createT("es-MX"),
}));

const link = {
  levelId: null,
  interests: null,
  goals: null,
  archivedAt: null,
  onboardingHoldAt: null,
  shareProgress: false,
  isMinor: false,
  insightsConsentAt: null,
  guardianConsentAt: null,
  captionsConsentAt: null,
  captionsGuardianConsentAt: null,
  level: null,
  student: {
    id: "s1",
    name: "Mira",
    email: "mira@test.com",
    phoneE164: null,
    authUserId: null,
    notificationPrefs: null,
    timezone: null,
  },
};

// One active package of ten with four already taught and none scheduled, so
// "classes left" has a value the assertions can look for rather than a zero
// that any empty render would also produce.
const activePackage = {
  id: "p1",
  status: "active",
  classesTotal: 10,
  classesUsed: 6,
  classDurationMin: 50,
  pricePaidMinorUnits: 150_000,
  currency: "MXN",
  expiresAt: null,
  purchasedAt: new Date("2026-01-01T00:00:00Z"),
  template: { name: "Paquete de 10" },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teacherStudent: { findUnique: async () => link },
    package: { findMany: async () => [activePackage] },
    booking: {
      findMany: async () => [],
      findFirst: async () => null,
      groupBy: async () => [],
      count: async () => 4,
    },
    payment: { groupBy: async () => [] },
    studentNote: { findMany: async () => [] },
    studentLearningProfile: { findUnique: async () => null },
  },
}));

// The five panels are rendered by their own async components and covered by
// their own tests; here they stand in as markers, which is what lets this file
// assert WHICH one the URL selected without also asserting its contents.
vi.mock("@/app/(app)/dashboard/students/[studentId]/tab-overview", () => ({
  OverviewTab: () => React.createElement("div", { "data-panel": "overview" }),
}));
vi.mock("@/app/(app)/dashboard/students/[studentId]/tab-packages", () => ({
  PackagesTab: () => React.createElement("div", { "data-panel": "packages" }),
}));
vi.mock("@/app/(app)/dashboard/students/[studentId]/tab-learning", () => ({
  LearningTab: () => React.createElement("div", { "data-panel": "learning" }),
}));
vi.mock("@/app/(app)/dashboard/students/[studentId]/tab-materials", () => ({
  MaterialsTab: () => React.createElement("div", { "data-panel": "materials" }),
}));
vi.mock("@/app/(app)/dashboard/students/[studentId]/tab-settings", () => ({
  SettingsTab: () => React.createElement("div", { "data-panel": "settings" }),
}));
vi.mock("@/app/(app)/dashboard/students/[studentId]/go-live-button", () => ({
  GoLiveButton: () => null,
}));
vi.mock("@/components/back-link", () => ({ BackLink: () => null }));

const { default: TeacherStudentDetailPage } =
  await import("@/app/(app)/dashboard/students/[studentId]/page");

async function html(sp: Record<string, string> = {}): Promise<string> {
  const el = await TeacherStudentDetailPage({
    params: Promise.resolve({ studentId: "s1" }),
    searchParams: Promise.resolve(sp),
  });
  return renderToStaticMarkup(el);
}

describe("teacher student detail — the shell above the views", () => {
  it("answers 'how many classes are left' before any view is chosen", async () => {
    const out = await html();
    const glance = out.indexOf("Clases restantes");
    const nav = out.indexOf('aria-label="Vistas de este alumno"');
    expect(glance).toBeGreaterThan(-1);
    expect(nav).toBeGreaterThan(-1);
    // classesTotal 10 − classesUsed 6 + scheduled 0.
    expect(out.slice(glance, glance + 200)).toContain(">4<");
    // Above the tabs, so it is on the screen whichever view is open.
    expect(glance).toBeLessThan(nav);
  });

  it("puts Packages one click from every view, ahead of Settings", async () => {
    const out = await html();
    expect(out).toContain('href="/dashboard/students/s1?tab=packages"');
    expect(out.indexOf("?tab=packages")).toBeLessThan(out.indexOf("?tab=settings"));
  });

  it("marks the current view with aria-current rather than colour alone", async () => {
    const out = await html({ tab: "packages" });
    const anchor = out.match(/<a[^>]*href="\/dashboard\/students\/s1\?tab=packages"[^>]*>/)?.[0];
    expect(anchor).toBeDefined();
    expect(anchor).toContain('aria-current="page"');
    // …and only on that one, so the state is unambiguous to a screen reader.
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("renders exactly the view the URL names", async () => {
    expect(await html()).toContain('data-panel="overview"');
    for (const tab of ["packages", "learning", "materials", "settings"]) {
      const out = await html({ tab });
      expect(out).toContain(`data-panel="${tab}"`);
      expect(out).not.toContain('data-panel="overview"');
    }
  });

  it("falls back to Overview for a tab it does not recognise", async () => {
    // A stale bookmark or a hand-edited URL should still show the teacher her
    // student, never a 404.
    expect(await html({ tab: "contact" })).toContain('data-panel="overview"');
  });

  it("leads with the student, and offers booking without a view switch", async () => {
    const out = await html();
    expect(out).toContain("Mira");
    expect(out).toContain('href="/dashboard/classes/book?studentId=s1"');
    expect(out).toContain('href="/dashboard/messages/s1"');
  });
});
