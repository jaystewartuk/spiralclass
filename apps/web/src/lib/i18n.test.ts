import { describe, expect, it } from "vitest";
import { translate, type AppLocale } from "./i18n";

describe("translate", () => {
  it("returns the en entry for the en locale", () => {
    expect(translate({ en: "Hello", es: "Hola", fr: "Bonjour" }, "en")).toBe("Hello");
  });

  it("returns the es entry for the es locale", () => {
    expect(translate({ en: "Hello", es: "Hola", fr: "Bonjour" }, "es")).toBe("Hola");
  });

  it("returns the fr entry for the fr locale", () => {
    expect(translate({ en: "Hello", es: "Hola", fr: "Bonjour" }, "fr")).toBe("Bonjour");
  });

  it("requires every AppLocale key at compile time", () => {
    const locale: AppLocale = "en";
    // @ts-expect-error missing the "es" and "fr" keys
    translate({ en: "Hello" }, locale);
  });
});
