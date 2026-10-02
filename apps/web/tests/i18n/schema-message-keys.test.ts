import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isStringKey } from "@spiralclass/shared";

/**
 * A catalog key written as a plain string is a real key.
 *
 * `t("some.key")` is checked by the compiler: its argument is typed
 * `StringKey`. A schema's message is not — zod takes any string — and since a
 * schema message is a catalog key here (see issueMessage in
 * @spiralclass/shared), a typo in one would not fail the build. It would put
 * the key itself on screen, in front of a teacher, in place of the sentence.
 *
 * So every string literal in the web source that is shaped like a server-action
 * key has to exist. This is the check the type system cannot make.
 */
const SRC = resolve(__dirname, "../../src");
const KEY_LITERAL = /"(web\.action\.[A-Za-z0-9_.]+)"/g;

function sourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("server-action keys written as strings", () => {
  const used = sourceFiles().flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(KEY_LITERAL)].map((m) => ({
      file: relative(SRC, file),
      key: m[1]!,
    })),
  );

  it("finds the keys it is meant to check", () => {
    expect(used.length).toBeGreaterThan(50);
  });

  it("all exist in the catalog", () => {
    const missing = used.filter(({ key }) => !isStringKey(key)).map((u) => `${u.file}: ${u.key}`);
    expect(
      missing,
      "These look like catalog keys and are not. If one is a schema message, " +
        "the reader would be shown the key itself.",
    ).toEqual([]);
  });
});
