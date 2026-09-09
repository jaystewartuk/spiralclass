import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pins robots.txt: the crawl-hygiene disallow list, the preview/non-prod
// disallow-all guard, and — deindexing mechanics — that pages relying on
// per-page noindex metadata (/sign-in, /sign-up, /b/*/buy*)
// are NOT disallowed here: a robots.txt disallow blocks crawling, so Google
// could never see the noindex on a page it isn't allowed to fetch.

const state = { prod: true };
vi.mock("@/lib/env", () => ({
  isProductionDeployment: () => state.prod,
}));

const ORIGINAL_APP_URL = process.env.APP_URL;

beforeEach(() => {
  vi.resetModules();
  state.prod = true;
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) {
    delete process.env.APP_URL;
  } else {
    process.env.APP_URL = ORIGINAL_APP_URL;
  }
});

async function loadRobots() {
  const { default: robots } = await import("@/app/robots");
  return robots;
}

describe("robots (production)", () => {
  it("allows crawling and disallows the auth-gated + email-token surfaces", async () => {
    delete process.env.APP_URL;
    const robots = await loadRobots();
    const result = robots();
    expect(result.rules).toEqual({
      userAgent: "*",
      allow: "/",
      disallow: [
        "/dashboard",
        "/admin",
        "/api/",
        "/my-classes",
        "/onboarding",
        "/settings",
        "/payments",
        "/notifications",
        "/auth/",
        "/m/",
        "/r/",
      ],
    });
    expect(result.sitemap).toBe("https://spiralclass.com/sitemap.xml");
  });

  it("does NOT disallow the noindex-metadata pages (they must stay crawlable)", async () => {
    delete process.env.APP_URL;
    const robots = await loadRobots();
    const rules = robots().rules as { disallow: string[] };
    for (const path of ["/sign-in", "/sign-up"]) {
      expect(rules.disallow).not.toContain(path);
    }
  });

  it("builds the sitemap URL from APP_URL, trailing slash stripped", async () => {
    process.env.APP_URL = "https://preview.spiralclass.com/";
    const robots = await loadRobots();
    expect(robots().sitemap).toBe("https://preview.spiralclass.com/sitemap.xml");
  });
});

describe("robots (non-production)", () => {
  it("stays crawlable (so the X-Robots-Tag noindex can deindex preview) and advertises no sitemap", async () => {
    delete process.env.APP_URL;
    state.prod = false;
    const robots = await loadRobots();
    const result = robots();
    // Deliberately NOT disallow-all: preview was crawlable with no protection
    // before this guard existed, so already-indexed pages can only be removed
    // if Google can fetch them and see the noindex header.
    expect(result.rules).toEqual({ userAgent: "*", allow: "/" });
    expect(result.sitemap).toBeUndefined();
  });
});
