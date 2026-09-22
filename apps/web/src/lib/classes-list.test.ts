import { describe, expect, it } from "vitest";
import {
  CLASS_SEARCH_MAX_LENGTH,
  SOON_WINDOW_MINUTES,
  classProximity,
  classesHref,
  normalizeClassSearch,
  proximityLabel,
  resolveClassesScope,
} from "@/lib/classes-list";

const NOW = new Date("2026-09-01T15:00:00.000Z");
const at = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000);

describe("resolveClassesScope", () => {
  it("accepts the three known views", () => {
    expect(resolveClassesScope("upcoming")).toBe("upcoming");
    expect(resolveClassesScope("materials")).toBe("materials");
    expect(resolveClassesScope("past")).toBe("past");
  });

  it("falls back to upcoming for anything else", () => {
    // A view preference, not a resource: a stale bookmark or a hand-edited URL
    // should still show the teacher her classes rather than an error.
    expect(resolveClassesScope(undefined)).toBe("upcoming");
    expect(resolveClassesScope("")).toBe("upcoming");
    expect(resolveClassesScope("PAST")).toBe("upcoming");
    expect(resolveClassesScope("../../etc/passwd")).toBe("upcoming");
  });

  it("takes the first value when the parameter is repeated", () => {
    expect(resolveClassesScope(["past", "materials"])).toBe("past");
  });
});

describe("normalizeClassSearch", () => {
  it("returns an empty string for no search", () => {
    expect(normalizeClassSearch(undefined)).toBe("");
    expect(normalizeClassSearch("   ")).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeClassSearch("  Marcela ")).toBe("Marcela");
  });

  it("caps the term so a `contains` filter cannot be handed an essay", () => {
    const long = "a".repeat(CLASS_SEARCH_MAX_LENGTH + 40);
    expect(normalizeClassSearch(long)).toHaveLength(CLASS_SEARCH_MAX_LENGTH);
  });

  it("takes the first value when the parameter is repeated", () => {
    expect(normalizeClassSearch(["Mira", "Bea"])).toBe("Mira");
  });
});

describe("classesHref", () => {
  it("omits the default scope, so the canonical list has a bare URL", () => {
    expect(classesHref("upcoming")).toBe("/dashboard/classes");
  });

  it("names any other scope", () => {
    expect(classesHref("past")).toBe("/dashboard/classes?show=past");
  });

  it("carries the search term through a scope change", () => {
    // The toolbar builds every tab link with this, so searching from "Past"
    // and then switching view keeps what was typed.
    expect(classesHref("materials", "Marcela")).toBe("/dashboard/classes?show=materials&q=Marcela");
    expect(classesHref("upcoming", "Alicia Moreno")).toBe("/dashboard/classes?q=Alicia+Moreno");
  });
});

describe("classProximity", () => {
  it("calls a class live from its start until its end", () => {
    expect(classProximity(at(0), at(50), NOW).state).toBe("live");
    expect(classProximity(at(-49), at(1), NOW).state).toBe("live");
  });

  it("stops calling it live the instant it ends", () => {
    // The half-open interval matters: the auto-complete sweep runs hourly, so
    // a class sits `scheduled` for up to an hour after this boundary and must
    // not keep claiming to be in progress.
    expect(classProximity(at(-50), at(0), NOW).state).toBe("later");
  });

  it("reports the minutes to a class inside the soon window", () => {
    expect(classProximity(at(20), at(70), NOW)).toEqual({ state: "soon", minutes: 20 });
    expect(classProximity(at(SOON_WINDOW_MINUTES), at(SOON_WINDOW_MINUTES + 50), NOW)).toEqual({
      state: "soon",
      minutes: SOON_WINDOW_MINUTES,
    });
  });

  it("says nothing about a class beyond the soon window", () => {
    const start = at(SOON_WINDOW_MINUTES + 1);
    expect(classProximity(start, at(SOON_WINDOW_MINUTES + 51), NOW).state).toBe("later");
  });
});

describe("proximityLabel", () => {
  it("has no countdown for a live or distant class", () => {
    expect(proximityLabel({ state: "live" })).toBeNull();
    expect(proximityLabel({ state: "later" })).toBeNull();
  });

  it("says 'starting now' inside the last minute", () => {
    // classProximity rounds to whole minutes, so a class 40 seconds out lands
    // on zero — which must not render as "starts in 0 min".
    expect(proximityLabel({ state: "soon", minutes: 0 })).toEqual({ key: "classes.relative.now" });
  });

  it("counts minutes below the hour", () => {
    expect(proximityLabel({ state: "soon", minutes: 45 })).toEqual({
      key: "classes.relative.minutes",
      vars: { n: 45 },
    });
  });

  it("floors the hours rather than rounding them", () => {
    // 95 minutes is "1h", never "2h": understating leaves her early, and
    // overstating makes her late.
    expect(proximityLabel({ state: "soon", minutes: 95 })).toEqual({
      key: "classes.relative.hours",
      vars: { n: 1 },
    });
    expect(proximityLabel({ state: "soon", minutes: 60 })).toEqual({
      key: "classes.relative.hours",
      vars: { n: 1 },
    });
  });
});
