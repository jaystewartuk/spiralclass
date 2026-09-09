import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Nothing may be painted over the transcript panel's close button.
 *
 * WHY. `CaptionTranscript` is a sibling of the stage's floating controls at
 * `absolute right-0 top-0 z-30`, and its close button sits in that panel's
 * header at the top-right inset. The stage's own floating controls live at
 * `right-4 top-4 z-30` (minimize) and `right-16 top-4 z-30` (pop-out) — the
 * SAME stacking context and the SAME z-index — and they render LATER in the
 * file, so they paint on top of the panel's header.
 *
 * The failure that produced this test: on a live call the reader taps the ×
 * she can see, minimises the whole call instead, and the transcript stays up.
 * `Escape` also closes the panel, so on a laptop it reads as a cosmetic
 * overlap. On a phone there is no Escape key and the panel — `w-full` below
 * `max-w-sm` — is covering the other person's face with no way to dismiss it.
 * During a lesson that is not a cosmetic problem.
 *
 * The fix is to not render a control that cannot be used while a panel owns
 * the right edge, which is the same thing `canMinimize` already does for a
 * material or a screen share. This test is here because the next control
 * added to that corner will be written by copying one of these two, and
 * copying them without the guard puts the bug straight back.
 *
 * Deliberately a source assertion rather than a render test: mounting
 * class-call.tsx means standing up a LiveKit room, and the invariant is about
 * which conditions guard a JSX block, which is exactly what the source says.
 */

const SOURCE = join(__dirname, "../../src/components/video/class-call.tsx");

// A floating control pinned to the stage's top-right at the transcript's own
// layer. `top-4` and `z-30` together are what put it in the panel's header.
const TOP_RIGHT_CONTROL = /className=.*\babsolute right-\S+ top-4 z-30\b/;

// The line that opens a conditionally-rendered JSX block: `{a && b && (`.
const RENDER_CONDITION = /^\s*\{[^}]*&&\s*\($/;

describe("the transcript's close button", () => {
  const lines = readFileSync(SOURCE, "utf8").split("\n");

  const controls = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => TOP_RIGHT_CONTROL.test(line));

  it("has controls in the corner it shares, so the guard below is not vacuous", () => {
    // If a refactor moves these elsewhere this test must be re-read, not
    // silently pass because it found nothing to check.
    expect(controls.length).toBeGreaterThanOrEqual(2);
  });

  it.each(controls)("is not covered by the control on line $i", ({ i }) => {
    // Walk back to the nearest enclosing render condition.
    let guard: string | null = null;
    for (let j = i; j >= 0 && j > i - 40; j--) {
      if (RENDER_CONDITION.test(lines[j])) {
        guard = lines[j];
        break;
      }
    }

    expect(guard, `no render condition found above line ${i + 1}`).not.toBeNull();
    expect(
      guard,
      `The control on line ${i + 1} of class-call.tsx sits at the transcript ` +
        `panel's own inset and z-index, and renders after it. It must be ` +
        `guarded by !transcriptOpen or it paints over the panel's close button.`,
    ).toContain("!transcriptOpen");
  });
});
