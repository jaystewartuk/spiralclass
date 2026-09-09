import { describe, expect, it } from "vitest";
import { buildInvitationEmail, invitationAcceptUrl, invitationEmailLocale } from "./send";

describe("invitationEmailLocale", () => {
  it("follows the STUDENT's locale, not the teacher's", () => {
    // The regression this exists for: an es-MX teacher with English-speaking
    // students used to be unable to invite them in English without flipping
    // her own dashboard to English.
    expect(invitationEmailLocale("en", "es-MX")).toBe("en");
    expect(invitationEmailLocale("es-MX", "en")).toBe("es-MX");
  });

  it("falls back to the teacher's locale when the roster row has none", () => {
    expect(invitationEmailLocale(null, "es-MX")).toBe("es-MX");
    expect(invitationEmailLocale(undefined, "en")).toBe("en");
  });

  it("treats a blank/whitespace student locale as absent", () => {
    // An empty string would otherwise reach localeToLanguageCode() and silently
    // resolve to the English fallback regardless of what the teacher reads.
    expect(invitationEmailLocale("", "es-MX")).toBe("es-MX");
    expect(invitationEmailLocale("   ", "es-MX")).toBe("es-MX");
  });
});

describe("invitationAcceptUrl", () => {
  it("builds an absolute /i/<token> url", () => {
    expect(invitationAcceptUrl("abc123", "https://spiralclass.com")).toBe(
      "https://spiralclass.com/i/abc123",
    );
  });
  it("trims a trailing slash on the origin and encodes the token", () => {
    expect(invitationAcceptUrl("a/b+c", "https://x.com/")).toBe("https://x.com/i/a%2Fb%2Bc");
  });
});

describe("buildInvitationEmail", () => {
  const base = {
    teacherName: "Mira López",
    studentName: "Juan",
    acceptUrl: "https://spiralclass.com/i/tok",
    teacherAvatarUrl: "https://cdn.example.com/mira.jpg",
    messagingEnabled: true,
  };

  it("names the teacher in the subject (en + es)", () => {
    expect(buildInvitationEmail({ ...base, languageCode: "en" }).subject).toContain("Mira López");
    expect(buildInvitationEmail({ ...base, languageCode: "en" }).subject).toContain("invited you");
    expect(buildInvitationEmail({ ...base, languageCode: "es_MX" }).subject).toContain("te invita");
  });

  it("greets the student by name and includes the accept CTA + url", () => {
    const { html, body } = buildInvitationEmail({ ...base, languageCode: "en" });
    expect(body).toContain("Hi Juan,");
    expect(html).toContain("Accept invitation");
    expect(html).toContain("https://spiralclass.com/i/tok");
    expect(body).toContain("https://spiralclass.com/i/tok");
  });

  it("falls back to a nameless greeting when no student name", () => {
    const { body } = buildInvitationEmail({ ...base, studentName: null, languageCode: "en" });
    expect(body).toContain("Hi,");
    expect(body).not.toContain("Hi null");
  });

  it("renders the teacher avatar when an https url is given", () => {
    const { html } = buildInvitationEmail({ ...base, languageCode: "en" });
    expect(html).toContain("https://cdn.example.com/mira.jpg");
  });

  it("includes messaging benefit only when enabled", () => {
    const withMsg = buildInvitationEmail({ ...base, languageCode: "en", messagingEnabled: true });
    const withoutMsg = buildInvitationEmail({
      ...base,
      languageCode: "en",
      messagingEnabled: false,
    });
    expect(withMsg.html).toContain("Message your teacher directly.");
    expect(withoutMsg.html).not.toContain("Message your teacher directly.");
  });

  it("always includes the core benefits", () => {
    const { html } = buildInvitationEmail({ ...base, languageCode: "en" });
    expect(html).toContain("Book and reschedule");
    expect(html).toContain("AI-generated study materials");
  });
});
