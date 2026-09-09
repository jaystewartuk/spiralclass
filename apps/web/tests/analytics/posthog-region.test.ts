import { describe, expect, it } from "vitest";

import { posthogRegion, posthogRegionHosts } from "@/lib/analytics/posthog-region";

// D-48 — data residency. The PostHog region is a config knob
// (NEXT_PUBLIC_POSTHOG_REGION) so a future EU move is a flip + project
// re-create, not a code edit. These lock the host derivation for both regions
// and the US-safe default, so nobody silently ships EU-region hosts.

describe("posthogRegion", () => {
  it("defaults to US when unset", () => {
    expect(posthogRegion(undefined)).toBe("us");
  });

  it("returns EU only for an explicit eu value (case/space-insensitive)", () => {
    expect(posthogRegion("eu")).toBe("eu");
    expect(posthogRegion(" EU ")).toBe("eu");
    expect(posthogRegion("Eu")).toBe("eu");
  });

  it("falls back to US for any other value", () => {
    expect(posthogRegion("us")).toBe("us");
    expect(posthogRegion("")).toBe("us");
    expect(posthogRegion("europe")).toBe("us");
    expect(posthogRegion("US")).toBe("us");
  });
});

describe("posthogRegionHosts", () => {
  it("maps US to the US cloud hosts", () => {
    expect(posthogRegionHosts("us")).toEqual({
      ingest: "https://us.i.posthog.com",
      assets: "https://us-assets.i.posthog.com",
      ui: "https://us.posthog.com",
    });
  });

  it("maps EU to the EU cloud hosts", () => {
    expect(posthogRegionHosts("eu")).toEqual({
      ingest: "https://eu.i.posthog.com",
      assets: "https://eu-assets.i.posthog.com",
      ui: "https://eu.posthog.com",
    });
  });
});
