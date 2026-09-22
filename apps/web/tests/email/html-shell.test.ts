import { describe, expect, it } from "vitest";
import { renderBrandedEmailHtml } from "@/lib/email/html-shell";

// html-shell builds the branded chrome for transactional emails. The hrefs are
// app-built today, but `safeHref` is defense-in-depth: only http(s)/mailto (and
// scheme-relative / path-relative) URLs survive; anything with an active scheme
// (javascript:, data:, vbscript:) collapses to "#" so it can't smuggle a
// payload into a client that honours such schemes.

function render(url: string): string {
  return renderBrandedEmailHtml(
    {
      preheader: "pre",
      heading: "Hi",
      paragraphs: ["body"],
      cta: { label: "Open", url },
    },
    { languageCode: "en" },
  );
}

describe("renderBrandedEmailHtml — safeHref", () => {
  it("keeps legitimate https links", () => {
    const html = render("https://spiralclass.com/r/abc123");
    expect(html).toContain('href="https://spiralclass.com/r/abc123"');
  });

  it("keeps mailto links", () => {
    const html = render("mailto:support@spiralclass.com");
    expect(html).toContain('href="mailto:support@spiralclass.com"');
  });

  it("keeps path-relative links (no scheme)", () => {
    const html = render("/my-classes");
    expect(html).toContain('href="/my-classes"');
  });

  it("neutralizes javascript: URLs to #", () => {
    const html = render("javascript:alert(1)");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="#"');
  });

  it("neutralizes data: URLs to #", () => {
    const html = render("data:text/html,<script>alert(1)</script>");
    expect(html).not.toContain("data:text/html");
    expect(html).toContain('href="#"');
  });

  it("neutralizes a scheme regardless of case / leading whitespace", () => {
    const html = render("  JaVaScRiPt:alert(1)");
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(html).toContain('href="#"');
  });

  it("still HTML-escapes a safe URL with reserved chars", () => {
    const html = render("https://spiralclass.com/r?a=1&b=2");
    expect(html).toContain("https://spiralclass.com/r?a=1&amp;b=2");
  });
});

describe("html-shell avatar + bullets (invitation email)", () => {
  it("renders an https avatar image and check-marked bullets", () => {
    const html = renderBrandedEmailHtml(
      {
        preheader: "pre",
        heading: "Invited",
        paragraphs: ["hi"],
        avatarUrl: "https://cdn.example.com/mira.jpg",
        bullets: ["Book classes", "Get homework"],
      },
      { languageCode: "en" },
    );
    expect(html).toContain("https://cdn.example.com/mira.jpg");
    expect(html).toContain("border-radius:9999px");
    expect(html).toContain("Book classes");
    expect(html).toContain("Get homework");
  });

  it("drops a non-https avatar (no broken image)", () => {
    const html = renderBrandedEmailHtml(
      {
        preheader: "pre",
        heading: "Invited",
        paragraphs: ["hi"],
        avatarUrl: "javascript:alert(1)",
      },
      { languageCode: "en" },
    );
    expect(html).not.toContain("javascript:alert(1)");
  });
});
