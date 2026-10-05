import { describe, expect, it } from "vitest";
import { CONTENT_AUDIENCES, localize } from "./types";
import { CONTENT_DOCS, getContentDoc, listContentDocs, listPublicFaqDocs } from "./registry";

describe("content registry", () => {
  it("gives every doc a non-empty English title/summary/body", () => {
    for (const doc of CONTENT_DOCS) {
      expect(doc.title.en.trim(), `${doc.audience}/${doc.slug} title (en)`).toBeTruthy();
      expect(doc.summary.en.trim(), `${doc.audience}/${doc.slug} summary (en)`).toBeTruthy();
      expect(doc.body.en.trim(), `${doc.audience}/${doc.slug} body (en)`).toBeTruthy();
    }
  });

  it("gives every doc with an es translation a non-empty title/summary/body", () => {
    for (const doc of CONTENT_DOCS) {
      if (!doc.title["es"]) continue;
      expect(doc.title["es"]?.trim(), `${doc.audience}/${doc.slug} title (es)`).toBeTruthy();
      expect(doc.summary["es"]?.trim(), `${doc.audience}/${doc.slug} summary (es)`).toBeTruthy();
      expect(doc.body["es"]?.trim(), `${doc.audience}/${doc.slug} body (es)`).toBeTruthy();
    }
  });

  it("localize() falls back to en for a locale with no translation", () => {
    const doc = getContentDoc("teacher", "getting-started");
    expect(doc).toBeTruthy();
    // Every launched language has its guides now; a language still to come does not.
    expect(localize(doc!.title, "de")).toBe(doc!.title.en);
  });

  it("localize() prefers es when present", () => {
    const doc = getContentDoc("teacher", "getting-started");
    expect(doc?.title["es"]).toBeTruthy();
    expect(localize(doc!.title, "es")).toBe(doc!.title["es"]);
  });

  // It asked "is this Spanish?", so a French guide, once written, would never
  // have been shown (#178 step A7 writes them).
  it("localize() serves any language a text has been written in", () => {
    expect(localize({ en: "Hello", fr: "Bonjour" }, "fr")).toBe("Bonjour");
    expect(localize({ en: "Hello", fr: "" }, "fr")).toBe("Hello");
    expect(localize({ en: "Hello" }, "de")).toBe("Hello");
  });

  it("has no duplicate (audience, slug) pairs", () => {
    const keys = CONTENT_DOCS.map((doc) => `${doc.audience}/${doc.slug}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only uses registered audiences", () => {
    for (const doc of CONTENT_DOCS) {
      expect(CONTENT_AUDIENCES).toContain(doc.audience);
    }
  });

  it("getContentDoc resolves a known doc and returns undefined for an unknown slug", () => {
    expect(getContentDoc("teacher", "getting-started")?.slug).toBe("getting-started");
    expect(getContentDoc("teacher", "does-not-exist")).toBeUndefined();
  });

  it("listContentDocs filters by audience only", () => {
    const teacherDocs = listContentDocs("teacher");
    expect(teacherDocs.length).toBeGreaterThan(0);
    expect(teacherDocs.every((doc) => doc.audience === "teacher")).toBe(true);
  });

  it("never marks an admin doc as part of the public FAQ", () => {
    expect(listPublicFaqDocs().every((doc) => doc.audience !== "admin")).toBe(true);
  });
});
