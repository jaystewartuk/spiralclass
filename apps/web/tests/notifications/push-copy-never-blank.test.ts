import { describe, expect, it } from "vitest";
import { createT } from "@spiralclass/shared";
import { renderPush } from "@/lib/notifications/push";
import { serializeWebPushPayload } from "@/lib/notifications/web-push";
import {
  TEMPLATE_NAMES,
  type LanguageCode,
  type TemplateVariables,
} from "@/lib/notifications/templates";

const LANGUAGES = ["en", "es", "fr"] as LanguageCode[];

// Every variable a renderer reads comes back as a short non-empty string.
const vars = new Proxy({}, { get: (_t, key) => (typeof key === "string" ? "Sample" : undefined) });

describe("the wire payload", () => {
  it("falls back to the product name when the title is empty", () => {
    const wire = JSON.parse(
      serializeWebPushPayload({ title: "  ", body: "b", deepLink: null, tag: "t" }),
    );
    expect(wire.title).toBe("SpiralClass");
    expect(wire.body).toBe("b");
  });

  it("keeps a real title", () => {
    const wire = JSON.parse(serializeWebPushPayload({ title: "Hi", body: "", deepLink: null }));
    expect(wire.title).toBe("Hi");
  });
});

describe("the inbox placeholder for a vanished entity", () => {
  it("has a body in every language", () => {
    for (const code of ["en", "es", "fr"] as const) {
      expect(createT(code)("inbox.fallback.body").trim()).not.toBe("");
    }
  });
});

describe("push copy is never blank", () => {
  for (const template of TEMPLATE_NAMES) {
    for (const language of LANGUAGES) {
      it(`${template} / ${language}`, () => {
        const out = renderPush(template, language, vars as TemplateVariables[typeof template]);
        expect(out.title.trim(), "title").not.toBe("");
        expect(out.body.trim(), "body").not.toBe("");
        expect(out.title).not.toMatch(/^[a-z]+(\.[A-Za-z0-9]+)+$/);
        expect(out.body).not.toMatch(/^[a-z]+(\.[A-Za-z0-9]+)+$/);
      });
    }
  }
});
