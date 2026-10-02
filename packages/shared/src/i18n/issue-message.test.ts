import { describe, expect, it } from "vitest";
import { LOCALES } from "./locales";
import { createT, isStringKey, issueMessage } from "./translate";

// A schema is a module constant with no reader, so a message written into one
// is in one language for everybody. That is how a Spanish sentence came to be
// the answer every teacher got for a too-short reason. A schema's message is a
// catalog KEY instead, and issueMessage() is the one place it becomes words.
const issue = (message?: string) => ({ issues: message === undefined ? [] : [{ message }] });

describe("isStringKey", () => {
  it("knows a catalog key from a sentence", () => {
    expect(isStringKey("web.action.reasonTooShort")).toBe(true);
    expect(isStringKey("Da una razón breve.")).toBe(false);
    expect(isStringKey("web.action.doesNotExist")).toBe(false);
    expect(isStringKey(undefined)).toBe(false);
  });

  it("is not fooled by a name every object has", () => {
    expect(isStringKey("toString")).toBe(false);
    expect(isStringKey("constructor")).toBe(false);
  });
});

describe("issueMessage", () => {
  it("turns a key into the reader's own words, in every locale", () => {
    const seen = new Set<string>();
    for (const { tag } of LOCALES) {
      const t = createT(tag);
      const message = issueMessage(issue("web.action.reasonTooShort"), t, "web.action.invalidData");
      expect(message).toBe(t("web.action.reasonTooShort"));
      seen.add(message);
    }
    // One sentence per language, none of them shared.
    expect(seen.size).toBe(LOCALES.length);
  });

  it("passes through a message that is already a sentence", () => {
    // The validators still built per locale return finished copy.
    expect(issueMessage(issue("Invalid email"), createT("fr"), "web.action.invalidData")).toBe(
      "Invalid email",
    );
  });

  it("falls back when there is no issue, or no message", () => {
    const t = createT("fr");
    expect(issueMessage(issue(), t, "web.action.invalidData")).toBe("Données invalides.");
    expect(issueMessage(issue(""), t, "web.action.invalidData")).toBe("Données invalides.");
  });
});

describe("plural server-action messages", () => {
  it.each([
    ["en", 1, "Sent 1 invitation."],
    ["en", 3, "Sent 3 invitations."],
    ["es", 1, "Se envió 1 invitación."],
    ["es", 3, "Se enviaron 3 invitaciones."],
    ["fr", 1, "1 invitation envoyée."],
    ["fr", 3, "3 invitations envoyées."],
  ] as const)("counts invitations in %s (%i)", (locale, count, copy) => {
    expect(createT(locale)("web.action.invitations.sent", { count })).toBe(copy);
  });

  it("reports the ones that could not be delivered in the same sentence", () => {
    expect(createT("en")("web.action.invitations.sentSomeFailed", { count: 1, failed: 2 })).toBe(
      "Sent 1 invitation. (2 couldn't be delivered)",
    );
    expect(createT("es")("web.action.invitations.sentSomeFailed", { count: 4, failed: 1 })).toBe(
      "Se enviaron 4 invitaciones. (1 no se pudieron enviar)",
    );
  });

  it("says one class, not one classes, when a package cannot shrink", () => {
    const en = createT("en");
    expect(en("web.action.teacherPackages.committedExceeds", { count: 1, max: 4 })).toContain(
      "1 booked or taken class,",
    );
    expect(en("web.action.teacherPackages.committedExceeds", { count: 2, max: 3 })).toContain(
      "2 booked or taken classes,",
    );
    expect(
      createT("es")("web.action.teacherPackages.committedExceeds", { count: 1, max: 4 }),
    ).toContain("1 clase reservada o tomada,");
  });
});
