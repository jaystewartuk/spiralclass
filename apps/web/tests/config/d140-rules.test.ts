import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
// The scale itself, so the deleted-step guard below tracks it rather than
// restating it — tailwind.config.ts wires these same keys into `fontSize`.
import { typeScale } from "@spiralclass/shared";

/**
 * D-140's typographic rules, checked against the source that has to obey them.
 *
 * WHY THIS EXISTS. Every one of these rules was already written down, already
 * honoured in the token layer, and already being broken in the app — because
 * the token layer is not where the rule gets applied. The type scale carried no
 * `letterSpacing` key and the tokens test asserted so, while 29 call sites used
 * `tracking-tight`; the scale claimed a 17px floor while `text-xs` rendered
 * 12px in 499 places. A rule enforced only where it is defined is not enforced.
 *
 * So this checks the utilities, which is where the rule is actually obeyed or
 * broken, and it names the D-140 line each one comes from.
 */

const SRC = join(__dirname, "..", "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") walk(full, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC);
const rel = (f: string) => f.split("/apps/web/")[1] ?? f;

describe("D-140 typographic rules", () => {
  it("finds files to check", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('uses no negative letter-spacing — "Also withdrawn: negative letter-spacing on headings"', () => {
    // Tightening closes the gaps between letters, which is the opposite of the
    // change that helps a dyslexic reader. `tracking-wordmark` is the one
    // sanctioned exception: a named brand constant on the logotype only.
    //
    // The pattern is `tight(er)?` and the grouping is the whole point. It was
    // written `tighter?`, which reads as "tighte" plus an optional "r" and so
    // matches NEITHER utility. The same wrong pattern was in the script that
    // removed them and in the grep that verified the removal, so all three
    // agreed the codebase was clean while 30 call sites used it. A guard is
    // only as good as the one case you prove it fails on.
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const line of source.split("\n")) {
        // Skip prose: this file's own explanation names the utility.
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        for (const m of line.matchAll(/tracking-tight(er)?\b/g)) {
          offenders.push(`${rel(file)}: ${m[0]}`);
        }
      }
    }
    expect(offenders, `Negative tracking (D-140):\n${offenders.join("\n")}`).toEqual([]);
  });

  it('uses no italics for emphasis — "italics as emphasis" is withdrawn', () => {
    // Slanted text measurably slows dyslexic readers; emphasis is weight.
    //
    // The exception is an <em> rendered from copy someone else wrote — a
    // teacher's own emphasis in her lesson material. D-140 governs the app's
    // typography, not the author's words, and silently flattening her emphasis
    // would be a different kind of wrong.
    const offenders: string[] = [];
    for (const file of files) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!/className="[^"]*\bitalic\b[^"]*"/.test(line)) continue;
        if (/<em\b/.test(line)) continue;
        offenders.push(`${rel(file)}: ${line.trim().slice(0, 70)}`);
      }
    }
    expect(offenders, `Italics (D-140):\n${offenders.join("\n")}`).toEqual([]);
  });

  it("puts no text below the supporting-text floor via an arbitrary size", () => {
    // The scale cannot go under 15px any more, but an arbitrary value can still
    // route around it — which is exactly how 10px and 9px text got here.
    //
    // REM AS WELL AS PX. The first version read only px, and two sub-floor
    // sizes were sitting in rem the whole time it was green: `text-[0.65rem]`
    // (10.4px) on the landing page's captions demo, and `text-[0.82rem]`
    // (13.1px) on every code block in a lesson document. A guard that knows one
    // unit checks one unit.
    //
    // `em` is deliberately not checked: it resolves against whatever the parent
    // is, so a number here proves nothing either way.
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/text-\[(\d*\.?\d+)(px|rem)\]/g)) {
        const px = m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1]);
        if (px < 15) offenders.push(`${rel(file)}: ${m[0]} = ${px}px`);
      }
    }
    expect(offenders, `Below the 15px floor (D-140):\n${offenders.join("\n")}`).toEqual([]);
  });
  it("references no type-scale step that no longer exists", () => {
    // THE FAILURE THIS CATCHES IS SILENT, WHICH IS WHY IT NEEDS A TEST.
    //
    // D-140 deleted the scale's `label` step (11px) rather than raising it —
    // tokens.ts: "`label` is gone rather than raised: its call sites take
    // `small`". What it did not do is remove `text-label` from the call
    // sites, and Tailwind does not error on a class it cannot resolve: it
    // emits nothing. So 48 elements across 26 files went on asking for a font
    // size, getting none, and rendering at whatever their parent happened to
    // be — while the class name still read like a deliberate decision.
    //
    // Every other rule in this file catches a value that is WRONG. This one
    // catches a value that is ABSENT, which nothing else here can see: the
    // 15px-floor check above scans for sizes, and a size that was never
    // emitted is not a size.
    //
    // Derived from the scale itself rather than hardcoding "label", so the
    // next step that gets retired is covered the day it is retired.
    const live = new Set(Object.keys(typeScale));
    const retired = ["label", "caption", "tiny"].filter((step) => !live.has(step));
    const offenders: string[] = [];
    for (const file of files) {
      for (const step of retired) {
        const re = new RegExp(`(?<![\\w-])text-${step}(?![\\w-])`, "g");
        for (const m of readFileSync(file, "utf8").matchAll(re)) {
          offenders.push(
            `${rel(file)}: ${m[0]} — no such step; the scale has ${[...live].join(", ")}`,
          );
        }
      }
    }
    expect(
      offenders,
      `Utilities naming a deleted type-scale step (they emit NO css at all):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
  it('uses no all-caps labels — "No all-caps labels" (D-140)', () => {
    // Capitals remove the word-shape cue a dyslexic reader leans on, and the
    // pre-D-140 direction used tracked uppercase micro-labels throughout: 38 of
    // them survived the redesign, in the exact form the decision names
    // ("text-xs font-medium uppercase tracking-wide"). Emphasis is weight now.
    //
    // `tracking-wide` goes with them. Positive tracking is not the harm that
    // negative tracking is, but it only ever appeared here in service of caps,
    // and a label that is neither capitalised nor tracked is just a label.
    const offenders: string[] = [];
    for (const file of files) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        if (!/className=|cn\(/.test(line)) continue;
        for (const m of line.matchAll(/(?<![\w-])(uppercase|tracking-wider?)(?![\w-])/g)) {
          offenders.push(`${rel(file)}: ${m[1]}`);
        }
      }
    }
    expect(offenders, `All-caps or tracked labels (D-140):\n${offenders.join("\n")}`).toEqual([]);
  });
  it("never dims an on-colour token with an opacity", () => {
    // `text-primary-foreground/80` rendered #d5daef on #566ac2 — 3.56:1, under
    // AA — on the /features and /about trial bands, and axe caught it while the
    // palette's own contrast test passed, because that test checks the token at
    // FULL opacity and an opacity is a different colour.
    //
    // There is no dimmed variant to reach for either: on the primary ground the
    // full on-colour is #f4f5f9 and AA needs at least #edf3ff, so the entire
    // band between "legible" and "white" is about six values wide. Dimming an
    // on-colour is not a thing this palette can do, which makes the right rule
    // "don't" rather than "use the other token". Emphasis is weight (D-140).
    const offenders: string[] = [];
    for (const file of files) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        // `text-` and `border-` only. A `bg-*-foreground/10` is a translucent
        // WASH over a coloured ground — a surface, not a text or boundary
        // colour — and the contrast rules that make dimming dangerous do not
        // govern it. Three of those exist and are fine; sweeping them in would
        // have meant changing correct code to satisfy an over-broad rule.
        for (const m of line.matchAll(
          /(?:text|border)-(?:primary|accent|secondary|destructive)-foreground\/\d+/g,
        )) {
          offenders.push(`${rel(file)}: ${m[0]}`);
        }
      }
    }
    expect(
      offenders,
      `An on-colour token dimmed by opacity — this is how contrast drops below AA ` +
        `without the palette's contrast test noticing:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
