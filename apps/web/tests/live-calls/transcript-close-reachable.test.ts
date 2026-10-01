import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Nothing may be painted over the transcript panel's close button.
 *
 * WHY. `CaptionTranscript` sits at the stage's `absolute top-0 right-0 z-30`,
 * and its close button is in that panel's header at the top-right inset. The
 * call's minimise and pop-out buttons used to float in the same corner of the
 * same stage, at the same z-index, later in the file — so they painted on top
 * of the panel's header.
 *
 * The failure that produced this test: on a live call the reader taps the ×
 * she can see, minimises the whole call instead, and the transcript stays up.
 * On a phone there is no Escape key and the panel is covering the other
 * person's face with no way to dismiss it.
 *
 * Those buttons now live in the call's top bar (call-top-bar.tsx), a row
 * ABOVE the stage, so they cannot overlap anything the stage opens. This test
 * pins that structure, and still guards any control a later change pins to
 * the stage's top-right corner: it must be hidden while the transcript is open.
 *
 * Deliberately a source assertion rather than a render test: mounting
 * class-call.tsx means standing up a LiveKit room, and the invariant is about
 * where a JSX block lives and which conditions guard it, which is exactly what
 * the source says.
 */

const SOURCE = join(__dirname, "../../src/components/video/class-call.tsx");
const source = readFileSync(SOURCE, "utf8");

// A floating control pinned to the stage's top-right at the transcript's own
// layer. Matched token by token: prettier-plugin-tailwindcss reorders classes.
const TOP_RIGHT_CONTROL = (line: string) =>
  /className=/.test(line) &&
  /\babsolute\b/.test(line) &&
  /\btop-4\b/.test(line) &&
  /\bright-\S+/.test(line) &&
  /\bz-30\b/.test(line);

// The line that opens a conditionally-rendered JSX block: `{a && b && (`.
const RENDER_CONDITION = /^\s*\{[^}]*&&\s*\($/;

describe("the transcript's close button", () => {
  it("is out of reach of the window controls, which live in the top bar", () => {
    const bar = source.indexOf("<CallTopBar");
    const stage = source.indexOf('<div className="relative flex-1 overflow-hidden">');
    expect(bar).toBeGreaterThan(-1);
    expect(stage).toBeGreaterThan(bar);
    for (const label of ['t("call.minimize")', 't("call.popOut")']) {
      const at = source.indexOf(`aria-label={${label}}`);
      expect(at, `${label} must render inside <CallTopBar>, above the stage`).toBeGreaterThan(bar);
      expect(at, `${label} must render inside <CallTopBar>, above the stage`).toBeLessThan(stage);
    }
  });

  const lines = source.split("\n");
  const controls = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => TOP_RIGHT_CONTROL(line));

  it.each(controls)("is not covered by the control on line $i", ({ i }) => {
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
        `panel's own inset and z-index. Put it in the top bar, or guard it by ` +
        `!transcriptOpen so it never paints over the panel's close button.`,
    ).toContain("!transcriptOpen");
  });
});
