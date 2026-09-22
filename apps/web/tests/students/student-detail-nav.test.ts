import { describe, expect, it } from "vitest";
import {
  DEFAULT_STUDENT_TAB,
  STUDENT_TABS,
  resolveStudentTab,
  studentDetailHref,
} from "@/app/(app)/dashboard/students/[studentId]/student-detail-nav";
import { parseMaterialsFilter, parseMaterialsGroupBy } from "@/lib/materials/student-materials";

// The student screen's five views are URL state, so the URL is the contract:
// what a `?tab=` value resolves to, and what the links the page emits actually
// say. Both halves are pure, and both are round-tripped here — a builder that
// emits a value the parser rejects is a link that silently lands somewhere else.

describe("resolveStudentTab", () => {
  it("accepts every registered tab", () => {
    for (const tab of STUDENT_TABS) expect(resolveStudentTab(tab)).toBe(tab);
  });

  it("falls back to the default rather than erroring on anything else", () => {
    // A stale bookmark, a hand-edited URL, or a `?tab=` duplicated into an
    // array by the framework. None of these should cost a teacher her student.
    for (const raw of [undefined, "", "contact", "OVERVIEW", "../settings"]) {
      expect(resolveStudentTab(raw)).toBe(DEFAULT_STUDENT_TAB);
    }
    expect(resolveStudentTab(["packages", "settings"])).toBe("packages");
  });
});

describe("studentDetailHref", () => {
  it("leaves the default view's URL clean, so the shareable link is the plain one", () => {
    expect(studentDetailHref("s1")).toBe("/dashboard/students/s1");
    expect(studentDetailHref("s1", DEFAULT_STUDENT_TAB)).toBe("/dashboard/students/s1");
  });

  it("names every other view", () => {
    expect(studentDetailHref("s1", "packages")).toBe("/dashboard/students/s1?tab=packages");
    expect(studentDetailHref("s1", "settings")).toBe("/dashboard/students/s1?tab=settings");
  });

  it("carries the materials filters, omitting the ones already default", () => {
    expect(studentDetailHref("s1", "materials", { filter: "all", groupBy: "class" })).toBe(
      "/dashboard/students/s1?tab=materials",
    );
    expect(studentDetailHref("s1", "materials", { filter: "used", groupBy: "type" })).toBe(
      "/dashboard/students/s1?tab=materials&mf=used&mg=type",
    );
  });

  it("round-trips: every link it builds parses back to what it was asked for", () => {
    for (const tab of STUDENT_TABS) {
      for (const filter of ["all", "sent", "used"] as const) {
        for (const groupBy of ["class", "date", "type"] as const) {
          const url = new URL(
            studentDetailHref("s1", tab, { filter, groupBy }),
            "https://spiralclass.com",
          );
          expect(resolveStudentTab(url.searchParams.get("tab") ?? undefined)).toBe(tab);
          expect(parseMaterialsFilter(url.searchParams.get("mf") ?? undefined)).toBe(filter);
          expect(parseMaterialsGroupBy(url.searchParams.get("mg") ?? undefined)).toBe(groupBy);
        }
      }
    }
  });
});
