import { describe, expect, it } from "vitest";
import { createT } from "./translate";

/**
 * Plural selection (D-142).
 *
 * The bug that prompted this: the booking page rendered "1 classes × 50 min"
 * whenever a package held one class but was not flagged `singleClass`. The
 * catalog was writing the plural into the template, so no call site could get
 * it right. These tests pin the mechanism rather than that one string, because
 * the next string to need it has not been written yet.
 */
describe("plural-aware translation", () => {
  it("selects the singular variant at one", () => {
    const t = createT("en");
    expect(t("web.bookingLanding.classCountDuration", { count: 1, min: 50 })).toBe(
      "1 class × 50 min",
    );
  });

  it("selects the plural variant above one", () => {
    const t = createT("en");
    expect(t("web.bookingLanding.classCountDuration", { count: 8, min: 50 })).toBe(
      "8 classes × 50 min",
    );
  });

  it("selects the plural variant at zero, which English treats as plural", () => {
    // Worth pinning: `count === 1` logic and CLDR agree here, but they do not
    // agree in every locale, which is the reason for using CLDR at all.
    const t = createT("en");
    expect(t("web.bookingLanding.classCountDuration", { count: 0, min: 50 })).toBe(
      "0 classes × 50 min",
    );
  });

  it("pluralises in Spanish and French too", () => {
    expect(createT("es-MX")("web.buyFlow.package.multiClass", { count: 1, min: 50 })).toContain(
      "clase de",
    );
    expect(createT("es-MX")("web.buyFlow.package.multiClass", { count: 4, min: 50 })).toContain(
      "clases de",
    );
    expect(createT("fr")("web.buyFlow.package.multiClass", { count: 1, min: 50 })).toContain(
      "cours de",
    );
  });

  it("leaves a string with no plural variants completely alone", () => {
    // The compatibility guarantee: every existing key keeps its behaviour even
    // when the caller happens to pass a `count`.
    const t = createT("en");
    expect(t("web.bookingLanding.classCountDurationShort", { count: 1, min: 50 })).toBe(
      "1 × 50 min",
    );
  });

  it("never mixes locales when only the default has a variant", () => {
    // The fallback order that matters: any string in the requested locale
    // beats a better-matching one from the default locale. Rendering an
    // English plural inside a Spanish page is worse than a wrong plural.
    const t = createT("es-MX");
    const out = t("web.bookingLanding.classCountDuration", { count: 3, min: 50 });
    expect(out).not.toMatch(/class/);
    expect(out).toContain("clases");
  });
});
