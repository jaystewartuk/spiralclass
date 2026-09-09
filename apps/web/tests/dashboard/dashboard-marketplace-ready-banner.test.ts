import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";

// The page's JSX compiles to the classic runtime (React.createElement) under
// vitest's esbuild; the web suite otherwise never renders components, so make
// React available globally before the page module evaluates.
(globalThis as Record<string, unknown>).React = React;

// `onboardingCompleteAt` alone
// ("finished the 4-step wizard") is no longer treated as "ready for the
// marketplace" — the dashboard's "Start here" banner and the booking-link
// card's public/not-yet-public messaging now key off isMarketplaceReady(),
// which additionally requires a real profile, a reviewed offer + schedule,
// and a connected payout rail. This file pins that every missing sub-signal
// (independently) keeps the banner visible, and that all five together clear it.

const READY_TEACHER: Record<string, unknown> = {
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
  payoutInstruments: [],
  country: "GB",
};

let teacher: Record<string, unknown> = { ...READY_TEACHER };

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
    // D-113: backed by the same `teacher` fixture the page's auth returns.
    teacherPayoutInstrument: {
      findMany: async () => (teacher.payoutInstruments ?? []) as unknown[],
    },
    teacher: {
      findUnique: async () => ({ _count: { teacherStudents: 1, bookings: 1 } }),
    },
    lead: { count: async () => 0 },
    testimonial: { count: async () => 0 },
    // The schedule card the dashboard leads with. These fixtures are about the
    // banner's gating, so the teacher has nothing upcoming and the card renders
    // its empty state.
    booking: { findMany: async () => [], count: async () => 0 },
  },
}));

vi.mock("@/components/cashflow-summary", () => ({ SafeToSpendTile: () => null }));
vi.mock("@/components/copy-link-button", () => ({ CopyLinkButton: () => null }));
vi.mock("@/components/growth-checklist", () => ({ GrowthChecklist: () => null }));

const { default: DashboardPage } = await import("@/app/(app)/dashboard/page");

// D-142 split the dashboard into a data page and a presentational
// <DashboardView>, so the page now returns an element whose type is itself an
// async component — and renderToStaticMarkup cannot await one. Resolving that
// one extra level here keeps these assertions pointed at the real rendered
// output rather than at a promise, and keeps them honest about the split: if
// the page ever stops passing a signal through to the view, this file fails.
async function html(): Promise<string> {
  const el = (await DashboardPage()) as React.ReactElement;
  const View = el.type as (props: unknown) => Promise<React.ReactElement>;
  return renderToStaticMarkup(await View(el.props));
}

describe("teacher dashboard — marketplace-ready banner", () => {
  it("hides the banner and shows a live booking link once every sub-signal is satisfied", async () => {
    teacher = { ...READY_TEACHER };
    const out = await html();
    expect(out).not.toContain("Empieza aquí");
    expect(out).not.toContain("Aún no puedes cobrar con este enlace");
  });

  it("keeps the banner visible when the profile (photo/bio) is missing", async () => {
    teacher = { ...READY_TEACHER, photoPath: null, bio: null };
    const out = await html();
    expect(out).toContain("Empieza aquí");
  });

  it("keeps the banner visible when the offer (templates) was never reviewed", async () => {
    teacher = { ...READY_TEACHER, templatesTouchedAt: null };
    const out = await html();
    expect(out).toContain("Empieza aquí");
  });

  it("keeps the banner visible when availability was never reviewed", async () => {
    teacher = { ...READY_TEACHER, availabilityTouchedAt: null };
    const out = await html();
    expect(out).toContain("Empieza aquí");
  });

  it("keeps the banner visible when no payout rail is connected, even with real students/bookings", async () => {
    teacher = { ...READY_TEACHER, stripeAccountId: null, stripeChargesEnabled: false };
    const out = await html();
    // This is the exact gap the audit flagged: the old isNewTeacher-only gate
    // stopped showing guidance the moment a teacher had any booking, even
    // while she still couldn't get paid for it.
    expect(out).toContain("Empieza aquí");
    expect(out).toContain("Aún no puedes cobrar con este enlace");
  });
});

// The banner used to say only "follow the checklist below" — but the "Crecer"
// checklist's signals (GrowthSignals) have no notion of templatesTouched /
// availabilityTouched. A teacher blocked on exactly those two therefore read
// a warning pointing at a checklist on which every step was already ticked,
// with nothing anywhere naming the real cause. That is how the 2026-07-26
// de-listing stayed invisible from inside the product for three days.
describe("teacher dashboard — naming the blocking signals", () => {
  it("names each unmet signal and links it to the screen that fixes it", async () => {
    teacher = { ...READY_TEACHER, templatesTouchedAt: null, availabilityTouchedAt: null };
    const out = await html();

    expect(out).toContain("Para que tu página sea pública:");
    expect(out).toContain("Abre tus paquetes y guárdalos");
    expect(out).toContain("Abre tu horario semanal y guárdalo");
    expect(out).toContain('href="/settings/templates"');
    expect(out).toContain('href="/settings/availability"');
  });

  it("lists only the signals actually unmet", async () => {
    teacher = { ...READY_TEACHER, templatesTouchedAt: null, availabilityTouchedAt: null };
    const out = await html();

    // Payout rail, photo and bio are all satisfied here — naming them too
    // would send the teacher off to fix things that aren't broken.
    expect(out).not.toContain("Conecta una forma de cobrar");
    expect(out).not.toContain("Agrega una foto de perfil");
    expect(out).not.toContain("Escribe una breve descripción");
  });

  it("says the fix is to open and save, since the content already looks correct", async () => {
    // The remedy for both *Touched signals is pressing Save on a page that
    // already reads fine — a baffling instruction unless the copy says so.
    teacher = { ...READY_TEACHER, availabilityTouchedAt: null };
    const out = await html();
    expect(out).toContain("aunque ya se vea bien");
  });

  it("names the payout rail when that is what is missing", async () => {
    teacher = { ...READY_TEACHER, stripeAccountId: null, stripeChargesEnabled: false };
    const out = await html();
    expect(out).toContain("Conecta una forma de cobrar");
    expect(out).toContain('href="/settings/payments"');
  });

  it("shows no blocker list at all once the teacher is ready", async () => {
    teacher = { ...READY_TEACHER };
    const out = await html();
    expect(out).not.toContain("Para que tu página sea pública:");
  });
});
