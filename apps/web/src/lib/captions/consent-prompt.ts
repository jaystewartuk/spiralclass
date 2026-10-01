import type { CaptionSession } from "@spiralclass/shared";

// What a call screen says about the student's captions consent while captions
// are on and it is missing (D-22, D-185). Without this, a class whose student
// had never consented looked like broken captions on the teacher's side: her
// speech was captioned for the student, the student's never was, and nothing
// on either screen said why — while the only fix sat on an account page the
// student had no reason to visit.
//
// So the consent is asked for where it matters, of the person who can give
// it: an adult student is asked on her own call screen, with one tap (it is
// still her own act — the teacher can never give it for her); a minor's
// consent is her guardian's, recorded by the teacher on the student's page.
// The teacher is told which of the two is happening, so she never has to
// explain where a setting lives.
//
// This only decides the words. Whether the student's speech is captioned is
// still `studentConsent` alone, enforced by the server on every line.
export type CaptionsConsentPrompt =
  // The student's screen: the one-tap card.
  | "ask-student"
  // The student's screen: she is a minor; her guardian consents, through the teacher.
  | "student-guardian"
  // The teacher's screen: the student is being asked on hers.
  | "teacher-asked"
  // The teacher's screen: record the guardian's consent on the student's page.
  | "teacher-guardian";

export function captionsConsentPrompt(args: {
  session: Pick<CaptionSession, "role" | "studentConsent" | "studentConsentGiver"> | null;
  // The room's switch, as this screen sees it.
  captionsOn: boolean;
  // Whether the other participant is in the call. A prompt about someone who
  // is not here yet is noise.
  otherPresent: boolean;
  // The student answered "Not now" during this call.
  dismissed: boolean;
}): CaptionsConsentPrompt | null {
  const { session } = args;
  if (!session || !args.captionsOn || !args.otherPresent || session.studentConsent) return null;
  if (session.role === "student") {
    if (session.studentConsentGiver === "guardian") return "student-guardian";
    return args.dismissed ? null : "ask-student";
  }
  return session.studentConsentGiver === "guardian" ? "teacher-guardian" : "teacher-asked";
}
