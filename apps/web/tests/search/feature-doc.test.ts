import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_RESULT_LIMIT, PER_KIND_LIMIT } from "@/lib/search/match";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const { CLASS_WINDOW_FUTURE_DAYS, CLASS_WINDOW_PAST_DAYS, RECORD_LIMITS } =
  await import("@/lib/search/teacher-records");

// docs/features/search.md states the index's bounds as numbers, because a
// teacher asking "why can't search find last spring's class?" deserves one.
// A number in a document drifts from the constant it describes unless
// something reads both; this does.

const DOC = readFileSync(
  join(__dirname, "..", "..", "..", "..", "docs", "features", "search.md"),
  "utf8",
);

describe("docs/features/search.md", () => {
  it("states the class window the index uses", () => {
    expect(DOC).toContain(
      `from ${CLASS_WINDOW_PAST_DAYS} days back to ${CLASS_WINDOW_FUTURE_DAYS} days ahead`,
    );
  });

  it("states the lead and material bounds", () => {
    expect(DOC).toContain(`Her ${RECORD_LIMITS.leads} most recent leads`);
    expect(DOC).toContain(`Her ${RECORD_LIMITS.materials} most recent library items`);
  });

  it("states the result limits", () => {
    expect(DOC).toContain(`At most ${DEFAULT_RESULT_LIMIT} results`);
    expect(DOC).toContain(
      `${PER_KIND_LIMIT.class} classes and ${PER_KIND_LIMIT.help} help answers`,
    );
  });
});
