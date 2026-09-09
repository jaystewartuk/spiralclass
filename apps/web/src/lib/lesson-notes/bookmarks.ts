import type { PrismaClient } from "@prisma/client";

// In-call bookmarks (D-97) — a one-tap "mark this moment" action during a
// live class, layered on the existing LessonNote mechanism (kind='bookmark')
// rather than a new model. Surfaced as jump points on the lesson replay view.
//
// The replay-relative timestamp is never stored: it's derived at read time as
// `note.createdAt - min(LessonAudio.startedAt)` for the booking — the exact
// same 0-basis normalizeTimeline already rebases transcript utterances onto
// (lib/transcription/merge.ts), so a bookmark seeks the replay video to the
// same instant a transcript row would. This sidesteps needing the live call
// client to track/sync a "recording start" clock of its own.

export type ReplayBookmark = { id: string; label: string; atMs: number | null };

type Db = Pick<PrismaClient, "lessonNote" | "booking">;

// Append a bookmark to the teacher's own note column for this booking. No
// custom label at creation time — it's a fast one-tap action; the teacher can
// rename it afterward like any other note (updateLessonNote already works on
// any LessonNote row, kind included).
export async function createBookmark(
  prisma: Db,
  args: { bookingId: string; teacherId: string; label: string },
): Promise<{ ok: true } | { ok: false; reason: "not-found" }> {
  const booking = await prisma.booking.findFirst({
    where: { id: args.bookingId, teacherId: args.teacherId },
    select: { id: true },
  });
  if (!booking) return { ok: false, reason: "not-found" };

  const last = await prisma.lessonNote.findFirst({
    where: { bookingId: booking.id, audience: "teacher", kind: "bookmark" },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  await prisma.lessonNote.create({
    data: {
      bookingId: booking.id,
      teacherId: args.teacherId,
      audience: "teacher",
      kind: "bookmark",
      body: args.label,
      position: (last?.position ?? -1) + 1,
    },
    select: { id: true },
  });

  return { ok: true };
}

// Pure: rebase each bookmark's wall-clock createdAt onto the booking's
// 0-based recording timeline. `audioStartedAts` is every LessonAudio row's
// startedAt for the booking (order-independent — we take the min). Null when
// there's no recording timeline to rebase onto yet, or the bookmark predates
// it (clamped to 0 for a small negative skew rather than dropped).
export function computeBookmarkTimeline(
  bookmarks: { id: string; body: string; createdAt: Date }[],
  audioStartedAts: Date[],
): ReplayBookmark[] {
  if (audioStartedAts.length === 0) {
    return bookmarks.map((b) => ({ id: b.id, label: b.body, atMs: null }));
  }
  const base = Math.min(...audioStartedAts.map((d) => d.getTime()));
  return bookmarks.map((b) => ({
    id: b.id,
    label: b.body,
    atMs: Math.max(0, b.createdAt.getTime() - base),
  }));
}
