import { describe, expect, it } from "vitest";
import { toAzureLocale } from "./config";

// Azure scores pronunciation against a full locale; a lesson stores a bare
// subtag. The default region per language is a data table, not a branch.
describe("toAzureLocale", () => {
  it("gives a bare subtag its default region", () => {
    expect(toAzureLocale("es")).toBe("es-ES");
    expect(toAzureLocale("en")).toBe("en-US");
    expect(toAzureLocale("EN")).toBe("en-US");
  });

  it("passes a full locale through, and an unmapped subtag as it is", () => {
    expect(toAzureLocale("es-MX")).toBe("es-MX");
    expect(toAzureLocale("fr")).toBe("fr");
  });
});
