import { describe, expect, it } from "vitest";
import { planLabel, planPriceLabel, statusLabel } from "@/lib/subscriptions/display";

// Localized plan/status display strings shared across billing, pricing,
// admin, and the mobile wire mapper. Pin every locale so the labels can't
// drift between surfaces.
//
// "Both locales" was the gap. These functions were written as
// `locale === "en" ? english : spanish`, and this file asserted exactly those
// two — so when French joined the registry it silently took the Spanish
// branch on every surface, and there was no test to notice.

describe("planLabel", () => {
  it("renders Spanish labels", () => {
    expect(planLabel("free", "es-MX")).toBe("Gratis");
    expect(planLabel("monthly", "es-MX")).toBe("Pro Mensual");
    expect(planLabel("annual", "es-MX")).toBe("Pro Anual");
    expect(planLabel("founding", "es-MX")).toBe("Fundador");
  });

  it("renders English labels", () => {
    expect(planLabel("free", "en")).toBe("Free");
    expect(planLabel("monthly", "en")).toBe("Pro Monthly");
    expect(planLabel("annual", "en")).toBe("Pro Annual");
    expect(planLabel("founding", "en")).toBe("Founding");
  });
});

describe("statusLabel", () => {
  it("renders Spanish statuses", () => {
    expect(statusLabel("trialing", "es-MX")).toBe("Prueba");
    expect(statusLabel("active", "es-MX")).toBe("Activa");
    expect(statusLabel("past_due", "es-MX")).toBe("Pago vencido");
    expect(statusLabel("canceled", "es-MX")).toBe("Cancelada");
    expect(statusLabel("free", "es-MX")).toBe("Gratis");
  });

  it("renders English statuses", () => {
    expect(statusLabel("trialing", "en")).toBe("Trial");
    expect(statusLabel("past_due", "en")).toBe("Payment overdue");
  });
});

describe("planPriceLabel", () => {
  // The canonical currency (D-99) is GBP. These used to assert
  // contains-not-exact-string because formatMinorUnits rendered GBP as a bare
  // code and then appended the code again, so the public pricing page really
  // said "GBP 7.99 GBP/mo" — the loose assertions were what let it ship. Pinned
  // to the exact string now, which is the one the function has always
  // documented.
  it("suffixes a monthly cadence for monthly and founding plans", () => {
    expect(planPriceLabel("monthly", "es-MX")).toBe("£7.99 GBP/mes");
    expect(planPriceLabel("monthly", "en")).toBe("£7.99 GBP/mo");
    expect(planPriceLabel("founding", "en")).toBe("£5.99 GBP/mo");
  });

  it("suffixes a yearly cadence for the annual plan", () => {
    expect(planPriceLabel("annual", "es-MX")).toBe("£79.90 GBP/año");
    expect(planPriceLabel("annual", "en")).toBe("£79.90 GBP/yr");
  });

  it("never repeats the currency code", () => {
    // The specific regression: one "GBP", not two.
    for (const plan of ["monthly", "annual", "founding"] as const) {
      const label = planPriceLabel(plan, "en");
      expect(label.split("GBP").length - 1, `${plan} rendered as "${label}"`).toBe(1);
    }
  });

  it("shows free without a cadence suffix", () => {
    expect(planPriceLabel("free", "es-MX")).toBe("Gratis");
    expect(planPriceLabel("free", "en")).toBe("Free");
  });
});

// The regression French exposed: a two-branch ternary in a three-locale
// product. Every one of these rendered Spanish before the labels moved into
// the shared catalog.
describe("French, the locale the ternaries forgot", () => {
  it("renders French plan labels rather than falling through to Spanish", () => {
    expect(planLabel("free", "fr")).toBe("Gratuit");
    expect(planLabel("monthly", "fr")).toBe("Pro Mensuel");
    expect(planLabel("annual", "fr")).toBe("Pro Annuel");
    expect(planLabel("founding", "fr")).toBe("Fondatrice");
  });

  it("renders French statuses", () => {
    expect(statusLabel("trialing", "fr")).toBe("Essai");
    expect(statusLabel("past_due", "fr")).toBe("Paiement en retard");
    expect(statusLabel("canceled", "fr")).toBe("Résiliée");
  });

  it("renders a French cadence suffix", () => {
    expect(planPriceLabel("monthly", "fr")).toBe("£7.99 GBP/mois");
    expect(planPriceLabel("annual", "fr")).toBe("£79.90 GBP/an");
    expect(planPriceLabel("free", "fr")).toBe("Gratuit");
  });
});
