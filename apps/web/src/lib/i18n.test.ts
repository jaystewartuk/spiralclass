import { describe, expect, it } from "vitest";
import { translate, type AppLocale } from "./i18n";

describe("translate", () => {
  it("returns the en entry for the en locale", () => {
    expect(translate({ en: "Hello", "es-MX": "Hola", fr: "Bonjour" }, "en")).toBe("Hello");
  });

  it("returns the es-MX entry for the es-MX locale", () => {
    expect(translate({ en: "Hello", "es-MX": "Hola", fr: "Bonjour" }, "es-MX")).toBe("Hola");
  });

  it("returns the fr entry for the fr locale", () => {
    expect(translate({ en: "Hello", "es-MX": "Hola", fr: "Bonjour" }, "fr")).toBe("Bonjour");
  });

  it("requires every AppLocale key at compile time", () => {
    const locale: AppLocale = "en";
    // @ts-expect-error missing the "es-MX" and "fr" keys
    translate({ en: "Hello" }, locale);
  });
});
