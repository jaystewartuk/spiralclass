import { describe, expect, it } from "vitest";
import {
  isWebNavActive,
  webAccountMenuLinks,
  webNavGroup,
  webNavHref,
  webNavLink,
  webNavLinks,
  webTabBarLinks,
} from "./nav";

describe("web nav resolver", () => {
  it("maps keys to their web routes", () => {
    expect(webNavHref("leads")).toBe("/dashboard/leads");
    expect(webNavHref("testimonials")).toBe("/dashboard/testimonials");
    expect(webNavHref("materials")).toBe("/dashboard/materials");
    expect(webNavHref("classContentTemplates")).toBe("/settings/class-content-templates");
    expect(webNavHref("paymentMethods")).toBe("/settings/payments");
  });

  it("resolves the public page only with a booking slug", () => {
    expect(webNavHref("publicPage", { bookingSlug: "mira" })).toBe("/b/mira");
    // No slug → a safe non-navigating href rather than a broken "/b/".
    expect(webNavHref("publicPage")).toBe("#");
  });

  it("resolves localized labels and descriptions", () => {
    const leadsEs = webNavLink("leads", "es-MX");
    expect(leadsEs.label).toBe("Interesados");
    expect(leadsEs.description).toMatch(/escribieron/);

    const leadsEn = webNavLink("leads", "en");
    expect(leadsEn.label).toBe("Leads");
  });

  it("exposes the 'Tu página' group led by the page editor, then the public page and growth tools", () => {
    const keys = webNavGroup("page", "en", { bookingSlug: "mira" }).map((l) => l.key);
    // `bookingPage` (edit your page) moved out of config into "Tu página" and
    // leads the group — the page editor belongs with the page, not in settings.
    expect(keys).toEqual([
      "bookingPage",
      "publicPage",
      "leads",
      "testimonials",
      "discounts",
      "referrals",
      "shareGroups",
    ]);
    const byKey = Object.fromEntries(
      webNavGroup("page", "en", { bookingSlug: "mira" }).map((l) => [l.key, l]),
    );
    expect(byKey.bookingPage.href).toBe("/settings/booking-page");
    expect(byKey.publicPage.href).toBe("/b/mira");
    expect(byKey.publicPage.external).toBe(true);
  });

  it("exposes the 'Contenido' group with materials + focus tags + lesson templates", () => {
    const keys = webNavGroup("content", "en").map((l) => l.key);
    // `materialStyle` (D-78) joined the group — AI-material tone/style settings.
    expect(keys).toEqual(["materials", "focusTags", "classContentTemplates", "materialStyle"]);
    const byKey = Object.fromEntries(webNavGroup("content", "en").map((l) => [l.key, l]));
    expect(byKey.materials.href).toBe("/dashboard/materials");
    expect(byKey.classContentTemplates.href).toBe("/settings/class-content-templates");
    expect(byKey.materialStyle.href).toBe("/settings/materials");
    // Not left behind in config.
    expect(webNavGroup("config", "en").map((l) => l.key)).not.toContain("focusTags");
  });

  it("matches active state by prefix, honouring exact for the dashboard root", () => {
    const dashboard = webNavLink("dashboard", "en");
    expect(isWebNavActive(dashboard, "/dashboard")).toBe(true);
    // Exact match: a deeper dashboard route must NOT light up the Panel link.
    expect(isWebNavActive(dashboard, "/dashboard/leads")).toBe(false);

    const leads = webNavLink("leads", "en");
    expect(isWebNavActive(leads, "/dashboard/leads")).toBe(true);
    expect(isWebNavActive(leads, "/dashboard/classes")).toBe(false);
  });

  it("never reports external links as active", () => {
    const publicPage = webNavLink("publicPage", "en", { bookingSlug: "mira" });
    expect(isWebNavActive(publicPage, "/b/mira")).toBe(false);
  });

  it("resolves the mobile-web bottom tab bar's primary task tabs", () => {
    const tabs = webTabBarLinks("es-MX");
    // The shared canonical primary set, in order, resolved to web routes.
    expect(tabs.map((l) => l.key)).toEqual(["dashboard", "classes", "payments", "messages"]);
    const byKey = Object.fromEntries(tabs.map((l) => [l.key, l]));
    expect(byKey.dashboard.href).toBe("/dashboard");
    expect(byKey.classes.href).toBe("/dashboard/classes");
    expect(byKey.payments.href).toBe("/payments");
    expect(byKey.messages.href).toBe("/dashboard/messages");
    // Localized from the shared model.
    expect(byKey.classes.label).toBe("Clases");
    expect(webTabBarLinks("en")[1].label).toBe("Classes");
    // The Panel tab keeps its exact-match semantics so a deeper /dashboard route
    // doesn't light it up.
    expect(byKey.dashboard.exact).toBe(true);
    expect(isWebNavActive(byKey.dashboard, "/dashboard/calendar")).toBe(false);
  });

  it("resolves a curated ordered subset", () => {
    const grid = webNavLinks(["leads", "payments", "account"], "en");
    expect(grid.map((l) => l.key)).toEqual(["leads", "payments", "account"]);
  });

  // Regression: these config-group destinations have no nav link anywhere
  // else on web, so dropping any of them from the account menu makes them
  // unreachable (the settings sub-nav that used to list them was removed).
  it("resolves the account menu with every settings destination that has no link elsewhere", () => {
    const keys = webAccountMenuLinks("en").map((l) => l.key);
    expect(keys).toEqual([
      "account",
      "packages",
      "paymentMethods",
      "billing",
      "notifications",
      "calendarSync",
      "blockedDates",
      "help",
    ]);
    const byKey = Object.fromEntries(webAccountMenuLinks("en").map((l) => [l.key, l]));
    expect(byKey.packages.href).toBe("/settings/templates");
    expect(byKey.packages.label).toBe("Packages");
  });

  // A PAYING teacher must be able to find the page about what she pays.
  //
  // Billing was excluded from this menu on the grounds that it was "reachable
  // from contextual links on their own pages" — and every one of those links
  // is an upsell (the trial/past-due banner, the Pro lock note, the call and
  // replay CTAs), so all four vanish the moment she subscribes. She was then
  // left with an old receipt email or typing the URL: no menu entry, no
  // dashboard tile, and no /settings index to browse.
  //
  // Asserted separately from the list above because the list is about ORDER
  // and this is about REACHABILITY — the property whose absence let a paying
  // customer lose the door to her own invoices.
  it("keeps Plan & billing reachable from a menu, not only from upsells that vanish on upgrade", () => {
    const billing = webAccountMenuLinks("en").find((l) => l.key === "billing");
    expect(billing, "billing must stay in the account menu").toBeDefined();
    expect(billing?.href).toBe("/settings/billing");
    expect(billing?.label).toBe("Subscription");

    // Beside the other money destination, not adrift among the rest: one is
    // how her students pay her, the other is what she pays us.
    const keys = webAccountMenuLinks("en").map((l) => l.key);
    expect(keys.indexOf("billing")).toBe(keys.indexOf("paymentMethods") + 1);
  });

  it("labels the billing destination in every locale", () => {
    expect(webNavLink("billing", "es-MX").label).toBe("Suscripción");
    expect(webNavLink("billing", "fr").label).toBe("Abonnement");
  });
});
