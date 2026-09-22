import type { PrismaClient } from "@prisma/client";
import { stripAnswerKeyMarkdown } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";

// The STUDENT's copy of a class's native written content (D-17/D-69: the
// booking-scoped, body-bearing LibraryMaterial with `sendTiming` null, always
// visible once present — no send-time gate, unlike an attached material).
//
// WHY A RESOLVER AND NOT THE QUERY INLINE. Three student surfaces read this
// same row — the web class page, the web print/read view
// (my-classes/[id]/content) and the mobile class-detail endpoint — and each
// had its own copy of the `where`. The body they hand over is the teacher's
// AUTHORING copy: the generator puts every solution in a `> [!answer]` callout
// and the renderers collapse those behind a "Show answer" toggle, which is
// presentation, not a boundary. So all three shipped the answer key to the
// student, and a fix applied to one of them would have left the other two
// serving it. One resolver means the strip happens once, before the row ever
// leaves the server, and a fourth student surface gets it by construction.
//
// The teacher's own read of this row goes through `findContentMaterial`
// (lib/materials/handlers.ts), which is scoped by `teacherId` and deliberately
// keeps the answer key — she is the one person who is meant to see it.

export type StudentClassContent = {
  /** Answer-key callouts already cut out. Empty when the whole body was one. */
  body: string;
  storagePath: string | null;
  linkUrl: string | null;
};

export async function getStudentClassContent(
  bookingId: string,
  deps?: { db?: PrismaClient },
): Promise<StudentClassContent | null> {
  const db = deps?.db ?? prisma;
  const row = await db.libraryMaterial.findFirst({
    where: { bookingId, sendTiming: null, body: { not: null } },
    select: { body: true, storagePath: true, linkUrl: true },
  });
  // The `where` already excludes a null body; the guard narrows the type (and
  // covers an injected test double that ignores the where clause).
  //
  // NOTE the asymmetry with the empty-string case below: a body that strips to
  // "" still returns a row, because a content material can carry a file and a
  // link on the SAME row and those are not the answer key. Callers that have
  // nothing else to show for an empty body (the print view) check `body`
  // themselves.
  if (!row?.body) return null;
  return {
    body: stripAnswerKeyMarkdown(row.body),
    storagePath: row.storagePath,
    linkUrl: row.linkUrl,
  };
}
