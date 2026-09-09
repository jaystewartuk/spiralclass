import { describe, expect, it } from "vitest";
import { levenshtein, suggestEmailCorrection } from "./email-suggest";

describe("levenshtein", () => {
  it("measures edit distance", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("gmial.com", "gmail.com")).toBe(2);
    expect(levenshtein("gmal.com", "gmail.com")).toBe(1);
    expect(levenshtein("spiralclas.com", "spiralclass.com")).toBe(1);
  });
});

describe("suggestEmailCorrection", () => {
  it("corrects one-keystroke provider typos", () => {
    expect(suggestEmailCorrection("mira@gmial.com")).toBe("mira@gmail.com");
    expect(suggestEmailCorrection("mira@gmal.com")).toBe("mira@gmail.com");
    expect(suggestEmailCorrection("mira@gmail.co")).toBe("mira@gmail.com");
    expect(suggestEmailCorrection("mira@hotmial.com")).toBe("mira@hotmail.com");
    expect(suggestEmailCorrection("mira@outlok.com")).toBe("mira@outlook.com");
  });

  it("normalizes case and whitespace before matching", () => {
    expect(suggestEmailCorrection("  Mira@GMIAL.COM ")).toBe("mira@gmail.com");
  });

  it("leaves known providers alone", () => {
    expect(suggestEmailCorrection("mira@gmail.com")).toBeNull();
    expect(suggestEmailCorrection("mira@yahoo.com.mx")).toBeNull();
    expect(suggestEmailCorrection("mira@live.com")).toBeNull();
  });

  it("leaves custom domains alone — a typo'd custom domain is indistinguishable from a real one", () => {
    expect(suggestEmailCorrection("test_student_1@agengaprofe.com")).toBeNull();
    expect(suggestEmailCorrection("mira@empresa.mx")).toBeNull();
  });

  it("never 'corrects' real providers that neighbor the majors", () => {
    // mail.com is one insertion from gmail.com; ymail.com one substitution.
    expect(suggestEmailCorrection("mira@mail.com")).toBeNull();
    expect(suggestEmailCorrection("mira@ymail.com")).toBeNull();
  });

  it("requires two edits max (one on short domains)", () => {
    // msn.com is short — two edits away no longer suggests it.
    expect(suggestEmailCorrection("mira@mzx.com")).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(suggestEmailCorrection("")).toBeNull();
    expect(suggestEmailCorrection("no-at-sign")).toBeNull();
    expect(suggestEmailCorrection("@gmial.com")).toBeNull();
    expect(suggestEmailCorrection("mira@")).toBeNull();
    expect(suggestEmailCorrection("a@b@gmial.com")).toBeNull();
  });
});
