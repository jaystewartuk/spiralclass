// In-class live notes — when a student-audience note is visible to the student.
//
// D-15: student visibility is a time window derived from the booking schedule,
// not a stored flag. A teacher can draft cues days ahead without leaking them
// early; the student sees student-audience notes only from shortly before the
// class through shortly after it ends. Teacher-audience notes are never visible
// to the student at any time (enforced at the query layer, not here).
//
// This is the single source of truth every gated student read path must call,
// mirroring how materialSendTimeElapsed governs class-material visibility.

// Minutes before scheduledStart the student panel opens. Tuned so a student can
// glance at it while connecting, not as pre-reading (that's what materials are).
export const NOTE_VISIBLE_BEFORE_MIN = 15;

// Minutes after scheduledEnd the student panel stays open, so instructions
// written near the end of class don't vanish the moment it's over. Deliberately
// its own constant rather than the teacher's inter-class buffer (D-15).
export const NOTE_VISIBLE_AFTER_MIN = 30;

export function lessonNoteStudentVisible(
  scheduledStart: Date,
  scheduledEnd: Date,
  now: Date,
): boolean {
  const opensAt = scheduledStart.getTime() - NOTE_VISIBLE_BEFORE_MIN * 60_000;
  const closesAt = scheduledEnd.getTime() + NOTE_VISIBLE_AFTER_MIN * 60_000;
  const t = now.getTime();
  return t >= opensAt && t <= closesAt;
}
