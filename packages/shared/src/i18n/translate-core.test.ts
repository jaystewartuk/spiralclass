import { describe, expect, it } from "vitest";
import { strings, type StringKey } from "./catalog";
import { LOCALES } from "./locale-registry";
import { createT } from "./translate";
import { createTFrom } from "./translate-core";

// The browser is given ONE language's table and nothing else (#178): no
// English to fall back to. That is safe only if a table on its own answers
// every key exactly as the server's createT, with its English fallback, does.

const keys = Object.keys(strings.en) as StringKey[];
const pluralKeys = [...new Set(keys.map((k) => k.replace(/_(zero|one|two|few|many|other)$/, "")))]
  .filter((base) => keys.some((k) => k.startsWith(`${base}_`)))
  .filter((base): base is StringKey => base in strings.en);

describe("createTFrom over a single table", () => {
  for (const { tag: code } of LOCALES) {
    it(`${code}: answers every key as the server does`, () => {
      const browser = createTFrom(code, strings[code]);
      const server = createT(code);
      const diverging = keys.filter((key) => browser(key) !== server(key));
      expect(diverging).toEqual([]);
    });

    it(`${code}: picks the same plural form as the server, for every count`, () => {
      const browser = createTFrom(code, strings[code]);
      const server = createT(code);
      const diverging = pluralKeys.flatMap((key) =>
        [0, 1, 2, 5, 21, 1_000_000]
          .filter((count) => browser(key, { count }) !== server(key, { count }))
          .map((count) => `${key} (${count})`),
      );
      expect(diverging).toEqual([]);
    });
  }

  it("renders an unknown key as itself rather than a second language", () => {
    const t = createTFrom("fr", {});
    expect(t("web.help.title")).toBe("web.help.title");
  });
});
