import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The Input and Textarea primitives use text-base on a phone, because iOS Safari
// zooms the page when a field under 16px takes focus. An unprefixed text-sm or
// text-xs on a call site undoes that for that one field, and nothing else notices.
const SRC = resolve(__dirname, "../../src");
const FIELD = /<(Input|Textarea)\s[\s\S]*?\/>/g;
const SMALL = /(?:^|[\s"'`])text-(?:xs|sm)(?=[\s"'`])/;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("text fields stay at a size iOS does not zoom on", () => {
  it("has no field that shrinks its text below the desktop breakpoint", () => {
    const offenders = tsxFiles(SRC).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(FIELD)]
        .filter(([element]) => SMALL.test(element))
        .map(() => relative(SRC, file)),
    );
    expect(offenders).toEqual([]);
  });
});
