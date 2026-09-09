import type { PrismaClient } from "@prisma/client";

import { RECORDINGS_BUCKET } from "@/lib/storage/lesson-recording";
import { getStorageProvider } from "@/lib/storage/provider";
import { logger } from "@/lib/logger";

const log = logger({ surface: "purge-recordings" });

// Closing a teacher's account destroys her class recordings and everything
// derived from them (D-136).
//
// The privacy policy already promised this and the code did not do it. The
// retention table in packages/shared/src/legal/privacy-policy.ts has said, since
// D-131, that "a class recording a teacher started, and its transcript" is kept
// "while the teacher's account is open" — but anonymizeTeacher only ever touched
// the teacher row, device tokens and notifications, so the R2 objects and their
// rows survived the account forever. D-131 named that gap in its own unresolved
// risks ("nothing purges recordings from R2 on account closure") and shipped
// anyway. This closes it.
//
// Four things go, all keyed off the denormalized `teacherId` every one of these
// models already carries:
//
//   - CallRecording — the room-composite recording (audio-only since D-135) and
//     its R2 object.
//   - LessonAudio — per-speaker insights audio. Normally already discarded right
//     after transcription (transcription/pipeline.ts's derive-then-discard), so
//     this catches the keep-on-opt-in rows and anything a failed discard left
//     behind.
//   - LessonTranscript and LessonSummary — pure DB, and the policy row binds the
//     transcript to the recording explicitly.
//
// STORAGE FIRST, ROW SECOND, ONE OBJECT AT A TIME. The row is the only pointer
// to the object, so deleting it before the object succeeds would orphan a
// recording in R2 with nothing left to find it by — the opposite of what this
// function is for. The provider's `remove` aborts a batch on its first failure,
// so a batched call would strand every key after the failing one; per-object
// calls mean one unreachable object costs one row, not all of them. A row whose
// object could not be deleted is deliberately LEFT IN PLACE.

export type RecordingPurgeResult = {
  recordings: number;
  lessonAudio: number;
  transcripts: number;
  summaries: number;
  // Objects R2 refused to delete. Their rows are still there, on purpose.
  objectsFailed: number;
};

type Db = Pick<
  PrismaClient,
  "callRecording" | "lessonAudio" | "lessonTranscript" | "lessonSummary"
>;

type Remove = (key: string) => Promise<boolean>;

// Default remover: one object, one call, `true` only when it is really gone.
// R2 treats a 404 as success (createR2Provider's own `remove`), which is what we
// want — an object already absent should not pin its row forever.
const defaultRemove: Remove = async (key) => {
  const { error } = await getStorageProvider().remove(RECORDINGS_BUCKET, [key]);
  return error === null;
};

async function purgeKeyed(
  rows: { id: string; storageKey: string }[],
  remove: Remove,
  deleteRows: (ids: string[]) => Promise<unknown>,
): Promise<{ deleted: number; failed: number }> {
  const deletable: string[] = [];
  let failed = 0;
  for (const row of rows) {
    let gone = false;
    try {
      gone = await remove(row.storageKey);
    } catch (err) {
      log.warn("object delete threw", { storageKey: row.storageKey, err: String(err) });
    }
    if (gone) deletable.push(row.id);
    else failed += 1;
  }
  if (deletable.length > 0) await deleteRows(deletable);
  return { deleted: deletable.length, failed };
}

export async function purgeTeacherRecordings(
  prisma: Db,
  teacherId: string,
  remove: Remove = defaultRemove,
): Promise<RecordingPurgeResult> {
  const [recordings, audio] = await Promise.all([
    prisma.callRecording.findMany({ where: { teacherId }, select: { id: true, storageKey: true } }),
    prisma.lessonAudio.findMany({ where: { teacherId }, select: { id: true, storageKey: true } }),
  ]);

  const rec = await purgeKeyed(recordings, remove, (ids) =>
    prisma.callRecording.deleteMany({ where: { id: { in: ids } } }),
  );
  const aud = await purgeKeyed(audio, remove, (ids) =>
    prisma.lessonAudio.deleteMany({ where: { id: { in: ids } } }),
  );

  // No object behind either of these — the transcript and summary are rows.
  const [transcripts, summaries] = await Promise.all([
    prisma.lessonTranscript.deleteMany({ where: { teacherId } }),
    prisma.lessonSummary.deleteMany({ where: { teacherId } }),
  ]);

  const result: RecordingPurgeResult = {
    recordings: rec.deleted,
    lessonAudio: aud.deleted,
    transcripts: transcripts.count,
    summaries: summaries.count,
    objectsFailed: rec.failed + aud.failed,
  };

  if (result.objectsFailed > 0) {
    // Loud, because nothing retries this: the deletion request is marked
    // complete either way, so a stranded object stays stranded until someone
    // reads this line. Accepted and written down in D-136 rather than papered
    // over with a retry queue no one would watch.
    log.error("recording purge left objects behind", undefined, { teacherId, ...result });
  } else {
    log.info("purged recordings on account closure", { teacherId, ...result });
  }
  return result;
}
