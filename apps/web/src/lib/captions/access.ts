import "server-only";
import type { ApiCallParticipant } from "@/lib/api/auth";
import { liveCaptionsEnabled } from "@/lib/captions/config";
import type { CaptionSession } from "@spiralclass/shared";
import { resolveCaptionSession } from "@/lib/captions/class-access";
import { studentIdentityIds } from "@/lib/students/identity";
import { gateProFeature } from "@/lib/subscriptions/enforce";

// The one access check both live-caption routes run on every call (D-185):
// the caller is signed in, is a party to this class, the feature is on, and
// the teacher's plan includes it. Captioning moved into the participants'
// browsers, so these routes are the server's only chance to hold the line —
// they are re-checked per request rather than trusted from the page render,
// which means switching the flag off, a downgrade, or a revoked consent
// takes effect on the next config poll or translation, not the next class.
//
// The route resolves WHO is asking first (requireApiCallParticipant, which
// throws for "who are you" failures and handle() renders them), then asks
// this whether they may caption this class; each route words a refusal its
// own way.
export type CaptionAccess =
  | { ok: true; session: CaptionSession; callerId: string }
  | { ok: false; reason: "disabled" | "not-found" | "not-entitled" };

export async function captionAccessFor(
  participant: ApiCallParticipant,
  bookingId: string,
): Promise<CaptionAccess> {
  if (!liveCaptionsEnabled()) return { ok: false, reason: "disabled" };

  const session =
    participant.role === "teacher"
      ? await resolveCaptionSession(bookingId, {
          role: "teacher",
          teacherId: participant.teacher.id,
        })
      : await resolveCaptionSession(bookingId, {
          role: "student",
          studentIds: await studentIdentityIds(participant.student),
        });
  if (!session) return { ok: false, reason: "not-found" };

  // The teacher's plan owns the feature, whoever is asking (the call page's
  // own gate, lesson_notes, D-15).
  const gate = await gateProFeature(session.teacherIdentity, "lesson_notes");
  if (!gate.ok) return { ok: false, reason: "not-entitled" };

  const callerId = participant.role === "teacher" ? participant.teacher.id : participant.student.id;
  return { ok: true, session, callerId };
}
