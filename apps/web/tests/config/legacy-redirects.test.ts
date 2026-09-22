import { describe, expect, it } from "vitest";
import config from "../../next.config";

/**
 * URLs the product has already published keep working.
 *
 * /precios was the pricing page for months: it is in the sitemap, linked from
 * the footer and the marketing header, and shareable — so some of those links
 * live in other people's messages and bookmarks, where nobody can fix them.
 * Renaming the route to /pricing without a redirect turns every one of them
 * into a 404, which is a worse outcome than the inconsistent slug was.
 *
 * This pins the redirect rather than the rename: the test that matters is that
 * the old address still resolves, not that the new one exists.
 */
describe("legacy public URLs", () => {
  it("redirects /precios to /pricing, permanently", async () => {
    const redirects = await config.redirects?.();
    const rule = redirects?.find((r) => r.source === "/precios");
    expect(rule, "/precios has no redirect — published links would 404").toBeDefined();
    expect(rule?.destination).toBe("/pricing");
    // 308, not 307: the move is permanent, and a temporary redirect leaves
    // search engines pointing at the old address indefinitely.
    expect(rule?.permanent).toBe(true);
  });
});
