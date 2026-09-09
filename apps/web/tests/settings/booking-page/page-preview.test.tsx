import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { LocaleProvider } from "@/components/locale-provider";
import {
  BookingPagePreview,
  type PreviewOffering,
} from "@/app/(app)/settings/booking-page/page-preview";
import { BookingPageDraftProvider } from "@/app/(app)/settings/booking-page/preview-context";

(globalThis as Record<string, unknown>).React = React;

// The preview is a second rendering of the public hero, so the thing worth
// guarding is that it renders the hero's rules and not the dashboard's — above
// all the locale one. CLAUDE.md records the split-language funnel bug twice:
// what her BUYERS read is `booking_page_locale`, never her own `locale`. A
// preview drawn in her language would show her a page no visitor ever sees.

const OFFERING: PreviewOffering = {
  priceMinorUnits: 60000,
  currency: "MXN",
  classCount: 4,
  classDurationMin: 50,
  singleClass: false,
};

function render(
  props: Partial<React.ComponentProps<typeof BookingPagePreview>> = {},
  teacherLocale: "en" | "es-MX" | "fr" = "es-MX",
) {
  return renderToStaticMarkup(
    React.createElement(
      LocaleProvider,
      // `children: null` satisfies the prop type; createElement's third
      // argument is what actually supplies them.
      { locale: teacherLocale, children: null },
      React.createElement(BookingPagePreview, {
        name: "Alicia Moreno",
        photoUrl: null,
        initialHeadline: null,
        initialBio: null,
        timezone: "America/Mexico_City",
        offering: OFFERING,
        hasVideo: false,
        hasWhatsapp: false,
        funnelLocale: "en",
        displayUrl: "spiralclass.com/b/mira",
        ...props,
      }),
    ),
  );
}

describe("BookingPagePreview — whose language it speaks", () => {
  it("renders the visitor's copy in the booking-page locale, not the teacher's", () => {
    // Her dashboard is Spanish; her buyers read English. Both are true at once —
    // this is a configuration a real teacher runs.
    const html = render({}, "es-MX");
    expect(html).toContain("Classes with Alicia Moreno");
    expect(html).not.toContain("Clases con");
  });

  it("follows the booking-page locale wherever it points", () => {
    const html = render({ funnelLocale: "fr" }, "en");
    expect(html).toContain("Cours avec Alicia Moreno");
    expect(html).not.toContain("Classes with Alicia Moreno");
  });

  it("prices in the booking-page locale too", () => {
    const html = render({ funnelLocale: "en" });
    expect(html).toContain("600.00");
  });
});

describe("BookingPagePreview — faithfulness to the public hero", () => {
  it("falls back to the same monogram /b/&lt;slug&gt; draws when there is no photo", () => {
    expect(render({ photoUrl: null })).toContain("AM");
  });

  it("shows the headline she wrote instead of the fallback", () => {
    const html = render({ initialHeadline: "Spanish that survives Monday" });
    expect(html).toContain("Spanish that survives Monday");
    expect(html).not.toContain("Classes with Alicia Moreno");
  });

  it("quotes the cheapest package the way the hero's badges do", () => {
    expect(render()).toContain("4 classes × 50 min");
  });

  it("drops the price and duration badges when there is no package to quote", () => {
    const html = render({ offering: null });
    expect(html).not.toContain("50 min");
    // The timezone badge does not depend on a package and stays.
    expect(html).toContain("Mexico City");
  });

  it("shows the WhatsApp button only once a number is published", () => {
    expect(render({ hasWhatsapp: false })).not.toContain("WhatsApp");
    expect(render({ hasWhatsapp: true })).toContain("WhatsApp");
  });
});

describe("BookingPagePreview — unsaved text", () => {
  it("reads the live draft rather than the persisted value", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        LocaleProvider,
        { locale: "en" as const, children: null },
        React.createElement(
          BookingPageDraftProvider,
          { initialHeadline: "Old headline", initialBio: "Old bio", children: null },
          React.createElement(BookingPagePreview, {
            name: "Alicia Moreno",
            photoUrl: null,
            initialHeadline: "Old headline",
            initialBio: "Old bio",
            timezone: "America/Mexico_City",
            offering: null,
            hasVideo: false,
            hasWhatsapp: false,
            funnelLocale: "en" as const,
            displayUrl: "spiralclass.com/b/mira",
          }),
        ),
      ),
    );
    expect(html).toContain("Old headline");
    expect(html).toContain("Old bio");
  });

  it("marks an empty bio as a placeholder rather than rendering a blank hero", () => {
    // And the placeholder is EDITOR copy, so it speaks the teacher's language
    // while the hero around it speaks her buyers'. Both locales are live in one
    // component; asserting them together is what stops either leaking into the
    // other.
    const html = render({ initialBio: "   " }, "es-MX");
    expect(html).toContain("Aquí aparece tu descripción.");
    expect(html).toContain("Classes with Alicia Moreno");
  });
});
