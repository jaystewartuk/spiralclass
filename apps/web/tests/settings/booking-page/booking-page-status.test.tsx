import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { createT } from "@spiralclass/shared";
import { bookingPageReadiness, type BookingPageReadinessInput } from "@/lib/booking/page-readiness";

(globalThis as Record<string, unknown>).React = React;

// The status card is the answer to the question this screen never used to
// answer: does my link actually open? Rendered against the REAL catalog, because
// half of what this card gets wrong would be the words — a version that called a
// 404ing link "Live" would pass a test that asserted key names.

vi.mock("@/lib/i18n", () => ({ getT: async () => createT("en") }));

const { BookingPageStatus } = await import("@/app/(app)/settings/booking-page/booking-page-status");

const READY: BookingPageReadinessInput = {
  disabledAt: null,
  onboardingCompleteAt: new Date("2026-01-01T00:00:00.000Z"),
  photoPath: "teachers/t1/photo.jpg",
  bio: "Ten years teaching adults.",
  templatesTouchedAt: new Date("2026-01-02T00:00:00.000Z"),
  availabilityTouchedAt: new Date("2026-01-03T00:00:00.000Z"),
  stripeChargesEnabled: true,
  pricingCurrency: "MXN",
  payoutInstruments: [],
  headline: "Spanish that survives Monday",
  introVideoPath: "teachers/t1/intro.mp4",
  targetLanguage: "es",
  publicWhatsappE164: "+525512345678",
  introVideoAvailable: true,
};

const FULL_URL = "https://spiralclass.com/b/mira";
const DISPLAY_URL = "spiralclass.com/b/mira";

async function render(over: Partial<BookingPageReadinessInput> = {}) {
  const element = await BookingPageStatus({
    readiness: bookingPageReadiness({ ...READY, ...over }),
    fullUrl: FULL_URL,
    displayUrl: DISPLAY_URL,
  });
  return renderToStaticMarkup(element);
}

describe("BookingPageStatus — a page students can open", () => {
  it("says it is live and offers to open it", async () => {
    const html = await render();
    expect(html).toContain("Live");
    expect(html).toContain("Anyone with the link can open your page");
    expect(html).toContain(`href="${FULL_URL}"`);
    expect(html).toContain(DISPLAY_URL);
  });

  it("does not show a to-do list once there is nothing left to do", async () => {
    const html = await render();
    expect(html).not.toContain("To go live");
    expect(html).toContain("Your page has everything students look for.");
  });

  it("offers the remaining conversion tips, and only the unmet ones", async () => {
    const html = await render({ introVideoPath: null, publicWhatsappE164: null });
    expect(html).toContain("Ways to make it stronger");
    expect(html).toContain("Record a short intro video");
    expect(html).toContain("Add a WhatsApp number");
    expect(html).not.toContain("Add a headline");
  });
});

describe("BookingPageStatus — a page that 404s", () => {
  it("says the link does not open, rather than presenting it as live", async () => {
    const html = await render({ photoPath: null });
    expect(html).toContain("Not visible yet");
    expect(html).toContain("page not found");
    expect(html).not.toContain("Live<");
  });

  it("names each missing requirement and links to where it is fixed", async () => {
    const html = await render({ photoPath: null, availabilityTouchedAt: null });
    expect(html).toContain("Add a profile photo");
    expect(html).toContain('href="#profile"');
    expect(html).toContain("Set the hours you teach");
    expect(html).toContain('href="/settings/availability"');
    // Met requirements are not listed back at her — the list is work, not a report.
    expect(html).not.toContain("Set your prices");
  });

  it("shows how far along she is, as a labelled progress bar", async () => {
    const html = await render({ photoPath: null, bio: null });
    expect(html).toContain("4 of 6");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="67"');
  });

  it("does not offer to open a link that would 404", async () => {
    const html = await render({ photoPath: null });
    expect(html).not.toContain(`href="${FULL_URL}"`);
    // The URL is still shown and copyable — she may want to fix the slug first.
    expect(html).toContain(DISPLAY_URL);
  });

  it("holds back the conversion tips until the page is actually reachable", async () => {
    const html = await render({ photoPath: null, introVideoPath: null });
    expect(html).not.toContain("Ways to make it stronger");
  });
});
