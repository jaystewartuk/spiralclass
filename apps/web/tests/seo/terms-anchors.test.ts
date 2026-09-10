import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANCELLATION_POLICY_ANCHOR,
  LEGACY_CANCELLATION_ANCHOR,
  cancellationPolicyPath,
} from "@/lib/terms-anchors";

/**
 * The cancellation-policy deep links land on the clause, in both languages.
 *
 * A URL fragment never reaches the server, so a link pointing at an id the
 * page does not carry fails in the only way that cannot be detected from
 * outside: the request 200s, the browser scrolls to the top of a long legal
 * document, and the reader is left to find the clause. Nothing that checks
 * status codes — the link checker, the E2E suite, an uptime probe — sees it.
 *
 * So both ends are pinned here against the rendered source: the ids the page
 * carries, and the ids the links point at.
 */

const TERMS_SOURCE = readFileSync(resolve(__dirname, "../../src/app/terms/page.tsx"), "utf8");

/** How many times the page renders a given anchor constant. */
function anchorRenders(constantName: string): number {
  return TERMS_SOURCE.split(`id={${constantName}}`).length - 1;
}

describe("/terms cancellation anchor", () => {
  it("is carried by both language variants", () => {
    // Two: the Spanish document and the English one. A reader following a link
    // must reach the clause whichever variant answers.
    expect(anchorRenders("CANCELLATION_POLICY_ANCHOR")).toBe(2);
  });

  it("keeps the earlier id reachable in both variants", () => {
    // Cancellation and deduction emails carry it and are already delivered, so
    // this is not a link anybody can go and fix. Rendered through a component
    // — one `id={…}`, placed twice — so this counts the placements.
    expect(TERMS_SOURCE.split("<LegacyCancellationAnchor />").length - 1).toBe(2);
    expect(anchorRenders("LEGACY_CANCELLATION_ANCHOR")).toBe(1);
    expect(LEGACY_CANCELLATION_ANCHOR).toBe("cancelaciones");
  });

  it("renders the ids as constants, not as repeated string literals", () => {
    // The failure this guards is drift between the page and the links, which
    // only stays impossible while both read the same constant.
    expect(TERMS_SOURCE).not.toContain(`id="${CANCELLATION_POLICY_ANCHOR}"`);
    expect(TERMS_SOURCE).not.toContain(`id="${LEGACY_CANCELLATION_ANCHOR}"`);
  });

  it("builds a path whose fragment the page actually carries", () => {
    expect(cancellationPolicyPath(false)).toBe(`/terms#${CANCELLATION_POLICY_ANCHOR}`);
    // Spanish asks for its variant; the bare URL is the English document.
    expect(cancellationPolicyPath(true)).toBe(`/terms?lang=es#${CANCELLATION_POLICY_ANCHOR}`);
  });

  it("points every link at the current id, not the one kept for old email", () => {
    expect(cancellationPolicyPath(false)).not.toContain(LEGACY_CANCELLATION_ANCHOR);
    expect(cancellationPolicyPath(true)).not.toContain(LEGACY_CANCELLATION_ANCHOR);
  });
});
