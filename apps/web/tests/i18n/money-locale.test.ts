import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// D-197: a price is written in its reader's number format. formatMinorUnits
// takes the reader's locale as its third argument, and omitting it means
// English — right only where every reader is English. A call that forgets it
// type-checks, lints and renders; a French reader then reads "$25,000 CLP" as
// twenty-five pesos. So every call outside the places that are English on
// purpose must pass a locale, or go through useFormatMoney() / getFormatMoney().

const SRC = join(__dirname, "..", "..", "src");

/** Where the default is the right answer, each for a stated reason. */
const ENGLISH_ON_PURPOSE = [
  // The operator's console is English.
  "app/admin/",
  // Its only caller is the admin console's charts.
  "components/ui/chart-format.ts",
  // Instructions to a model, which writes the copy in its own output language.
  "lib/marketing/prompt.ts",
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** The argument count of every formatMinorUnits( call in `code`. */
function callArity(code: string): number[] {
  const out: number[] = [];
  for (const match of code.matchAll(/formatMinorUnits\(/g)) {
    let i = match.index! + match[0].length;
    let depth = 1;
    let args = 1;
    let sawContent = false;
    while (depth > 0 && i < code.length) {
      const c = code[i];
      if (c === "(" || c === "[" || c === "{") depth += 1;
      else if (c === ")" || c === "]" || c === "}") depth -= 1;
      else if (c === "," && depth === 1) {
        // A trailing comma before ")" is not another argument.
        const rest = code.slice(i + 1).trimStart();
        if (!rest.startsWith(")")) args += 1;
      } else if (!/\s/.test(c)) sawContent = true;
      i += 1;
    }
    out.push(sawContent ? args : 0);
  }
  return out;
}

describe("prices are formatted for their reader (D-197)", () => {
  it("passes a locale to every formatMinorUnits call outside the English-on-purpose places", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (ENGLISH_ON_PURPOSE.some((p) => rel.startsWith(p))) continue;
      // Comment lines name the function in prose; only calls count.
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      callArity(code).forEach((arity, n) => {
        if (arity < 3) offenders.push(`${rel} (call ${n + 1}: ${arity} arguments)`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("counts arguments correctly, so the check above means something", () => {
    expect(callArity("formatMinorUnits(a, b)")).toEqual([2]);
    expect(callArity("formatMinorUnits(a, b, locale)")).toEqual([3]);
    expect(callArity("formatMinorUnits(\n  f(x, y),\n  c,\n  locale,\n)")).toEqual([3]);
    expect(callArity("formatMinorUnits(a ?? 0, { x: 1, y: 2 }.x)")).toEqual([2]);
  });
});
