import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// `pnpm call:local` moves one class to now. Picking the earliest scheduled class
// meant a rerun within the hour chose an older one, moved it on top of the class
// the last run had moved, and died on the exclusion constraint.
describe("scripts/local-call.sh", () => {
  it("reuses the scheduled class nearest to now", () => {
    const script = readFileSync(resolve(__dirname, "../../../../scripts/local-call.sh"), "utf8");
    expect(script).toContain("order by abs(extract(epoch from b.scheduled_start - now()))");
    expect(script).not.toContain("order by b.scheduled_start limit 1");
  });
});
