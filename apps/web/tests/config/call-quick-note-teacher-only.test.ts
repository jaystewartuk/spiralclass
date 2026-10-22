import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The in-call quick note writes to the teacher's own focus areas, so only her
// call page may hand the call a way to save one. A student page passing
// `onQuickNote` would put the control on a student's screen.
const root = join(__dirname, "../../src");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("the in-call quick note is teacher-only", () => {
  it("is wired by the teacher's call page", () => {
    const page = read("app/(app)/dashboard/classes/[bookingId]/call/page.tsx");
    expect(page).toContain("onQuickNote={addInsight.bind(null, booking.id)}");
  });

  it("is never wired by the student's call page", () => {
    expect(read("app/(student)/my-classes/[bookingId]/call/page.tsx")).not.toContain("onQuickNote");
  });

  it("is also gated on the role inside the call", () => {
    const call = read("components/video/class-call.tsx");
    expect(call).toContain('onQuickNote && role !== "student"');
  });
});
