import { describe, expect, it } from "vitest";
import { checkLinks, extractLinks, normalizePath } from "../../scripts/check-links.mjs";

// Runs the internal-link checker as part of the unit tier, so a typo'd href
// fails the PR that introduced it rather than a user's click months later.
//
// The extraction/normalisation cases below exist because the checker's value
// depends entirely on its precision. It is deliberately blind to dynamic hrefs
// (template literals, variables) — if that blindness ever inverts into
// over-matching, the check starts reporting links that are actually fine, and a
// noisy gate is a gate someone turns off. These lock the boundary in both
// directions: catch the literal, ignore the expression.

describe("extractLinks", () => {
  it("finds a plain string href", () => {
    expect(extractLinks('<Link href="/dashboard/classes">Clases</Link>')).toEqual([
      "/dashboard/classes",
    ]);
  });

  it("finds a braced string literal href", () => {
    expect(extractLinks('<Link href={"/settings/billing"}>Billing</Link>')).toEqual([
      "/settings/billing",
    ]);
  });

  it("ignores template literals — the path is not knowable statically", () => {
    expect(extractLinks("<Link href={`/students/${id}`}>Student</Link>")).toEqual([]);
  });

  it("ignores variable hrefs", () => {
    expect(extractLinks("<Link href={route}>Go</Link>")).toEqual([]);
  });

  it("ignores external and protocol-relative links", () => {
    const source = `
      <a href="https://stripe.com">Stripe</a>
      <a href="mailto:hola@spiralclass.com">Email</a>
      <a href="tel:+525555555555">Call</a>
    `;
    expect(extractLinks(source)).toEqual([]);
  });

  it("finds every link in a block, not just the first", () => {
    const source = '<a href="/pricing">Precios</a><a href="/about">About</a>';
    expect(extractLinks(source)).toEqual(["/pricing", "/about"]);
  });
});

describe("normalizePath", () => {
  it("strips a query string", () => {
    expect(normalizePath("/b/alicia-moreno?ref=abc")).toBe("/b/alicia-moreno");
  });

  it("strips a fragment", () => {
    expect(normalizePath("/pricing#founding")).toBe("/pricing");
  });

  it("strips both", () => {
    expect(normalizePath("/help/teacher?x=1#section")).toBe("/help/teacher");
  });

  it("leaves a bare path alone", () => {
    expect(normalizePath("/dashboard")).toBe("/dashboard");
  });
});

describe("internal links", () => {
  it("every hardcoded internal link resolves to a real route", () => {
    const { broken, checked, routes } = checkLinks();

    expect(
      broken,
      broken.length
        ? `\n${broken.length} internal link(s) point at no route:\n\n` +
            broken.map(({ href, file }) => `  ${href}\n    in ${file}`).join("\n\n") +
            `\n\nEither the path is a typo, or the route moved and this link did not.\n`
        : "",
    ).toEqual([]);

    // Guard against the checker silently becoming a no-op — an extraction regex
    // that stops matching, or a route walk that returns nothing, would make the
    // assertion above trivially true.
    expect(checked).toBeGreaterThan(50);
    expect(routes.length).toBeGreaterThan(100);
  });
});
