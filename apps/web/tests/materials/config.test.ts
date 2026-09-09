import { describe, expect, it } from "vitest";
import {
  CLASS_CONTENT_MAX_CHARS,
  classContentLength,
  validateClassContentBody,
} from "@/lib/materials/config";

describe("validateClassContentBody", () => {
  it("rejects an empty / whitespace-only body", () => {
    for (const raw of ["", "   ", "\n\n", "  \r\n  "]) {
      const r = validateClassContentBody(raw, "en");
      expect(r.ok).toBe(false);
    }
  });

  it("trims and normalizes CRLF, returning the cleaned body", () => {
    const r = validateClassContentBody("  # Hi\r\n\r\nbody  ", "en");
    expect(r).toEqual({ ok: true, body: "# Hi\n\nbody" });
  });

  it("accepts a body at the ceiling and rejects one past it", () => {
    const atCap = "a".repeat(CLASS_CONTENT_MAX_CHARS);
    expect(validateClassContentBody(atCap, "en").ok).toBe(true);

    const overCap = "a".repeat(CLASS_CONTENT_MAX_CHARS + 1);
    const r = validateClassContentBody(overCap, "en");
    expect(r.ok).toBe(false);
  });

  it("localizes the error messages", () => {
    const en = validateClassContentBody("", "en");
    const es = validateClassContentBody("", "es-MX");
    expect(en.ok).toBe(false);
    expect(es.ok).toBe(false);
    if (!en.ok && !es.ok) {
      expect(en.error).not.toEqual(es.error);
    }
  });
});

describe("classContentLength", () => {
  it("counts the body length", () => {
    expect(classContentLength("hello")).toBe(5);
    expect(classContentLength("")).toBe(0);
  });

  it("counts CRLF as a single character, matching the stored form", () => {
    // "a\r\nb" normalizes to "a\nb" (3 chars) before storage, so the counter
    // must not double-count the carriage return.
    expect(classContentLength("a\r\nb")).toBe(3);
  });

  it("does not trim, so it tracks the raw keystrokes near the cap", () => {
    expect(classContentLength("  hi  ")).toBe(6);
  });
});
