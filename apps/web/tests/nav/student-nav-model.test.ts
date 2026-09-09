import { describe, expect, it } from "vitest";
import { LOCALES } from "@spiralclass/shared";
import {
  isStudentNavActive,
  STUDENT_ACCOUNT_HREF,
  STUDENT_ACCOUNT_KEYS,
  STUDENT_NAV_ITEMS,
  STUDENT_PRIMARY_KEYS,
  studentNavLinks,
  type StudentNavItem,
} from "@/lib/student-nav";

// The student portal's information architecture, which the header bar, the
// avatar menu and the phone drawer all render from. These pin the properties
// those three surfaces depend on and that the type system cannot state.

const item = (key: string): StudentNavItem => {
  const found = STUDENT_NAV_ITEMS.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no such key: ${key}`);
  return found;
};

describe("student nav model", () => {
  it("gives every destination a unique key, an icon and a label in every locale", () => {
    const keys = STUDENT_NAV_ITEMS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const nav of STUDENT_NAV_ITEMS) {
      expect(nav.icon, `${nav.key} has no icon`).toBeTruthy();
      for (const locale of LOCALES) {
        // An untranslated row would render `undefined` in the drawer.
        expect(nav.label[locale.tag], `${nav.key} missing ${locale.tag}`).toBeTruthy();
      }
    }
  });

  it("lists every destination exactly once across the two rendered groups", () => {
    // The drawer renders primary + account. A key in neither is unreachable on
    // a phone; a key in both renders twice in the same list.
    const rendered = [...STUDENT_PRIMARY_KEYS, ...STUDENT_ACCOUNT_KEYS];
    expect(new Set(rendered).size).toBe(rendered.length);
    expect([...rendered].sort()).toEqual(STUDENT_NAV_ITEMS.map((i) => i.key).sort());
  });

  it("points the account card at the account page", () => {
    expect(STUDENT_ACCOUNT_HREF).toBe(item("account").href);
  });

  describe("active state", () => {
    it("marks the destination whose section you are in", () => {
      expect(isStudentNavActive(item("calendar"), "/my-classes/calendar")).toBe(true);
      expect(isStudentNavActive(item("materials"), "/my-classes/materials/abc")).toBe(true);
      expect(isStudentNavActive(item("account"), "/my-classes/account")).toBe(true);
    });

    it("gives Classes every /my-classes path that no other destination owns", () => {
      // The booking detail, reservar and reagendar screens all belong to the
      // classes flow; leaving them unmatched lit nothing in the nav at all.
      for (const path of ["/my-classes", "/my-classes/abc-123", "/my-classes/reservar"]) {
        expect(isStudentNavActive(item("classes"), path), path).toBe(true);
      }
    });

    it("never lights Classes on another destination's page", () => {
      for (const other of STUDENT_NAV_ITEMS.filter((i) => i.key !== "classes")) {
        expect(isStudentNavActive(item("classes"), other.href), other.key).toBe(false);
      }
    });

    it("lights exactly one destination for any given path", () => {
      const paths = [
        "/my-classes",
        "/my-classes/calendar",
        "/my-classes/materials",
        "/my-classes/progress",
        "/my-classes/messages",
        "/my-classes/teachers",
        "/my-classes/account",
        "/my-classes/some-booking-id",
      ];
      for (const path of paths) {
        const lit = STUDENT_NAV_ITEMS.filter((nav) => isStudentNavActive(nav, path));
        expect(
          lit.map((nav) => nav.key),
          path,
        ).toHaveLength(1);
      }
    });
  });

  describe("studentNavLinks", () => {
    it("resolves labels in the requested locale, in the order asked for", () => {
      const links = studentNavLinks(["messages", "classes"], "fr", "/my-classes");
      expect(links.map((l) => l.key)).toEqual(["messages", "classes"]);
      expect(links.map((l) => l.label)).toEqual(["Messages", "Cours"]);
    });

    it("uses the attribution href for the calendar while still matching active by path", () => {
      // calendar_viewed's entry_point property is read off `?ref=nav`; the
      // query string must not leak into active-state matching.
      const [calendar] = studentNavLinks(["calendar"], "en", "/my-classes/calendar");
      expect(calendar.href).toBe("/my-classes/calendar?ref=nav");
      expect(calendar.active).toBe(true);
    });

    it("throws on an unknown key rather than rendering a blank row", () => {
      // @ts-expect-error — the point is the runtime behaviour off the happy path.
      expect(() => studentNavLinks(["nope"], "en", "/my-classes")).toThrow(/nope/);
    });
  });
});
