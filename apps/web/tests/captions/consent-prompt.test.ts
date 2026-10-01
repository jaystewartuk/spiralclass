import { describe, expect, it } from "vitest";
import { captionsConsentPrompt } from "@/lib/captions/consent-prompt";

// What each call screen says about a missing captions consent. The class that
// prompted this: an adult student who had never consented, whose teacher saw
// no captions of him all lesson and no reason why.

const session = (
  role: "teacher" | "student",
  studentConsent: boolean,
  studentConsentGiver: "student" | "guardian" = "student",
) => ({ role, studentConsent, studentConsentGiver });

const base = { captionsOn: true, otherPresent: true, dismissed: false };

describe("captionsConsentPrompt", () => {
  it("asks an adult student on her own screen", () => {
    expect(captionsConsentPrompt({ ...base, session: session("student", false) })).toBe(
      "ask-student",
    );
  });

  it("tells the teacher her student is being asked", () => {
    expect(captionsConsentPrompt({ ...base, session: session("teacher", false) })).toBe(
      "teacher-asked",
    );
  });

  it("stops asking the student for the rest of the call after 'Not now'", () => {
    expect(
      captionsConsentPrompt({ ...base, dismissed: true, session: session("student", false) }),
    ).toBeNull();
  });

  it("never asks a minor to consent for herself", () => {
    expect(captionsConsentPrompt({ ...base, session: session("student", false, "guardian") })).toBe(
      "student-guardian",
    );
  });

  it("points the teacher of a minor at the guardian's consent", () => {
    expect(captionsConsentPrompt({ ...base, session: session("teacher", false, "guardian") })).toBe(
      "teacher-guardian",
    );
  });

  it("says nothing once consent is given", () => {
    expect(captionsConsentPrompt({ ...base, session: session("student", true) })).toBeNull();
    expect(captionsConsentPrompt({ ...base, session: session("teacher", true) })).toBeNull();
  });

  it("says nothing while captions are off, before the session is read, or alone", () => {
    expect(
      captionsConsentPrompt({ ...base, captionsOn: false, session: session("student", false) }),
    ).toBeNull();
    expect(captionsConsentPrompt({ ...base, session: null })).toBeNull();
    expect(
      captionsConsentPrompt({ ...base, otherPresent: false, session: session("teacher", false) }),
    ).toBeNull();
  });
});
