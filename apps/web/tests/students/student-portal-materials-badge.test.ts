import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";

// The student's classes list must show a class "has materials" whenever it has
// ANY material available — from EITHER source:
//   * a library item the teacher attached (the BookingLibraryMaterial join), or
//   * a class-scoped/private material created straight for the class, whether a
//     file/link attachment OR native written content (`body` set).
// Two regressions this pins:
//   1. The list query used to select `materials` only (no `libraryMaterials`),
//      so attaching a library item never lit the badge.
//   2. The `materials` select carried a `where: { body: null }` filter, so a
//      class-scoped CONTENT material never lit the badge — the query must now
//      select every class-scoped material regardless of `body`.

(globalThis as Record<string, unknown>).React = React;

// One mutable booking the mocked prisma serves; each `it` sets it before render.
// `capturedInclude` records the include the page asked prisma for, so we can
// assert the `materials` select no longer filters by `body`.
const state: { booking: Record<string, unknown> } = vi.hoisted(() => ({ booking: {} }));
const capturedInclude: { value: Record<string, unknown> | undefined } = vi.hoisted(() => ({
  value: undefined,
}));

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
// Echo the passed bookings back as a single day group so BookingCard renders.
vi.mock("@/lib/booking-day-groups", () => ({
  groupBookingsByDay: (bookings: unknown[]) => [
    { ymd: "2026-07-20", label: "Día", items: bookings },
  ],
}));
vi.mock("@/lib/date-display", () => ({
  formatBothZones: () => "",
  bookingWhen: () => ({ when: "", whenSecondary: "" }),
}));
// Real materialSendTimeElapsed is used (not mocked): a null sendTiming is
// always-visible, so the gate resolves deterministically without a fake clock.

vi.mock("@/lib/prisma", () => ({
  prisma: {
    package: { findMany: async () => [] },
    booking: {
      findMany: async (args: { include?: Record<string, unknown> }) => {
        capturedInclude.value = args?.include;
        return [state.booking];
      },
    },
    override: { findMany: async () => [] },
    teacherStudent: { count: async () => 1, findMany: async () => [] },
  },
}));

// BookingCard renders its `materials` slot so the real MaterialsBadge below runs.
vi.mock("@/components/booking-card", () => ({
  BookingCard: ({ materials }: { materials: React.ReactNode }) =>
    React.createElement("div", null, materials),
}));
// Capture the hasMaterials prop the page computes, decoupled from i18n copy.
vi.mock("@/components/booking-status-badge", () => ({
  BookingStatusBadge: () => null,
  MaterialsBadge: ({ hasMaterials }: { hasMaterials: boolean }) =>
    React.createElement("span", null, `materials:${String(hasMaterials)}`),
}));
vi.mock("@/app/(student)/my-classes/referral-share", () => ({ ReferralShare: () => null }));

const { default: StudentPortalPage } = await import("@/app/(student)/my-classes/page");

const future = new Date(Date.now() + 7 * 24 * 3_600_000);

function makeBooking(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "b1",
    status: "scheduled",
    scheduledStart: future,
    teacher: { name: "Beatriz Soto", timezone: "America/Mexico_City" },
    package: { classDurationMin: 50, template: { name: "8 clases / 1 mes" } },
    materials: [],
    libraryMaterials: [],
    ...over,
  };
}

async function html(): Promise<string> {
  const el = await StudentPortalPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(el);
}

describe("student portal — has-materials badge", () => {
  it("lights the badge when the teacher attaches an already-created library material", async () => {
    // No booking-scoped upload, only a library attachment (always-visible).
    state.booking = makeBooking({ materials: [], libraryMaterials: [{ sendTiming: null }] });
    expect(await html()).toContain("materials:true");
  });

  it("still lights the badge for a plain class-scoped upload", async () => {
    state.booking = makeBooking({ materials: [{ sendTiming: null }], libraryMaterials: [] });
    expect(await html()).toContain("materials:true");
  });

  it("lights the badge for a class-scoped material with only library items absent", async () => {
    // Only a class-scoped/private material (e.g. native content, always-visible)
    // and no library-linked item — the class still has materials.
    state.booking = makeBooking({ materials: [{ sendTiming: null }], libraryMaterials: [] });
    expect(await html()).toContain("materials:true");
  });

  it("lights the badge when BOTH sources have a material", async () => {
    state.booking = makeBooking({
      materials: [{ sendTiming: null }],
      libraryMaterials: [{ sendTiming: null }],
    });
    expect(await html()).toContain("materials:true");
  });

  it("does not light the badge when the class has no materials of either kind", async () => {
    state.booking = makeBooking({ materials: [], libraryMaterials: [] });
    const out = await html();
    expect(out).toContain("materials:false");
    expect(out).not.toContain("materials:true");
  });

  it("stays lit after deleting the last library item while a class-scoped one remains", async () => {
    // Delete the last library-linked material → libraryMaterials empty, but a
    // class-scoped material is still present, so the class still has materials.
    state.booking = makeBooking({ materials: [{ sendTiming: null }], libraryMaterials: [] });
    expect(await html()).toContain("materials:true");
  });

  it("goes dark after deleting the last material of EITHER kind", async () => {
    // Both sources now empty (whichever was last removed) → no materials.
    state.booking = makeBooking({ materials: [], libraryMaterials: [] });
    expect(await html()).toContain("materials:false");
  });

  it("query selects class-scoped materials WITHOUT a body filter (content counts)", async () => {
    // The core fix: a class-scoped content material (body set) must reach the
    // badge, so the `materials` select must not carry `where: { body: null }`.
    state.booking = makeBooking({ materials: [], libraryMaterials: [] });
    await html();
    const materialsSelect = capturedInclude.value?.materials as
      { where?: unknown; select?: unknown } | undefined;
    expect(materialsSelect).toBeDefined();
    expect(materialsSelect?.where).toBeUndefined();
    // It still selects the join relation too, so library items keep counting.
    expect(capturedInclude.value?.libraryMaterials).toBeDefined();
  });
});
