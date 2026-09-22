import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { materialSendTimeElapsed } from "@/lib/materials/timing";
import { getStorageProvider } from "@/lib/storage/provider";
import { pickMaterialsUrl } from "@/lib/storage/signed-urls";
import type { MaterialTiming } from "@/lib/notifications/materials";
import type { StudentMaterialItem, StudentMaterialKind } from "./student-materials";

// "What material did we use with this student, and when?" — one query behind
// every surface that answers it (the student detail page's history section and
// the class-content composer's "continue from a previous class" picker).
//
// THE POINT IS THE UNION. A material reaches a class by three different routes
// and, before this module, each surface saw at most one of them:
//   1. booking-scoped LibraryMaterial (bookingId set) — the class's own file,
//      link, or lesson content. The student page used to exclude `body`-bearing
//      rows, which threw away the class's actual lesson content: usually THE
//      material of that class.
//   2. BookingLibraryMaterial — a reusable library item attached to the class
//      ahead of time. No surface aggregated these per student at all.
//   3. ClassMaterialUse — a material the teacher opened ON the call. A library
//      item opened mid-call and never attached exists in no other table.
// Sources 1 and 2 are "prepared"; source 3 is "actually used", and a class
// routinely has more of the former. Both facts matter, so a row carries both
// rather than the union collapsing them.

// How far back the history reads, newest class first. Bounded because a
// long-running teacher–student pairing is unbounded, and because source 1
// selects `body` to derive a title for content rows (see bodyHead below) —
// that is the one heavy column here, so the cap is what keeps the page's cost
// flat rather than growing with the relationship.
export const STUDENT_MATERIAL_HISTORY_LIMIT = 120;

// How much of a body is kept to derive a display title from its first heading.
// The rest is dropped in the mapper and never crosses the wire.
const BODY_HEAD_CHARS = 400;

export type ClassMaterialHistoryDeps = {
  db: PrismaClient;
  mintUrl: (m: { storagePath: string | null; linkUrl: string | null }) => Promise<string | null>;
  now: Date;
};

// The shape the three queries are normalized into before merging. Kept
// separate from StudentMaterialItem so the merge is a pure function over plain
// data and can be tested without a database.
export type RawHistoryRow = {
  materialId: string;
  bookingId: string;
  classStart: Date;
  label: string | null;
  storagePath: string | null;
  linkUrl: string | null;
  bodyHead: string | null;
  origin: "class" | "library";
  sendTiming: MaterialTiming | null;
  usedInClass: boolean;
  createdAt: Date;
};

export function kindOfRow(r: {
  storagePath: string | null;
  linkUrl: string | null;
  bodyHead: string | null;
}): StudentMaterialKind {
  if (r.bodyHead != null && !r.storagePath && !r.linkUrl) return "content";
  return r.storagePath ? "file" : "link";
}

// Whether the student can see this row right now. A scheduled attachment is
// gated on its send time; a booking-scoped row with no timing is the old
// always-visible ClassContent behavior; a library item known ONLY from a
// ClassMaterialUse row was never attached, so it is not in her class list at
// all no matter how long ago the class was.
export function rowIsSent(
  r: { origin: "class" | "library"; sendTiming: MaterialTiming | null },
  classStart: Date,
  now: Date,
): boolean {
  if (r.sendTiming) return materialSendTimeElapsed(r.sendTiming, classStart, now);
  return r.origin === "class";
}

// Collapse the three sources onto one row per (class, material), newest class
// first. A material prepared AND opened yields a single row carrying both
// facts; `sendTiming` is taken from whichever source actually scheduled a
// delivery, since a use record never does.
export function mergeHistoryRows(rows: RawHistoryRow[]): RawHistoryRow[] {
  const byKey = new Map<string, RawHistoryRow>();
  for (const r of rows) {
    const key = `${r.bookingId}:${r.materialId}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...r });
      continue;
    }
    byKey.set(key, {
      ...prev,
      // Prefer a real attachment's metadata over a use record's thinner copy.
      label: prev.label ?? r.label,
      storagePath: prev.storagePath ?? r.storagePath,
      linkUrl: prev.linkUrl ?? r.linkUrl,
      bodyHead: prev.bodyHead ?? r.bodyHead,
      sendTiming: prev.sendTiming ?? r.sendTiming,
      // A booking-scoped row wins the origin: it IS this class's own material,
      // which a use record can't tell you.
      origin: prev.origin === "class" || r.origin === "class" ? "class" : "library",
      usedInClass: prev.usedInClass || r.usedInClass,
      createdAt: prev.createdAt < r.createdAt ? prev.createdAt : r.createdAt,
    });
  }
  return [...byKey.values()].sort(
    (a, b) =>
      b.classStart.getTime() - a.classStart.getTime() ||
      b.createdAt.getTime() - a.createdAt.getTime(),
  );
}

const head = (body: string | null): string | null =>
  body == null ? null : body.slice(0, BODY_HEAD_CHARS);

/**
 * Every material that touched any of this student's classes with this teacher,
 * newest class first. Archived materials are excluded, matching the archive-as-
 * soft-delete convention everywhere else in the library.
 */
export async function listStudentMaterialHistory(
  input: { teacherId: string; studentId: string },
  deps?: Partial<ClassMaterialHistoryDeps>,
): Promise<StudentMaterialItem[]> {
  const db = deps?.db ?? prisma;
  const now = deps?.now ?? new Date();
  const { teacherId, studentId } = input;

  const materialSelect = {
    id: true,
    label: true,
    storagePath: true,
    linkUrl: true,
    body: true,
  } as const;
  const bookingSelect = { id: true, scheduledStart: true } as const;

  const [ownRows, attachedRows, usedRows] = await Promise.all([
    // 1. The class's own materials — including `body`-bearing lesson content,
    //    which the previous student-page query explicitly excluded.
    db.libraryMaterial.findMany({
      where: {
        teacherId,
        bookingId: { not: null },
        archived: false,
        booking: { studentId, teacherId },
      },
      orderBy: [{ booking: { scheduledStart: "desc" } }, { createdAt: "desc" }],
      take: STUDENT_MATERIAL_HISTORY_LIMIT,
      select: {
        ...materialSelect,
        sendTiming: true,
        createdAt: true,
        booking: { select: bookingSelect },
      },
    }),
    // 2. Reusable library items attached to one of her classes.
    db.bookingLibraryMaterial.findMany({
      where: {
        booking: { teacherId, studentId },
        material: { teacherId, archived: false },
      },
      orderBy: { booking: { scheduledStart: "desc" } },
      take: STUDENT_MATERIAL_HISTORY_LIMIT,
      select: {
        sendTiming: true,
        attachedAt: true,
        booking: { select: bookingSelect },
        material: { select: { ...materialSelect, bookingId: true } },
      },
    }),
    // 3. Materials actually opened during a class.
    db.classMaterialUse.findMany({
      where: { teacherId, booking: { teacherId, studentId }, material: { archived: false } },
      orderBy: { booking: { scheduledStart: "desc" } },
      take: STUDENT_MATERIAL_HISTORY_LIMIT,
      select: {
        openedAt: true,
        booking: { select: bookingSelect },
        material: { select: { ...materialSelect, bookingId: true, sendTiming: true } },
      },
    }),
  ]);

  const raw: RawHistoryRow[] = [
    // The relation filters above already exclude rows without a matching
    // booking, so `booking` is non-null here — the selected type just can't
    // express that.
    ...ownRows.map((m) => ({
      materialId: m.id,
      bookingId: m.booking!.id,
      classStart: m.booking!.scheduledStart,
      label: m.label,
      storagePath: m.storagePath,
      linkUrl: m.linkUrl,
      bodyHead: head(m.body),
      origin: "class" as const,
      sendTiming: m.sendTiming,
      usedInClass: false,
      createdAt: m.createdAt,
    })),
    ...attachedRows.map((a) => ({
      materialId: a.material.id,
      bookingId: a.booking.id,
      classStart: a.booking.scheduledStart,
      label: a.material.label,
      storagePath: a.material.storagePath,
      linkUrl: a.material.linkUrl,
      bodyHead: head(a.material.body),
      origin: (a.material.bookingId ? "class" : "library") as "class" | "library",
      sendTiming: a.sendTiming,
      usedInClass: false,
      createdAt: a.attachedAt,
    })),
    ...usedRows.map((u) => ({
      materialId: u.material.id,
      bookingId: u.booking.id,
      classStart: u.booking.scheduledStart,
      label: u.material.label,
      storagePath: u.material.storagePath,
      linkUrl: u.material.linkUrl,
      bodyHead: head(u.material.body),
      origin: (u.material.bookingId ? "class" : "library") as "class" | "library",
      // A use record never schedules a delivery of its own; the merge takes
      // the timing from an attachment row when one exists for the same pair.
      sendTiming: null,
      usedInClass: true,
      createdAt: u.openedAt,
    })),
  ];

  const merged = mergeHistoryRows(raw).slice(0, STUDENT_MATERIAL_HISTORY_LIMIT);

  const storage = merged.some((r) => r.storagePath) ? getStorageProvider() : null;
  const mintUrl =
    deps?.mintUrl ??
    ((m: { storagePath: string | null; linkUrl: string | null }) => pickMaterialsUrl(storage, m));

  return Promise.all(
    merged.map(async (r) => {
      const kind = kindOfRow(r);
      return {
        id: `${r.bookingId}:${r.materialId}`,
        materialId: r.materialId,
        bookingId: r.bookingId,
        classStart: r.classStart,
        label: r.label,
        storagePath: r.storagePath,
        linkUrl: r.linkUrl,
        bodyHead: r.bodyHead,
        attachmentKind: kind,
        origin: r.origin,
        // Native content has nothing to open externally — it is read in-app on
        // the class page (`href`), which is also where the teacher wants to
        // land from a history row: the class, in context.
        viewUrl:
          kind === "content"
            ? null
            : await mintUrl({ storagePath: r.storagePath, linkUrl: r.linkUrl }),
        href: `/dashboard/classes/${r.bookingId}`,
        sendTiming: r.sendTiming,
        sent: rowIsSent(r, r.classStart, now),
        usedInClass: r.usedInClass,
        createdAt: r.createdAt,
      } satisfies StudentMaterialItem;
    }),
  );
}
