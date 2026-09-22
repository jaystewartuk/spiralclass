import type { PrismaClient } from "@prisma/client";
import type {
  MaterialAttachmentKind,
  MaterialTag,
  StudentLibrary,
  StudentMaterialEntry,
  StudentMaterialSource,
} from "@spiralclass/shared";
import {
  groupMaterialsByCategory,
  isImageFileName,
  stripAnswerKeyMarkdown,
} from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { getTeacherLevels, libraryBrowseWhere, type LevelRow } from "@/lib/levels";
import { materialSendTimeElapsed } from "@/lib/materials/timing";
import { getStorageProvider } from "@/lib/storage/provider";
import { pickMaterialsUrl } from "@/lib/storage/signed-urls";
import { mintMaterialPodcastSignedUrl } from "@/lib/storage/material-podcast";

// Injectable deps so the composition (aggregation, dedupe, grouping, URL
// minting) is unit-testable without a database. Production uses the real prisma
// singleton and a per-request signed-URL minter.
export type StudentLibraryDeps = {
  db: PrismaClient;
  mintUrl: (m: { storagePath: string | null; linkUrl: string | null }) => Promise<string | null>;
  // Mints a signed playback URL for a ready podcast's audio. Injectable so the
  // composition is testable without R2; production uses the R2 presigner.
  mintPodcastUrl: (storagePath: string) => Promise<string | null>;
  now: Date;
};

// The student-facing library read, behind the web page (mis-clases/materiales).
// Return type is the wire contract `StudentLibrary` from @spiralclass/shared.
//
// Three sources compose into ONE organized, category-grouped list:
//   * browse   — items at the student's level and below (+ `all`). Level-capped;
//                empty when the student has no level (docs/.../LEVEL_MATERIALS_PLAN).
//   * assigned — items the teacher explicitly assigned to THIS student's
//                notebook, shown regardless of level, with a covered flag.
//   * class    — items the teacher attached to one of the student's classes
//                (a fresh booking-scoped upload OR a library item attached via
//                BookingLibraryMaterial), gated by send-time, regardless of
//                level. Carries the class date.
// Deduped by material id (assigned > class > browse — keep the most explicit
// source), then bucketed into one primary category each (groupMaterialsByCategory).

const EMPTY: StudentLibrary = { hasLevel: false, levelLabel: null, categories: [] };

// The select shape for a material's tags across every source query.
const TAG_SELECT = {
  focusTags: {
    select: { focusTag: { select: { id: true, label: true, categoryId: true, archived: true } } },
  },
} as const;

const MATERIAL_SELECT = {
  id: true,
  levelId: true,
  label: true,
  unit: true,
  storagePath: true,
  linkUrl: true,
  body: true,
  podcast: { select: { status: true, storagePath: true, durationSec: true } },
  createdAt: true,
  ...TAG_SELECT,
} as const;

type MaterialRow = {
  id: string;
  levelId: string | null;
  label: string | null;
  unit: string | null;
  storagePath: string | null;
  linkUrl: string | null;
  body: string | null;
  // Optional so unit-test fixtures (which omit it) still type-check; a real
  // Prisma row always carries the relation (null when no podcast exists).
  podcast?: {
    status: "pending" | "ready" | "failed";
    storagePath: string | null;
    durationSec: number | null;
  } | null;
  // Optional so unit-test fixtures (which omit it) still type-check; a real
  // Prisma row always carries it. Drives the newest-first browse order.
  createdAt?: Date | null;
  focusTags: { focusTag: { id: string; label: string; categoryId: string; archived: boolean } }[];
};

// Lower rank wins on dedupe and sorts earlier within a category group.
const SOURCE_RANK: Record<StudentMaterialSource, number> = { assigned: 0, class: 1, browse: 2 };

function tagsOf(m: MaterialRow): MaterialTag[] {
  return m.focusTags
    .filter((t) => !t.focusTag.archived)
    .map((t) => ({
      id: t.focusTag.id,
      label: t.focusTag.label,
      categoryId: t.focusTag.categoryId,
    }));
}

export async function getStudentLibraryView(
  studentId: string,
  deps?: Partial<StudentLibraryDeps>,
): Promise<StudentLibrary> {
  const db = deps?.db ?? prisma;
  const now = deps?.now ?? new Date();

  // A Student row belongs to one teacher; its level (and the library it can
  // see) come from that teacher_students link.
  const link = await db.teacherStudent.findFirst({
    where: { studentId },
    select: { teacherId: true, levelId: true },
  });
  if (!link) return EMPTY;
  const teacherId = link.teacherId;

  // Levels + categories first — the browse `where` and the grouping both depend
  // on them, so they can't be in the same Promise.all as the material queries.
  const [levels, categoryRows] = await Promise.all([
    getTeacherLevels(teacherId, db),
    db.focusTagCategory.findMany({
      where: { teacherId, archived: false },
      select: { id: true, label: true, position: true },
      orderBy: { position: "asc" },
    }),
  ]);

  const [browseItems, assignments, bookings] = await Promise.all([
    db.libraryMaterial.findMany({
      where: libraryBrowseWhere(teacherId, levels, link.levelId),
      // Newest-first — teacher per-item reorder was retired (the redesign moved
      // the library to a sort menu), so students browse in creation order. The
      // final in-memory sort below is authoritative; this just keeps the fetch
      // deterministic on the same key.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: MATERIAL_SELECT,
    }),
    db.studentLibraryItem.findMany({
      where: { studentId, teacherId, material: { archived: false } },
      orderBy: { assignedAt: "desc" },
      select: { completedAt: true, material: { select: MATERIAL_SELECT } },
    }),
    // Every class of this student, with both attachment sources. The
    // `body: null` filter keeps booking-scoped rows to real attachments,
    // matching what the class page's materials list shows.
    db.booking.findMany({
      where: { studentId },
      select: {
        scheduledStart: true,
        materials: {
          where: { body: null },
          select: { ...MATERIAL_SELECT, sendTiming: true },
        },
        libraryMaterials: {
          select: { sendTiming: true, material: { select: MATERIAL_SELECT } },
        },
      },
    }),
  ]);

  const labelByLevel = new Map(levels.map((l: LevelRow) => [l.id, l.label]));

  let mintUrl = deps?.mintUrl;
  if (!mintUrl) {
    // Only spin up a storage client if some file-backed row is actually present.
    const anyFile =
      browseItems.some((m) => m.storagePath) ||
      assignments.some((a) => a.material.storagePath) ||
      bookings.some(
        (b) =>
          b.materials.some((m) => m.storagePath) ||
          b.libraryMaterials.some((a) => a.material.storagePath),
      );
    const storage = anyFile ? getStorageProvider() : null;
    mintUrl = (m) => pickMaterialsUrl(storage, m);
  }
  const mintPodcastUrl = deps?.mintPodcastUrl ?? mintMaterialPodcastSignedUrl;

  // Intermediate rows carry sort keys (source rank, class date, level position)
  // alongside the wire entry so we can order once, then group.
  type Built = {
    id: string;
    rank: number;
    classAt: number; // epoch ms, 0 when not a class item
    createdMs: number; // epoch ms of creation; 0 when absent (test fixtures)
    entry: StudentMaterialEntry;
  };

  const build = async (
    m: MaterialRow,
    source: StudentMaterialSource,
    extra?: { completed?: boolean; classStartsAt?: Date },
  ): Promise<Built> => {
    // A material may carry any combination of body/file/link (unified material).
    // `attachmentKind` reflects the primary piece for grouping/back-compat, but
    // each piece is exposed so the renderer can surface all of them.
    const attachmentKind: MaterialAttachmentKind =
      m.body != null ? "content" : m.storagePath ? "file" : "link";
    const fileUrl = m.storagePath
      ? await mintUrl!({ storagePath: m.storagePath, linkUrl: null })
      : null;
    // A ready podcast gets a signed playback URL so the student can listen.
    const podcastUrl =
      m.podcast?.status === "ready" && m.podcast.storagePath
        ? await mintPodcastUrl(m.podcast.storagePath)
        : null;
    const tags = tagsOf(m);
    const entry: StudentMaterialEntry = {
      id: m.id,
      label: m.label,
      unit: m.unit,
      levelLabel: (m.levelId ? labelByLevel.get(m.levelId) : undefined) ?? "",
      attachmentKind,
      viewUrl: fileUrl ?? m.linkUrl ?? null,
      // The STUDENT copy of the body: every `> [!answer]` callout cut out.
      // This whole view is student-facing, so the same rule the in-call viewer
      // and the student PDF export follow applies — the renderer's "Show
      // answer" toggle is presentation, not a boundary, and an unstripped body
      // here is one devtools panel away from being the answer key.
      // `attachmentKind` above is computed from
      // the RAW body on purpose: a material that is nothing but an answer key
      // strips to "" and is still a content material, not a link.
      body: stripAnswerKeyMarkdown(m.body ?? null),
      fileUrl,
      linkUrl: m.linkUrl,
      // Derived from the stored key, the only place the original filename
      // survives — `storagePath` is dropped by every wire mapper, so a client
      // could not work this out for itself.
      isImage: isImageFileName(m.storagePath),
      podcastUrl,
      podcastDurationSec: m.podcast?.durationSec ?? null,
      tags,
      source,
      classStartsAt: extra?.classStartsAt ? extra.classStartsAt.toISOString() : null,
      ...(extra?.completed !== undefined ? { completed: extra.completed } : {}),
    };
    return {
      id: m.id,
      rank: SOURCE_RANK[source],
      classAt: extra?.classStartsAt ? extra.classStartsAt.getTime() : 0,
      createdMs: m.createdAt ? new Date(m.createdAt).getTime() : 0,
      entry,
    };
  };

  const builtLists = await Promise.all([
    Promise.all(browseItems.map((m) => build(m, "browse"))),
    Promise.all(
      assignments.map((a) => build(a.material, "assigned", { completed: a.completedAt != null })),
    ),
    Promise.all(
      bookings.flatMap((b) => {
        const out: Promise<Built>[] = [];
        for (const m of b.materials) {
          if (materialSendTimeElapsed(m.sendTiming, b.scheduledStart, now)) {
            out.push(build(m, "class", { classStartsAt: b.scheduledStart }));
          }
        }
        for (const a of b.libraryMaterials) {
          if (materialSendTimeElapsed(a.sendTiming, b.scheduledStart, now)) {
            out.push(build(a.material, "class", { classStartsAt: b.scheduledStart }));
          }
        }
        return out;
      }),
    ),
  ]);

  // Dedupe by material id: keep the most explicit source (lowest rank); among
  // equal ranks (e.g. the same item on two classes) keep the most recent class.
  const byId = new Map<string, Built>();
  for (const built of builtLists.flat()) {
    const prev = byId.get(built.id);
    if (
      !prev ||
      built.rank < prev.rank ||
      (built.rank === prev.rank && built.classAt > prev.classAt)
    ) {
      byId.set(built.id, built);
    }
  }

  // Order: most explicit source first (assigned > class > browse), then newest
  // class, then newest-created (the retired-reorder decision — students browse
  // in creation order), then label as a stable final tiebreak. Grouping
  // preserves this order within each category.
  const ordered = [...byId.values()].sort(
    (a, b) =>
      a.rank - b.rank ||
      b.classAt - a.classAt ||
      b.createdMs - a.createdMs ||
      (a.entry.label ?? "").localeCompare(b.entry.label ?? ""),
  );

  const categories = groupMaterialsByCategory(
    ordered.map((b) => b.entry),
    categoryRows,
    // The uncategorized bucket's label is localized at render time by the
    // client (categoryId === null → t("library.otherCategory")); the server
    // leaves it blank rather than shipping an untranslated string.
    "",
  ).map((g) => ({ categoryId: g.categoryId, categoryLabel: g.categoryLabel, items: g.items }));

  return {
    hasLevel: link.levelId != null,
    levelLabel: (link.levelId ? labelByLevel.get(link.levelId) : null) ?? null,
    categories,
  };
}
