import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A route-level loading.tsx is not decoration. Next wraps the page in a
// Suspense boundary, streams the skeleton first, and swaps in the real content
// with its inline `$RS` reveal — so the skeleton and the page have to agree
// about SHAPE, not merely look busy.
//
// They stopped agreeing. D-144 rewrote the buy page into one narrow column
// (`mx-auto max-w-lg`) and left this skeleton on the old two-column container
// (`lg:max-w-4xl`) listing package rows the page no longer renders. Every load
// painted the abandoned design for a beat and then jumped, and production logs
// a React #418 hydration mismatch plus two `$RS`
// "Cannot read properties of null (reading 'parentNode')" on this route and no
// other (Sentry AGENDAPROFE-34).
//
// The container width is the cheapest thing to pin that would have caught it:
// it is the one value both files must state explicitly, and it was wrong.

const BUY = join(process.cwd(), "src", "app", "b", "[slug]", "buy");

// Comments are stripped before matching. Both files EXPLAIN this drift in prose
// — naming the stale class they must no longer render — so a naive grep finds
// the very string it is asserting is gone.
function code(file: string): string {
  return readFileSync(join(BUY, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const loading = code("loading.tsx");
const page = code("page.tsx");

describe("the buy route's loading skeleton matches the page", () => {
  it("uses the same container width the page does", () => {
    const width = /max-w-(\w+)/;
    const pageWidth = page.match(width)?.[1];
    const loadingWidth = loading.match(width)?.[1];

    expect(pageWidth, "page.tsx should state a max-width").toBeTruthy();
    expect(
      loadingWidth,
      `skeleton is max-w-${loadingWidth} but the page is max-w-${pageWidth} — ` +
        "the streamed fallback would paint a different layout than the content",
    ).toBe(pageWidth);
  });

  it("does not describe the two-column layout the page abandoned", () => {
    // The specific stale value, named so the failure is self-explaining if it
    // ever comes back by copy-paste.
    expect(loading).not.toContain("lg:max-w-4xl");
    expect(loading).not.toContain("lg:grid-cols-2");
  });

  it("sketches the two cards the page actually renders", () => {
    // Summary card (avatar + heading + price row), then the form card. Not a
    // pixel assertion — just that the skeleton has the right number of blocks,
    // so a future page restructure that leaves this behind is visible.
    const cards = loading.match(/rounded-lg border/g) ?? [];
    expect(cards.length).toBe(2);
    expect(loading, "the summary card leads with the teacher's avatar").toContain("rounded-full");
  });
});
