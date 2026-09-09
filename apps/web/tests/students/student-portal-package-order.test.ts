import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";

// The page's JSX compiles to the classic runtime under vitest's esbuild; make
// React global before the page module evaluates (same shim as the other
// page-render tests).
(globalThis as Record<string, unknown>).React = React;

// A student's active-package row leads with the TEACHER NAME, not the package
// size ("8 clases / 1 mes"). When a student holds packages with different
// teachers, the teacher is the differentiator, so pin the hierarchy: within
// the row, the teacher name must render above the template name.

vi.mock("@/lib/auth", () => ({
  requireStudent: async () => ({
    id: "s1",
    name: "Alumno UAT",
    email: "uat@test.com",
    timezone: "America/Mexico_City",
  }),
}));
vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: async () => "es-MX",
  getT: async () => createT("es-MX"),
}));
vi.mock("@/lib/students/identity", () => ({ studentIdentityIds: async () => ["s1"] }));
vi.mock("@/lib/booking-day-groups", () => ({ groupBookingsByDay: () => [] }));
vi.mock("@/lib/materials/timing", () => ({ materialSendTimeElapsed: () => false }));
vi.mock("@/lib/date-display", () => ({
  formatBothZones: () => "",
  bookingWhen: () => ({ when: "", whenSecondary: "" }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    package: {
      findMany: async () => [
        {
          id: "pkg-1",
          status: "expired",
          purchasedAt: new Date("2026-06-01T00:00:00.000Z"),
          classesUsed: 8,
          classesTotal: 8,
          expiresAt: new Date("2026-07-01T00:00:00.000Z"),
          template: { name: "8 clases / 1 mes", subject: "Conversación" },
          teacher: { name: "Beatriz Soto", timezone: "America/Mexico_City" },
        },
      ],
    },
    booking: { findMany: async () => [] },
    override: { findMany: async () => [] },
    teacherStudent: { count: async () => 1, findMany: async () => [] },
  },
}));

// Client/leaf components aren't under test here — stub them out.
vi.mock("@/components/booking-card", () => ({ BookingCard: () => null }));
vi.mock("@/components/booking-status-badge", () => ({
  BookingStatusBadge: () => null,
  MaterialsBadge: () => null,
}));
vi.mock("@/app/(student)/my-classes/referral-share", () => ({ ReferralShare: () => null }));

const { default: StudentPortalPage } = await import("@/app/(student)/my-classes/page");

async function html(): Promise<string> {
  const el = await StudentPortalPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(el);
}

describe("student portal — package row hierarchy", () => {
  it("renders the teacher name above the package size within the row", async () => {
    const out = await html();

    expect(out).toContain("Beatriz Soto");
    expect(out).toContain("8 clases / 1 mes");
    // The teacher name also appears in the header greeting, so the ROW
    // occurrence is the last one — it must precede the template name.
    expect(out.lastIndexOf("Beatriz Soto")).toBeLessThan(out.indexOf("8 clases / 1 mes"));
  });

  it("shows the template subject paired with the size on the detail line", async () => {
    const out = await html();
    expect(out).toContain("Conversación · 8 clases / 1 mes");
  });
});
