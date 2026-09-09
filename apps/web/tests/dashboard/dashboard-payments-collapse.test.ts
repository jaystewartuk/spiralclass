import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";

// The page's JSX compiles to the classic runtime (React.createElement) under
// vitest's esbuild; the web suite otherwise never renders components, so make
// React available globally before the page module evaluates.
(globalThis as Record<string, unknown>).React = React;

// Payments is a one-time setup task, so on the teacher dashboard it collapses
// to an unobtrusive status line once a rail is connected, and only surfaces as
// a prominent setup CTA while nothing is connected. Pin both so the demotion
// doesn't silently regress back into a permanent card.

// Marketplace-ready on every other sub-signal (profile + offer/schedule
// reviewed) so these two tests isolate the payments card / "Start here"
// banner interaction to payment-rail status alone — the dedicated banner
// coverage lives in dashboard-marketplace-ready-banner.test.ts.
const BASE_TEACHER: Record<string, unknown> = {
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
  stripeAccountId: null,
  stripeChargesEnabled: false,
  pricingCurrency: "MXN",
  payoutInstruments: [],
  // GB is inside the Stripe Connect circle (D-58) — the base fixture exercises
  // the Stripe+Wise copy; the country-gating tests below override this to an
  // unsupported country to exercise the Wise-only copy.
  country: "GB",
};

let teacher: Record<string, unknown> = { ...BASE_TEACHER };
let studentCount = 0;

vi.mock("@/lib/auth", () => ({ requireOnboardedTeacher: async () => teacher }));
vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: async () => "es-MX",
  getT: async () => createT("es-MX"),
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
    // D-113: backed by the same `teacher` fixture the page's auth returns, so
    // the readiness gate and the instrument query can't disagree.
    teacherPayoutInstrument: {
      findMany: async () => (teacher.payoutInstruments ?? []) as unknown[],
    },
    teacher: {
      findUnique: async () => ({
        _count: { teacherStudents: studentCount, bookings: studentCount },
      }),
    },
    lead: { count: async () => 0 },
    testimonial: { count: async () => 0 },
    // The schedule card the dashboard leads with. These fixtures are about the
    // payments rail, so the teacher has nothing upcoming and the card renders
    // its empty state.
    booking: { findMany: async () => [], count: async () => 0 },
  },
}));

// Client sub-components aren't under test here — stub them so the server
// component renders without their client internals.
vi.mock("@/components/cashflow-summary", () => ({ SafeToSpendTile: () => null }));
vi.mock("@/components/copy-link-button", () => ({ CopyLinkButton: () => null }));
vi.mock("@/components/growth-checklist", () => ({ GrowthChecklist: () => null }));

const { default: DashboardPage } = await import("@/app/(app)/dashboard/page");

// D-142 split the dashboard into a data page and a presentational
// <DashboardView>, so the page returns an element whose type is itself an
// async component — renderToStaticMarkup cannot await one. Resolving that
// extra level keeps these assertions on the real rendered output.
async function html(): Promise<string> {
  const el = (await DashboardPage()) as React.ReactElement;
  const View = el.type as (props: unknown) => Promise<React.ReactElement>;
  return renderToStaticMarkup(await View(el.props));
}

describe("teacher dashboard — payments card demotion", () => {
  it("collapses payments to a status line when a rail is connected", async () => {
    teacher = {
      ...BASE_TEACHER,
      stripeAccountId: "acct_1",
      stripeChargesEnabled: true,
      pricingCurrency: "MXN",
      payoutInstruments: [
        { kind: "wise", enabled: true, wiseHandle: "mira", schemeId: null, details: null },
      ],
    };
    studentCount = 1; // not a brand-new teacher

    const out = await html();

    // Collapsed status line, not the full setup CTA.
    expect(out).toContain("Cobros activos");
    // "Transferencia", not "Wise": since D-113 the line names the rail, so a
    // teacher whose only instrument is SPEI reads correctly too.
    expect(out).toContain("Stripe + Transferencia");
    expect(out).toContain("Administrar");
    expect(out).not.toContain("Configura Stripe y/o Wise");

    // Every other marketplace-ready sub-signal is satisfied on BASE_TEACHER,
    // so connecting a rail is the last piece — the "Start here" banner is
    // gone and the booking-link card reads as public/live.
    expect(out).not.toContain("Empieza aquí");
    expect(out).not.toContain("Aún no puedes cobrar con este enlace");

    // Within the aside, the booking link comes before the payments status line
    // — payments is a solved one-off, her link is the thing she reaches for.
    // (The schedule leads the page itself; both of these sit beside it.)
    expect(out.indexOf("Tu enlace de reservas")).toBeGreaterThan(-1);
    expect(out.indexOf("Tu enlace de reservas")).toBeLessThan(out.indexOf("Cobros activos"));
  });

  it("shows a prominent setup CTA when no rail is connected", async () => {
    teacher = { ...BASE_TEACHER };
    studentCount = 1; // not a brand-new teacher

    const out = await html();

    expect(out).toContain("Configura Stripe y/o Wise para empezar a cobrar.");
    expect(out).toContain("Configurar");
    expect(out).not.toContain("Cobros activos");

    // No payout rail means marketplaceReady is still false even though
    // profile/offer/schedule are all otherwise complete — the banner and the
    // booking-link warning both reflect that.
    expect(out).toContain("Empieza aquí");
    expect(out).toContain("Aún no puedes cobrar con este enlace");
  });

  // Country-gated Stripe copy (reuses the settings/payments/page.tsx pattern):
  // a teacher outside SUPPORTED_CONNECT_COUNTRIES (D-58) never sees Stripe
  // mentioned in the setup CTA, only Wise.
  it("shows transfer-only setup copy for a teacher Stripe refuses a merchant account", async () => {
    teacher = { ...BASE_TEACHER, country: "IN" };
    studentCount = 1; // not a brand-new teacher

    const out = await html();

    expect(out).toContain("Configura Wise para empezar a cobrar.");
    expect(out).not.toContain("Configura Stripe y/o Wise");
  });

  it("still mentions Stripe when a legacy account is already linked despite an unsupported country", async () => {
    teacher = { ...BASE_TEACHER, country: "IN", stripeAccountId: "acct_legacy" };
    studentCount = 1;

    const out = await html();

    expect(out).toContain("Configura Stripe y/o Wise para empezar a cobrar.");
  });
});
