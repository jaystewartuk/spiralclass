import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetHourStyleCache,
  formatTimeInZone,
  hourStyleFor,
  timeOptionsFor,
} from "./time-format";

beforeEach(() => __resetHourStyleCache());

// 17:00 in Mexico City on a winter Tuesday, and 09:00 the same morning.
const AFTERNOON = new Date("2026-01-06T23:00:00.000Z");
const MORNING = new Date("2026-01-06T15:00:00.000Z");
const MX = "America/Mexico_City";

describe("hourStyleFor", () => {
  it("keeps the leading zero on a 24-hour locale, so a column of times aligns", () => {
    // `fr` is the registry's only 24-hour locale. `09:00` and `17:00` have to
    // stay the same width or the time grid's hour gutter and every agenda rail
    // stop lining up — which is why the rule is not simply "always numeric".
    expect(hourStyleFor("fr")).toBe("2-digit");
  });

  it("drops it on a 12-hour locale, where the meridiem has already spent the width", () => {
    // BOTH of the registry's other locales, es-MX included. Mexico writes
    // "5:00 p.m." — CLDR puts es-MX on h12, not h23. That is the fact an
    // author is most likely to get wrong from memory, and the reason this
    // module measures the locale instead of carrying a list of them.
    expect(hourStyleFor("en-US")).toBe("numeric");
    expect(hourStyleFor("es-MX")).toBe("numeric");
  });

  it("falls back to the previous behaviour rather than guessing on a locale it cannot read", () => {
    // An unresolvable tag must render as it always has, not differently and
    // silently — the failure mode being avoided is a runtime with a partial
    // Intl (Hermes) quietly changing every timestamp in the app.
    expect(hourStyleFor("not-a-locale-!!")).toBe("2-digit");
  });

  it("memoises per locale, because this runs inside render", () => {
    expect(hourStyleFor("en-US")).toBe(hourStyleFor("en-US"));
  });
});

describe("formatTimeInZone", () => {
  it("writes five in the afternoon the way an English reader writes it", () => {
    // The bug this fixes: `hour: "2-digit"` forced "05:00 PM" on the teacher's
    // calendar while the public checkout, which had independently chosen
    // `numeric`, rendered "5:00 PM" for the same class.
    expect(formatTimeInZone(AFTERNOON, MX, "en-US")).toBe("5:00 PM");
    expect(formatTimeInZone(MORNING, MX, "en-US")).toBe("9:00 AM");
  });

  it("writes it the way a Mexican reader writes it", () => {
    // The change the platform's one Spanish-reading teacher actually sees:
    // "05:00 p.m." → "5:00 p.m.".
    expect(formatTimeInZone(AFTERNOON, MX, "es-MX")).toBe("5:00 p.m.");
    expect(formatTimeInZone(MORNING, MX, "es-MX")).toBe("9:00 a.m.");
  });

  it("leaves a 24-hour locale exactly as it was", () => {
    expect(formatTimeInZone(AFTERNOON, MX, "fr")).toBe("17:00");
    expect(formatTimeInZone(MORNING, MX, "fr")).toBe("09:00");
  });

  it("respects the zone, not the runtime's", () => {
    expect(formatTimeInZone(AFTERNOON, "UTC", "fr")).toBe("23:00");
  });
});

describe("timeOptionsFor", () => {
  it("spreads into a larger options bag without carrying a date with it", () => {
    expect(timeOptionsFor("fr")).toEqual({ hour: "2-digit", minute: "2-digit" });
    expect(timeOptionsFor("es-MX")).toEqual({ hour: "numeric", minute: "2-digit" });
  });

  it("composes with a date part, which is why it is options and not a string", () => {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: MX,
      day: "numeric",
      month: "short",
      ...timeOptionsFor("en-US"),
    });
    expect(fmt.format(AFTERNOON)).toContain("5:00 PM");
  });
});
