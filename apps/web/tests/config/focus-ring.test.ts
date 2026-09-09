import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every focusable control gets D-140's focus ring.
 *
 * D-140 asks for 3px focus rings — "targets at least 44px, borders 2px, focus
 * rings 3px". Two things were true instead: the
 * primitives used `ring-2`, because Tailwind ships 0/1/2/4/8 and there was no
 * `ring-3` to write — the rule was unreachable rather than ignored, the same
 * shape as the type scale that was defined and never wired in. And 110 of the
 * app's 113 raw `<button>` elements declared no focus style at all.
 *
 * I had reported those 113 as deliberate on the grounds that "none of them
 * removes its focus ring". True, and beside the point: they never had the
 * brand's ring to remove. They fell back to the browser's outline, in the
 * browser's colour, with no guarantee of contrast on either ground.
 *
 * The fix is one `:focus-visible` rule in the base layer, which is what makes
 * it true of the raw elements too — a keyboard user lands on a drag handle
 * whether or not whoever wrote it remembered.
 */

const WEB = join(__dirname, "..", "..");

describe("the focus ring", () => {
  const css = readFileSync(join(WEB, "src", "app", "globals.css"), "utf8");

  it("is declared globally, not only on the primitives", () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px/);
  });

  it("is 3px, as D-140 requires", () => {
    const rule = css.match(/:focus-visible\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("3px");
    // Drawn from the ring token so it moves with the theme rather than being
    // a literal that only works on one ground.
    expect(rule).toContain("hsl(var(--ring))");
  });

  it("uses :focus-visible so a mouse click does not draw it", () => {
    expect(css).toContain(":focus-visible {");
  });

  it("has no component still asking for a 2px ring", () => {
    // The primitives were the reason the 3px rule was invisible: they all said
    // ring-2 and looked deliberate.
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== "node_modules") walk(full, out);
        } else if (entry.endsWith(".tsx")) out.push(full);
      }
      return out;
    };
    const offenders = walk(join(WEB, "src")).filter((f) =>
      /focus-visible:ring-2\b/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => f.split("/apps/web/")[1])).toEqual([]);
  });
});
