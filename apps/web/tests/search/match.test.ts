import { describe, expect, it } from "vitest";
import {
  indexSearchEntries,
  PER_KIND_LIMIT,
  queryTerms,
  searchEntries,
  type SearchEntry,
  type SearchKind,
} from "@/lib/search/match";

// The site-search matcher. What these pin is what a teacher would notice:
// accents never hide a person, a second word narrows, a page beats a record of
// the same name, and no one kind floods the shortlist.

const entry = (id: string, kind: SearchKind, label: string, extra: Partial<SearchEntry> = {}) => ({
  id,
  kind,
  label,
  href: `/${id}`,
  ...extra,
});

const ids = (entries: SearchEntry[]) => entries.map((e) => e.id);

describe("searchEntries", () => {
  const index = indexSearchEntries([
    entry("packages", "page", "Packages", { terms: "packet bundle prices" }),
    entry("tpl", "package", "Packages for two"),
    entry("lopez", "student", "Marco López", { detail: "marco@example.com" }),
    entry("pena", "student", "Camila Peña"),
    entry("plan", "action", "Plan de día", { terms: "plan my day" }),
    entry("help", "help", "How do packages expire?"),
  ]);

  it("returns nothing for an empty or whitespace query", () => {
    expect(searchEntries(index, "")).toEqual([]);
    expect(searchEntries(index, "   ")).toEqual([]);
  });

  it("folds accents and case both ways, so 'lopez' finds López and 'PEÑA' finds Peña", () => {
    expect(ids(searchEntries(index, "lopez"))).toEqual(["lopez"]);
    expect(ids(searchEntries(index, "PEÑA"))).toEqual(["pena"]);
    expect(ids(searchEntries(index, "plan dia"))).toEqual(["plan"]);
  });

  it("finds a destination by a word that is not in its label", () => {
    expect(ids(searchEntries(index, "packet"))).toEqual(["packages"]);
    expect(ids(searchEntries(index, "plan my day"))).toEqual(["plan"]);
  });

  it("matches the detail line too — a teacher may remember the email, not the name", () => {
    expect(ids(searchEntries(index, "marco@example"))).toEqual(["lopez"]);
  });

  it("requires every word, so a second word narrows rather than widens", () => {
    expect(ids(searchEntries(index, "packages"))).toEqual(["packages", "tpl", "help"]);
    expect(ids(searchEntries(index, "packages two"))).toEqual(["tpl"]);
  });

  it("ranks the label's start, then a word's start, then anywhere in it, then the terms", () => {
    const ranked = indexSearchEntries([
      entry("terms", "page", "Starter", { terms: "trial" }),
      entry("mid", "page", "Electric guitar"),
      entry("word", "page", "Intensive trial"),
      entry("starts", "page", "Trial pack"),
    ]);
    expect(ids(searchEntries(ranked, "tri"))).toEqual(["starts", "word", "mid", "terms"]);
  });

  it("puts a page ahead of a record on an otherwise equal match", () => {
    const ranked = indexSearchEntries([
      entry("record", "package", "Calendar"),
      entry("page", "page", "Calendar"),
    ]);
    expect(ids(searchEntries(ranked, "calendar"))).toEqual(["page", "record"]);
  });

  it("keeps index order on a tie, so the list does not reshuffle while she types", () => {
    const ranked = indexSearchEntries([
      entry("first", "class", "Class with Ana"),
      entry("second", "class", "Class with Ana"),
    ]);
    expect(ids(searchEntries(ranked, "ana"))).toEqual(["first", "second"]);
  });

  it("caps each kind so eleven classes cannot crowd out the student herself", () => {
    const many = indexSearchEntries([
      ...Array.from({ length: 11 }, (_, i) => entry(`class${i}`, "class", "Class with Ana")),
      entry("ana", "student", "Ana"),
    ]);
    const results = searchEntries(many, "ana");
    expect(results[0]?.id).toBe("ana");
    expect(results.filter((r) => r.kind === "class")).toHaveLength(PER_KIND_LIMIT.class);
  });

  it("ignores the words people type around what they mean", () => {
    expect(ids(searchEntries(index, "where is my packet?"))).toEqual(["packages"]);
    expect(ids(searchEntries(index, "plan the day"))).toEqual(["plan"]);
    expect(ids(searchEntries(index, "¿dónde está López?"))).toEqual(["lopez"]);
  });

  it("still searches for a filler word when it is all she typed", () => {
    expect(queryTerms("the")).toEqual(["the"]);
    expect(queryTerms("Where is MY packet")).toEqual(["packet"]);
  });

  it("keeps the characters of an email address in a term", () => {
    expect(queryTerms("ana@example.com")).toEqual(["ana@example.com"]);
  });

  it("honours the overall limit", () => {
    const many = indexSearchEntries(
      Array.from({ length: 30 }, (_, i) =>
        entry(`p${i}`, (["page", "student", "lead"] as const)[i % 3], `Item ${i}`),
      ),
    );
    expect(searchEntries(many, "item", 5)).toHaveLength(5);
  });
});
