import { describe, expect, it } from "vitest";
import { LOCALES } from "../i18n/locales";
import {
  DEFAULT_MEME_STYLE,
  isMemeStyle,
  MEME_FIXED_RULES,
  MEME_STYLES,
  MEME_STYLE_SPECS,
  memeStyleLabel,
  memeStyleSpec,
  COMMUNITY_MEME_BRIEF_MAX_CHARS,
  TEACHER_MEME_BRIEF_MAX_CHARS,
} from "./meme";

describe("meme styles", () => {
  it("defaults to the varied register, which is the anti-repetition mechanism", () => {
    // A teacher who never touches this must get a DIFFERENT look each time
    // rather than the same one forever — that was the whole complaint.
    expect(DEFAULT_MEME_STYLE).toBe("varied");
    expect(MEME_STYLES[0]).toBe("varied");
  });

  it("has a spec for every style, and only for registered styles", () => {
    expect(Object.keys(MEME_STYLE_SPECS).sort()).toEqual([...MEME_STYLES].sort());
    for (const style of MEME_STYLES) {
      expect(memeStyleSpec(style).style).toBe(style);
    }
  });

  it("names and explains every style in every locale the app ships", () => {
    // She picks a plain label; the model vocabulary stays server-side. A
    // missing translation would render an English word inside a Spanish form.
    for (const style of MEME_STYLES) {
      for (const locale of LOCALES) {
        expect(memeStyleLabel(style, locale.tag).length).toBeGreaterThan(0);
        expect(MEME_STYLE_SPECS[style].summary[locale.tag].length).toBeGreaterThan(0);
      }
    }
  });

  it("rejects anything that is not a registered style", () => {
    expect(isMemeStyle("photo")).toBe(true);
    expect(isMemeStyle("cinematic")).toBe(false);
    expect(isMemeStyle(undefined)).toBe(false);
  });
});

describe("brief bounds", () => {
  it("treats the teacher's and the community's briefs as peers", () => {
    // A teacher may well have more to say about one hard audience than about
    // her general taste, so neither is the footnote of the other.
    expect(COMMUNITY_MEME_BRIEF_MAX_CHARS).toBe(TEACHER_MEME_BRIEF_MAX_CHARS);
  });
});

describe("the fixed rules we always add", () => {
  it("are stated in every locale, so the transparency is not English-only", () => {
    for (const locale of LOCALES) {
      expect(MEME_FIXED_RULES[locale.tag].length).toBeGreaterThan(0);
    }
  });

  it("lead with the no-text rule, which is the one that surprises her", () => {
    // She types a caption and gets an image with no words in it. Unexplained,
    // that reads as the tool having ignored her.
    for (const locale of LOCALES) {
      expect(MEME_FIXED_RULES[locale.tag][0].toLowerCase()).toMatch(/text|texto|texte/);
    }
  });
});
