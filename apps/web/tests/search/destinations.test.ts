import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { createT, LOCALES, NAV_ITEMS, type AppLocale } from "@spiralclass/shared";
import { indexSearchEntries, searchEntries } from "@/lib/search/match";
import { studentDestinations } from "@/lib/search/student-destinations";
import { teacherDestinations } from "@/lib/search/teacher-destinations";

// "Search for a page" is only as good as its coverage. The feature exists
// because a teacher could not find the day plan, a page no menu linked to —
// so the property worth pinning is that EVERY page on her side of the product
// is findable, and that one added later cannot quietly not be.
//
// These walk the route tree on disk rather than a hand-kept list: a new
// page.tsx under (app)/ or (student)/ fails here until it is searchable or
// named below with the reason it is not.

const APP_DIR = join(__dirname, "..", "..", "src", "app");

/** Every static page route in a route group, as a URL path. */
function staticRoutes(group: string): string[] {
  const root = join(APP_DIR, group);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "page.tsx") {
        const rel = relative(root, dir).split(sep).filter(Boolean);
        // A dynamic segment is a record (one class, one student), found
        // through the records index, not a page to list.
        if (rel.some((segment) => segment.startsWith("["))) continue;
        found.push(`/${rel.join("/")}`);
      }
    }
  };
  walk(root);
  return found.sort();
}

function pageFileFor(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return ["(app)", "(student)", ""].some((group) =>
    existsSync(join(APP_DIR, group, ...segments, "page.tsx")),
  );
}

const pathOf = (href: string) => href.split(/[?#]/)[0] ?? href;

// Pages deliberately left out of search, each with its reason.
const TEACHER_NOT_SEARCHABLE: Record<string, string> = {
  // Onboarding is a one-time stepper with its own chrome; the search box is
  // not even rendered there.
  "/onboarding/availability": "onboarding",
  "/onboarding/preview": "onboarding",
  "/onboarding/reading": "onboarding",
  "/onboarding/templates": "onboarding",
  "/onboarding/timezone": "onboarding",
  // A permanent redirect to /dashboard/get-students/communities, which is
  // searchable as "Communities".
  "/dashboard/share-groups": "redirect",
};

const STUDENT_NOT_SEARCHABLE: Record<string, string> = {
  // Reached only as the result of booking; alone it has nothing to show.
  "/my-classes/book/confirmation": "post-booking receipt",
};

const t = (locale: AppLocale) => createT(locale);

describe("teacher destinations", () => {
  const all = teacherDestinations({ locale: "en", t: t("en"), bookingSlug: "ana" });

  it("includes every destination in the shared nav registry", () => {
    const ids = new Set(all.map((d) => d.id));
    for (const item of NAV_ITEMS) expect(ids, item.key).toContain(`nav.${item.key}`);
  });

  it("drops the public page when there is no booking slug to send her to", () => {
    const noSlug = teacherDestinations({ locale: "en", t: t("en") });
    expect(noSlug.map((d) => d.id)).not.toContain("nav.publicPage");
  });

  it("makes every static teacher page findable, or says why not", () => {
    const reachable = new Set(all.map((d) => pathOf(d.href)));
    for (const route of staticRoutes("(app)")) {
      if (TEACHER_NOT_SEARCHABLE[route]) continue;
      expect(reachable, `${route} is not searchable`).toContain(route);
    }
  });

  it("names no excluded page that no longer exists", () => {
    const routes = new Set(staticRoutes("(app)"));
    for (const route of Object.keys(TEACHER_NOT_SEARCHABLE)) expect(routes).toContain(route);
  });

  it("points every in-app destination at a page that exists", () => {
    for (const d of all.filter((d) => !d.external)) {
      expect(pageFileFor(pathOf(d.href)), `${d.id} → ${d.href}`).toBe(true);
    }
  });

  it("has unique ids, a label, an icon and search words in every locale", () => {
    for (const locale of LOCALES) {
      const list = teacherDestinations({ locale: locale.tag, t: t(locale.tag), bookingSlug: "a" });
      expect(new Set(list.map((d) => d.id)).size).toBe(list.length);
      for (const d of list) {
        expect(d.label.trim(), `${d.id} label (${locale.tag})`).toBeTruthy();
        expect(d.terms?.trim(), `${d.id} terms (${locale.tag})`).toBeTruthy();
        expect(d.icon, `${d.id} icon`).toBeTruthy();
      }
    }
  });

  it("offers suggestions before she types, led by the pages that prompted the feature", () => {
    const suggested = all.filter((d) => d.suggested).map((d) => d.id);
    expect(suggested).toEqual(
      expect.arrayContaining([
        "nav.students",
        "nav.packages",
        "action.planDay",
        "action.addStudent",
      ]),
    );
  });

  // The words a teacher actually used when she asked for this.
  it.each([
    ["en", "students", "nav.students"],
    ["en", "packet", "nav.packages"],
    ["en", "plan my day", "action.planDay"],
    ["en", "plan the day", "action.planDay"],
    ["en", "holiday", "nav.blockedDates"],
    ["en", "prices", "nav.packages"],
    // Another locale's label still finds it — screens in English, habit in Spanish.
    ["en", "paquetes", "nav.packages"],
    ["es", "paquete", "nav.packages"],
    ["es", "plan del dia", "action.planDay"],
    ["es", "alumnos", "nav.students"],
    ["fr", "forfait", "nav.packages"],
  ] as const)("in %s, '%s' finds %s first", (locale, query, expected) => {
    const index = indexSearchEntries(
      teacherDestinations({ locale, t: t(locale), bookingSlug: "a" }),
    );
    expect(searchEntries(index, query)[0]?.id).toBe(expected);
  });
});

describe("student destinations", () => {
  const all = studentDestinations({ locale: "en", t: t("en") });

  it("makes every static portal page findable, or says why not", () => {
    const reachable = new Set(all.map((d) => pathOf(d.href)));
    for (const route of staticRoutes("(student)")) {
      if (STUDENT_NOT_SEARCHABLE[route]) continue;
      expect(reachable, `${route} is not searchable`).toContain(route);
    }
  });

  it("points every destination at a page that exists", () => {
    for (const d of all) {
      expect(pageFileFor(pathOf(d.href)) || d.href.startsWith("/help/"), d.href).toBe(true);
    }
  });

  it("has unique ids, a label and search words in every locale", () => {
    for (const locale of LOCALES) {
      const list = studentDestinations({ locale: locale.tag, t: t(locale.tag) });
      expect(new Set(list.map((d) => d.id)).size).toBe(list.length);
      for (const d of list) {
        expect(d.label.trim(), `${d.id} label (${locale.tag})`).toBeTruthy();
        expect(d.terms?.trim(), `${d.id} terms (${locale.tag})`).toBeTruthy();
      }
    }
  });

  it.each([
    ["en", "book", "action.book"],
    ["en", "homework", "nav.materials"],
    ["es", "profe", "nav.teachers"],
  ] as const)("in %s, '%s' finds %s first", (locale, query, expected) => {
    const index = indexSearchEntries(studentDestinations({ locale, t: t(locale) }));
    expect(searchEntries(index, query)[0]?.id).toBe(expected);
  });
});
