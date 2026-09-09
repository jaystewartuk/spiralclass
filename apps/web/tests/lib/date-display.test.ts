import { describe, expect, it } from "vitest";
import { formatBothZones } from "@/lib/date-display";

// Student timezone capture — formatBothZones renders the teacher's wall clock as the canonical
// time and adds the student's wall clock when the per-instant rendering
// differs. Comparison is per-instant (not per-tz-string) so DST-shifted
// zones that happen to coincide on a given date collapse cleanly.

describe("formatBothZones", () => {
  it("returns a single string when teacher and student tzs match", () => {
    // April 14 2026, 10:00 CDMX. Same tz string → single.
    const d = new Date("2026-04-14T16:00:00Z");
    const out = formatBothZones(d, "America/Mexico_City", "America/Mexico_City");
    expect(out).not.toContain("·");
    expect(out).toContain("10:00");
  });

  it("returns a single string when studentTz is null (capture not yet ran)", () => {
    const d = new Date("2026-04-14T16:00:00Z");
    const out = formatBothZones(d, "America/Mexico_City", null);
    expect(out).not.toContain("·");
    expect(out).toContain("10:00");
  });

  it("returns both wall clocks when student tz resolves to a different time", () => {
    // 16:00 UTC = 10:00 CDMX = 12:00 NYC (during EDT).
    const d = new Date("2026-04-14T16:00:00Z");
    const out = formatBothZones(d, "America/Mexico_City", "America/New_York");
    expect(out).toMatch(/10:00/);
    expect(out).toMatch(/12:00/);
    expect(out).toContain("(tu zona)");
    expect(out.split("·")).toHaveLength(2);
  });

  it("collapses to a single string across DST when both zones happen to share a wall clock", () => {
    // Sun July 5 2026, 16:00 UTC. Both Tijuana (PDT, UTC-7) and Mountain
    // Standard (Phoenix, UTC-7) yield 09:00 — different tz strings, same
    // per-instant render, so the helper should collapse.
    const d = new Date("2026-07-05T16:00:00Z");
    const out = formatBothZones(d, "America/Tijuana", "America/Phoenix");
    expect(out).not.toContain("·");
    // 9, not 09 — the hour carries no leading zero in a 12-hour locale (packages/shared/src/time-format.ts).
    expect(out).toContain("9:00");
  });
});
