import type { ClassContentSource } from "@/lib/materials/config";

// What the version-history list in the material editor actually shows: which
// kind of change a revision undoes, when, and a one-line snippet. Restore
// posts the revision's id and the server reads the body itself, so the
// editor never needs a revision's full body.
//
// Shipping the full body instead put up to 20 revision bodies per row into
// every library shelf — the whole page's history, re-sent on every level
// change and parsed on the teacher's tablet, for a list nobody had opened.
// Pure (no Prisma) so the client editor can share the constants.

/** How many revisions the editor lists. Storage keeps more (the cap in config). */
export const REVISIONS_SHOWN = 10;

/** Characters of the snippet that identifies a revision in the list. */
export const REVISION_PREVIEW_CHARS = 60;

export type MaterialRevisionSummary = {
  id: string;
  source: ClassContentSource;
  createdAt: Date;
  /** Whitespace-collapsed opening of the body; empty for an empty body. */
  preview: string;
};

export function summarizeRevision(r: {
  id: string;
  body: string;
  source: ClassContentSource;
  createdAt: Date;
}): MaterialRevisionSummary {
  return {
    id: r.id,
    source: r.source,
    createdAt: r.createdAt,
    preview: r.body.replace(/\s+/g, " ").trim().slice(0, REVISION_PREVIEW_CHARS),
  };
}
