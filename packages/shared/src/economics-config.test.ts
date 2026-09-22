import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTEGRATION_CATEGORY,
  INTEGRATION_CATEGORIES,
  isIntegrationCategory,
  isUsageMetric,
  KNOWN_INTEGRATIONS,
  USAGE_METRICS,
} from "./economics-config";
import { parsePricingModel } from "./economics-pricing";

describe("taxonomy", () => {
  it("exposes the expected category and metric counts", () => {
    expect(INTEGRATION_CATEGORIES).toHaveLength(13);
    expect(USAGE_METRICS).toHaveLength(9);
    expect(new Set(INTEGRATION_CATEGORIES).size).toBe(INTEGRATION_CATEGORIES.length);
    expect(new Set(USAGE_METRICS).size).toBe(USAGE_METRICS.length);
  });

  it("has type guards that agree with the lists", () => {
    expect(isIntegrationCategory("ai")).toBe(true);
    expect(isIntegrationCategory("not_a_category")).toBe(false);
    expect(isUsageMetric("lessons")).toBe(true);
    expect(isUsageMetric("not_a_metric")).toBe(false);
    expect(isIntegrationCategory(DEFAULT_INTEGRATION_CATEGORY)).toBe(true);
  });
});

describe("KNOWN_INTEGRATIONS seed", () => {
  it("has unique keys", () => {
    const keys = KNOWN_INTEGRATIONS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("seeds a meaningful number of integrations", () => {
    // The app's real SaaS bill — keep this from silently shrinking.
    expect(KNOWN_INTEGRATIONS.length).toBeGreaterThanOrEqual(20);
  });

  it("every entry has a valid category and a schema-valid pricing model", () => {
    for (const integration of KNOWN_INTEGRATIONS) {
      expect(isIntegrationCategory(integration.category)).toBe(true);
      expect(integration.currency).toMatch(/^[A-Z]{3}$/);
      // The stored model must round-trip through the same schema the DB read
      // boundary uses — a seed that can't parse would render as a warning badge.
      const parsed = parsePricingModel(integration.pricingModel);
      expect(parsed, `pricing model for "${integration.key}" should parse`).not.toBeNull();
    }
  });

  it("covers a spread of pricing kinds (free, monthly, annual, payg)", () => {
    const kinds = new Set(KNOWN_INTEGRATIONS.map((i) => i.pricingModel.kind));
    expect(kinds.has("free")).toBe(true);
    expect(kinds.has("monthly")).toBe(true);
    expect(kinds.has("annual")).toBe(true);
    expect(kinds.has("payg")).toBe(true);
  });
});
