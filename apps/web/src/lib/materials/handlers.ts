import type { LibraryVisibility, MaterialSendTiming } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AppLocale } from "@/lib/i18n";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import { trackServerEvent } from "@/lib/analytics/posthog";
import {
  CLASS_CONTENT_AI_MONTHLY_CAP,
  CLASS_CONTENT_CONTINUATION_CANDIDATE_LIMIT,
  CLASS_CONTENT_MAX_CHARS,
  CLASS_CONTENT_CONTINUATION_MATERIAL_PROMPT_MAX_CHARS,
  CLASS_CONTENT_CONTINUATION_MAX_MATERIALS,
  CLASS_CONTENT_TEMPLATE_PROMPT_MAX_CHARS,
  MATERIAL_REFINE_INSTRUCTION_MAX_CHARS,
  monthStartUtc,
  validateClassContentBody,
  type ClassContentSource,
} from "@/lib/materials/config";
import { resolveClassContentTemplateBody } from "@/lib/materials/templates";
import { resolveFocusTagsWithCategory } from "@/lib/focus-tags";
import { usesEnglishCopy, languageName, resolveVocabulary } from "@spiralclass/shared";
import type { MaterialVocabulary } from "@spiralclass/shared";
import type { MaterialPromptInput } from "@/lib/materials/prompt";
import { materialSendTimeElapsed } from "@/lib/materials/timing";
import { enqueueMaterialsSend } from "@/lib/notifications/enqueue";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { logger } from "@/lib/logger";
import {
  listMaterialRevisions,
  snapshotMaterialRevision,
  type MaterialRevisionRow,
} from "@/lib/materials/revisions";
import { maybeAutoDraftAssignmentFromMaterial } from "@/lib/homework/auto-draft";

const log = logger({ surface: "materials-handlers" });

// The subject half of every AI prompt this module builds — read once, from the
// teacher, and applied identically to all three generation paths (class content,
// library material, streamed library material) so none of them can drift back
// into telling the model nothing about what's being taught.
//
// Language-first (D-72): the subject IS the language she teaches, so this is one
// code resolved to its English name for the prompt. Null when unset — the prompt
// says so outright rather than letting the model infer a subject.
async function resolveSubject(
  teacherId: string,
): Promise<
  Pick<
    MaterialPromptInput,
    | "targetLanguage"
    | "tone"
    | "learnerAge"
    | "languageVariety"
    | "customInstructions"
    | "vocabulary"
  >
> {
  const teacher = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: {
      targetLanguage: true,
      // AI material style (D-78) — read here so every generation path (class
      // content, library, streamed, refine) inherits the teacher's preference.
      // Stored values were validated on write (materialStyleSchema); the prompt
      // builders also ignore any unknown value (switch default → no directive).
      materialTone: true,
      materialLearnerAge: true,
      materialLanguageVariety: true,
      materialCustomInstructions: true,
      // Vocabulary difficulty default (D-80). The booking-scoped generator
      // overrides it per class; the library/refine paths use it as-is. Resolved
      // to a concrete value by the prompt builder (null → everyday).
      materialVocabulary: true,
    },
  });
  return {
    targetLanguage: teacher?.targetLanguage ? languageName(teacher.targetLanguage) : null,
    tone: (teacher?.materialTone as MaterialPromptInput["tone"]) ?? null,
    learnerAge: (teacher?.materialLearnerAge as MaterialPromptInput["learnerAge"]) ?? null,
    languageVariety: teacher?.materialLanguageVariety ?? null,
    customInstructions: teacher?.materialCustomInstructions ?? null,
    vocabulary: (teacher?.materialVocabulary as MaterialVocabulary | null) ?? null,
  };
}

// Platform-agnostic material-authoring logic (D-17, generalized by the
// ClassContent/ClassMaterial → LibraryMaterial merge, D-69), factored out of
// the web server actions so the mobile JSON API can reuse the exact same
// gating, validation, Pro-cap, and AI pipeline (web/mobile parity per
// CLAUDE.md). Returns localized messages so each caller just passes the
// result through. No `revalidatePath` here — that's web-only.
//
// This module covers the booking-scoped "content" material — a body-bearing
// LibraryMaterial with `bookingId` set and `sendTiming` null (the merged
// equivalent of the old singleton ClassContent row) — plus the standalone
// library-scoped AI generation path. Both share one prompt builder, one
// monthly AI cap, and (via materials/revisions.ts) one version-history log.
// File/link attachments — scheduled `sendTiming`, either fresh-uploaded or
// attached from the library — are simple CRUD on the same LibraryMaterial
// table and live directly in the callers (app/actions/library.ts and the
// mobile routes); they don't need the AI/versioning machinery here.

// @/lib/ai/anthropic pulls in `server-only`; it's imported dynamically inside
// the generate paths (after auth) so the GET/PUT/DELETE routes — and the
// route-inventory test that loads every handler — don't drag it into
// their graph.

export type { ClassContentSource };
export type { MaterialRevisionRow };

// Tenant-scoped booking lookup shared by every booking-scoped handler.
async function findOwnedBooking(teacherId: string, bookingId: string) {
  if (!bookingId) return null;
  return prisma.booking.findFirst({
    where: { id: bookingId, teacherId },
    select: { id: true, studentId: true },
  });
}

// The app layer treats "content" as a single slot per booking — at most one
// body-bearing, never-scheduled (sendTiming null) material — mirroring the old
// ClassContent row's UNIQUE booking_id even though the shared table no longer
// enforces that in the DB (D-69: a booking could in principle hold several
// body-bearing materials; the UI just doesn't offer that yet).
async function findContentMaterial(teacherId: string, bookingId: string) {
  return prisma.libraryMaterial.findFirst({
    where: { teacherId, bookingId, sendTiming: null, body: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { id: true, body: true, contentSource: true, storagePath: true, linkUrl: true },
  });
}

// Current saved content for a booking, or null. The view side of authoring —
// the editor opens pre-filled with whatever exists. `storagePath`/`linkUrl` are
// the file/link that may ride on the same content row (unified material).
export async function getClassContentForBooking(input: {
  teacherId: string;
  bookingId: string;
}): Promise<{
  id: string;
  body: string;
  source: ClassContentSource;
  storagePath: string | null;
  linkUrl: string | null;
} | null> {
  const booking = await findOwnedBooking(input.teacherId, input.bookingId);
  if (!booking) return null;
  const row = await findContentMaterial(input.teacherId, booking.id);
  if (!row || row.body == null) return null;
  return {
    id: row.id,
    body: row.body,
    source: (row.contentSource as ClassContentSource) ?? "manual",
    storagePath: row.storagePath,
    linkUrl: row.linkUrl,
  };
}

export type SaveClassContentResult =
  | { ok: true; materialId: string }
  | { ok: false; code: "not-pro" | "invalid" | "not-found"; message: string };

export async function saveClassContentForBooking(input: {
  teacherId: string;
  bookingId: string;
  body: string;
  source: ClassContentSource;
  // A content material may also carry a file and/or link on the same row
  // (unified material, "one material can hold body + file + link"). `undefined`
  // = leave whatever's there (a body-only edit doesn't wipe the file); `null` =
  // clear; a string = set. On first create both default to null.
  storagePath?: string | null;
  linkUrl?: string | null;
  locale: AppLocale;
}): Promise<SaveClassContentResult> {
  const en = usesEnglishCopy(input.locale);

  // Authoring class content is a Pro feature (viewing stays free).
  const gate = await gateProFeature(input.teacherId, "class_content");
  if (!gate.ok)
    return { ok: false, code: "not-pro", message: upgradeNudge(gate.limit, input.locale) };

  const validation = validateClassContentBody(input.body, input.locale);
  if (!validation.ok) return { ok: false, code: "invalid", message: validation.error };

  const booking = await findOwnedBooking(input.teacherId, input.bookingId);
  if (!booking) {
    return {
      ok: false,
      code: "not-found",
      message: en ? "Class not found." : "Clase no encontrada.",
    };
  }

  // Snapshot whatever this save is about to overwrite (task 5) — but only
  // when there's an existing, different body; a no-op save or the very first
  // save of a booking has nothing worth recovering.
  const existing = await findContentMaterial(input.teacherId, booking.id);
  if (existing && existing.body != null && existing.body !== validation.body) {
    await snapshotMaterialRevision({
      teacherId: input.teacherId,
      materialId: existing.id,
      body: existing.body,
      source: (existing.contentSource as ClassContentSource) ?? "manual",
    });
  }

  const row = existing
    ? await prisma.libraryMaterial.update({
        where: { id: existing.id },
        data: {
          body: validation.body,
          contentSource: input.source,
          ...(input.storagePath !== undefined ? { storagePath: input.storagePath } : {}),
          ...(input.linkUrl !== undefined ? { linkUrl: input.linkUrl } : {}),
        },
        select: { id: true },
      })
    : await prisma.libraryMaterial.create({
        data: {
          teacherId: input.teacherId,
          bookingId: booking.id,
          visibility: "at_or_below",
          body: validation.body,
          contentSource: input.source,
          storagePath: input.storagePath ?? null,
          linkUrl: input.linkUrl ?? null,
        },
        select: { id: true },
      });

  trackServerEvent({
    name: "class_content_saved",
    distinctId: input.teacherId,
    properties: {
      teacherId: input.teacherId,
      bookingId: booking.id,
      source: input.source,
      chars: validation.body.length,
    },
  });

  // Homework auto-draft (docs/features/homework.md) — one
  // shared handler for both web and mobile, so this needs no per-platform
  // wiring. Best-effort internally; never fails the content save.
  await maybeAutoDraftAssignmentFromMaterial({
    teacherId: input.teacherId,
    materialId: row.id,
    bookingId: booking.id,
    studentId: booking.studentId,
    body: validation.body,
    locale: input.locale,
  });

  return { ok: true, materialId: row.id };
}

export async function deleteClassContentForBooking(input: {
  teacherId: string;
  bookingId: string;
}): Promise<{ ok: true }> {
  const booking = await findOwnedBooking(input.teacherId, input.bookingId);
  if (!booking) return { ok: true };
  // deleteMany (not delete) so a missing row is a no-op, never a throw.
  await prisma.libraryMaterial.deleteMany({
    where: {
      teacherId: input.teacherId,
      bookingId: booking.id,
      sendTiming: null,
      body: { not: null },
    },
  });
  return { ok: true };
}

// ---------- lesson continuity ("continue from a previous class") ----------
//
// A teacher generating content for one class can point the AI at material
// from an earlier class with the same student, so it reinforces/builds on
// that instead of guessing from level+interests+goals alone (the gap this
// feature closes — see docs/features/library-materials.md). Two pieces: the
// picker's candidate list (this section) and the resolver that turns chosen
// ids into prompt context (used by generateClassContentForBooking below).

export type ContinuationCandidate = {
  materialId: string;
  bookingId: string;
  label: string | null;
  // ISO timestamp of the source class, so the picker can group/label by date
  // without a second round-trip.
  scheduledStart: string;
  // Short plain-text snippet (not the full body) — keeps the picker payload
  // light even with many candidates; the full body is re-fetched by id at
  // generation time in resolveContinuationMaterials below.
  preview: string;
};

// A material qualifies as continuation context when it has a body (there is
// nothing to inject for a file or a link — buildPrompt drops a body-less entry
// on the floor) AND it reached one of this student's OTHER classes by any of
// the three routes a material can take (see lib/materials/class-history.ts):
// the class's own content, a library item attached to the class, or a library
// item the teacher opened during the call.
//
// The last two used to be invisible here, so a teacher who taught off a
// library worksheet was offered nothing to continue from — the exact case this
// feature exists for. Written once and shared with resolveContinuationMaterials
// below so the picker can never offer an id the resolver then silently drops.
function continuationWhere(input: { teacherId: string; studentId: string; bookingId: string }) {
  const otherClassOfThisStudent = {
    studentId: input.studentId,
    teacherId: input.teacherId,
    id: { not: input.bookingId },
  };
  return {
    teacherId: input.teacherId,
    archived: false,
    body: { not: null },
    OR: [
      { booking: otherClassOfThisStudent },
      { bookingAttachments: { some: { booking: otherClassOfThisStudent } } },
      { classUses: { some: { teacherId: input.teacherId, booking: otherClassOfThisStudent } } },
    ],
  };
}

// The class this material belongs to, for the picker's date label. A
// booking-scoped material has exactly one; a reusable library item is dated by
// the most recent class of THIS student that it reached, which is what
// "continue from" means to a teacher scanning by date.
function continuationClassOf(m: {
  bookingId: string | null;
  booking: { id: string; scheduledStart: Date } | null;
  bookingAttachments: { booking: { id: string; scheduledStart: Date } }[];
  classUses: { booking: { id: string; scheduledStart: Date } }[];
}): { id: string; scheduledStart: Date } | null {
  if (m.booking) return m.booking;
  const candidates = [
    ...m.bookingAttachments.map((a) => a.booking),
    ...m.classUses.map((u) => u.booking),
  ];
  if (candidates.length === 0) return null;
  return candidates.reduce((best, b) => (b.scheduledStart > best.scheduledStart ? b : best));
}

// Candidates for the picker: material from this student's other classes, most
// recent first. Null when the booking isn't the caller's own (same
// tenant-ownership check as every other handler here).
export async function listContinuationCandidatesForBooking(input: {
  teacherId: string;
  bookingId: string;
}): Promise<ContinuationCandidate[] | null> {
  const booking = await findOwnedBooking(input.teacherId, input.bookingId);
  if (!booking) return null;

  const scope = {
    teacherId: input.teacherId,
    studentId: booking.studentId,
    bookingId: booking.id,
  };
  const classSelect = { select: { id: true, scheduledStart: true } } as const;
  const otherClassOfThisStudent = {
    studentId: booking.studentId,
    teacherId: input.teacherId,
    id: { not: booking.id },
  };

  const materials = await prisma.libraryMaterial.findMany({
    where: continuationWhere(scope),
    select: {
      id: true,
      label: true,
      body: true,
      bookingId: true,
      booking: classSelect,
      // Scoped to this student's other classes so a library item shared across
      // students is dated by a class of THIS pairing, never someone else's.
      bookingAttachments: {
        where: { booking: otherClassOfThisStudent },
        select: { booking: classSelect },
      },
      classUses: {
        where: { teacherId: input.teacherId, booking: otherClassOfThisStudent },
        select: { booking: classSelect },
      },
    },
    // A reusable library item's class date comes from a to-many relation,
    // which Postgres cannot ORDER BY here — so the newest-first ordering is
    // resolved in JS below. Over-fetch a bounded multiple of the limit first
    // so that sort sees enough rows to pick a genuine top N rather than
    // reordering an arbitrary slice, then cut back to the limit.
    orderBy: { createdAt: "desc" },
    take: CLASS_CONTENT_CONTINUATION_CANDIDATE_LIMIT * 3,
  });

  return materials
    .map((m) => {
      const cls = continuationClassOf(m);
      if (!cls) return null;
      return {
        materialId: m.id,
        bookingId: cls.id,
        label: m.label,
        scheduledStart: cls.scheduledStart.toISOString(),
        preview: (m.body ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
      };
    })
    .filter((c): c is ContinuationCandidate => c != null)
    .sort((a, b) => b.scheduledStart.localeCompare(a.scheduledStart))
    .slice(0, CLASS_CONTENT_CONTINUATION_CANDIDATE_LIMIT);
}

// Resolve a teacher's chosen continuation material ids into prompt context.
// Re-scoped to the same student + "not this booking" (same as the candidate
// list above) so a stale or tampered id from the client can't pull in another
// student's content. Silently drops ids that no longer resolve (deleted since
// the picker loaded) rather than failing the whole generation over it, and
// preserves the teacher's selection order — `findMany` with `id: in` does not.
async function resolveContinuationMaterials(input: {
  teacherId: string;
  studentId: string;
  bookingId: string;
  materialIds: string[];
}): Promise<{ label: string; body: string }[]> {
  const ids = input.materialIds.filter(Boolean).slice(0, CLASS_CONTENT_CONTINUATION_MAX_MATERIALS);
  if (ids.length === 0) return [];

  const rows = await prisma.libraryMaterial.findMany({
    where: {
      id: { in: ids },
      // Exactly the picker's own predicate, so a legitimately-offered id can
      // never be silently dropped here — and a tampered one still cannot
      // reach outside this teacher's material for this student.
      ...continuationWhere({
        teacherId: input.teacherId,
        studentId: input.studentId,
        bookingId: input.bookingId,
      }),
    },
    select: { id: true, label: true, body: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  return ids
    .map((id) => byId.get(id))
    .filter((r): r is (typeof rows)[number] => Boolean(r))
    .map((r) => ({
      label: r.label ?? "",
      body: (r.body ?? "").slice(0, CLASS_CONTENT_CONTINUATION_MATERIAL_PROMPT_MAX_CHARS),
    }));
}

export type GenerateClassContentResult =
  | { ok: true; body: string }
  | {
      ok: false;
      code: "not-pro" | "invalid" | "not-found" | "cap" | "not-configured" | "error";
      message: string;
    };

// AI compose. Generates Markdown for the teacher to review + edit — it does NOT
// save. Seeded with the student's level + profile + already-covered notebook
// items: the context an external chatbot can't see.
export async function generateClassContentForBooking(input: {
  teacherId: string;
  bookingId: string;
  topic: string;
  focusTagIds: string[];
  // The teacher's chosen lesson template (D-46) — its structure shapes the
  // output. Optional and tenant-scoped on resolve; a foreign/unknown/absent id
  // falls back to the default shape.
  templateId?: string | null;
  locale: AppLocale;
  // The language the content is written in. Omitted → the locale default. A
  // class's content is on the same axis as a library material's: a teacher who
  // drafts her library in French wants her classes in French too, so this is
  // not a library-only input.
  language?: string | null;
  // Per-class vocabulary difficulty (D-80). `undefined` = leave this class's
  // stored override untouched and generate with whatever it already is;
  // a value or explicit `null` = set the booking's override to it (null clears
  // the override, falling back to the teacher default) BEFORE generating, so
  // the compose picker is both the persisted class setting and the value that
  // drives this generation.
  vocabulary?: MaterialVocabulary | null;
  // Lesson continuity (opt-in): ids of previous classes' materials (this
  // student's, resolved/scoped in resolveContinuationMaterials) to feed as
  // "continue from" context. Absent/empty = today's behavior, unchanged.
  continueFromMaterialIds?: string[];
}): Promise<GenerateClassContentResult> {
  const en = usesEnglishCopy(input.locale);

  const gate = await gateProFeature(input.teacherId, "class_content");
  if (!gate.ok)
    return { ok: false, code: "not-pro", message: upgradeNudge(gate.limit, input.locale) };

  const topic = input.topic.trim().slice(0, 500);
  // Cap the focus-tag count so a crafted request can't bloat the prompt; ids are
  // tenant-scoped on resolve below.
  const focusTagIds = input.focusTagIds.filter(Boolean).slice(0, 12);
  const tags = await resolveFocusTagsWithCategory(input.teacherId, focusTagIds);
  // A "format" tag (if any) drives the deliverable shape, same as the library
  // generation path — everything else is just additional focus.
  const formatTag = tags.find((t) => t.categoryCode === "format");
  const focusLabels = tags.filter((t) => t.id !== formatTag?.id).map((t) => t.label);
  // The topic is optional once focus tags carry the intent, but require at least
  // one of the two so the model has something to go on.
  if (!topic && !formatTag && focusLabels.length === 0) {
    return {
      ok: false,
      code: "invalid",
      message: en
        ? "Pick a focus or describe what this class should cover."
        : "Elige un enfoque o describe de qué trata esta clase.",
    };
  }

  const booking = await prisma.booking.findFirst({
    where: { id: input.bookingId, teacherId: input.teacherId },
    // student.name is passed into the prompt so the model uses the ONE correct
    // name and never reproduces a stray name from the template/interests/goals
    // (the wrong-student-name bug). vocabularyOverride is this class's stored
    // vocabulary-difficulty override (D-80).
    select: {
      id: true,
      studentId: true,
      student: { select: { name: true } },
      vocabularyOverride: true,
    },
  });
  if (!booking) {
    return {
      ok: false,
      code: "not-found",
      message: en ? "Class not found." : "Clase no encontrada.",
    };
  }

  // Persist the class's vocabulary override when the caller supplied one (D-80),
  // so the compose picker doubles as the class setting. `undefined` leaves the
  // stored value alone; a value/null writes it. Resolve the effective value the
  // generation will use: class override ?? teacher default ?? everyday.
  let classVocabulary = booking.vocabularyOverride as MaterialVocabulary | null;
  if (input.vocabulary !== undefined) {
    await prisma.booking.update({
      where: { id: booking.id },
      data: { vocabularyOverride: input.vocabulary },
    });
    classVocabulary = input.vocabulary;
  }

  // Monthly AI-generation cap (D-17). Counts this calendar month's successes.
  const usedThisMonth = await prisma.classContentGeneration.count({
    where: { teacherId: input.teacherId, createdAt: { gte: monthStartUtc(new Date()) } },
  });
  if (usedThisMonth >= CLASS_CONTENT_AI_MONTHLY_CAP) {
    return {
      ok: false,
      code: "cap",
      message: en
        ? `You've reached this month's AI generation limit (${CLASS_CONTENT_AI_MONTHLY_CAP}). You can still write content yourself.`
        : `Alcanzaste el límite de generaciones con IA de este mes (${CLASS_CONTENT_AI_MONTHLY_CAP}). Aún puedes escribir el contenido tú mismo.`,
    };
  }

  // Level + durable profile live on TeacherStudent (correct under multi-teacher).
  const link = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: input.teacherId, studentId: booking.studentId } },
    select: { level: { select: { label: true } }, interests: true, goals: true },
  });

  // Resolve the teacher's chosen template (tenant-scoped) and bound the slice we
  // inject as the lesson structure (D-46).
  const templateBody = (
    await resolveClassContentTemplateBody(input.teacherId, input.templateId)
  )?.slice(0, CLASS_CONTENT_TEMPLATE_PROMPT_MAX_CHARS);

  const covered = await prisma.studentLibraryItem.findMany({
    where: { teacherId: input.teacherId, studentId: booking.studentId, completedAt: { not: null } },
    select: { material: { select: { label: true } } },
    take: 25,
  });
  const coveredTitles = covered.map((c) => c.material.label).filter((l): l is string => Boolean(l));

  const continueFromMaterials = input.continueFromMaterialIds?.length
    ? await resolveContinuationMaterials({
        teacherId: input.teacherId,
        studentId: booking.studentId,
        bookingId: booking.id,
        materialIds: input.continueFromMaterialIds,
      })
    : [];

  const subject = await resolveSubject(input.teacherId);
  const { generateMaterial } = await import("@/lib/ai/anthropic");
  const result = await generateMaterial({
    topic,
    levelLabel: link?.level?.label ?? null,
    formatLabel: formatTag?.label ?? null,
    focusLabels,
    interests: link?.interests ?? null,
    goals: link?.goals ?? null,
    studentName: booking.student?.name ?? null,
    coveredTitles,
    continueFromMaterials,
    templateBody: templateBody ?? null,
    forClass: true,
    locale: input.locale,
    language: input.language ?? null,
    ...subject,
    // The class override beats the teacher default `subject.vocabulary`, so it
    // must be applied AFTER the spread (D-80).
    vocabulary: resolveVocabulary(classVocabulary, subject.vocabulary),
  });

  if (!result.ok) {
    if (result.reason === "not-configured") {
      return {
        ok: false,
        code: "not-configured",
        message: en
          ? "AI generation isn't available right now. You can still write the content yourself."
          : "La generación con IA no está disponible ahora. Aún puedes escribir el contenido tú mismo.",
      };
    }
    return {
      ok: false,
      code: "error",
      message: en
        ? "Couldn't generate content. Please try again."
        : "No se pudo generar el contenido. Inténtalo de nuevo.",
    };
  }

  // One row per success — what the monthly cap counts. Failures don't burn quota.
  await prisma.classContentGeneration.create({ data: { teacherId: input.teacherId } });

  trackServerEvent({
    name: "class_content_generated",
    distinctId: input.teacherId,
    properties: {
      teacherId: input.teacherId,
      bookingId: booking.id,
      hasLevel: Boolean(link?.level?.label),
      coveredCount: coveredTitles.length,
      continuationCount: continueFromMaterials.length,
      focusCount: focusLabels.length,
      hasInterests: Boolean(link?.interests),
      hasGoals: Boolean(link?.goals),
      hasTopic: Boolean(topic),
      usedTemplate: Boolean(templateBody),
    },
  });

  return { ok: true, body: result.body };
}

// Version history (task 5) — most-recent-first, capped list of bodies this
// booking's content has previously held. Null when the booking isn't the
// caller's (same tenant-ownership check as every other handler here).
export async function listClassContentRevisionsForBooking(input: {
  teacherId: string;
  bookingId: string;
}): Promise<MaterialRevisionRow[] | null> {
  const booking = await findOwnedBooking(input.teacherId, input.bookingId);
  if (!booking) return null;
  const material = await findContentMaterial(input.teacherId, booking.id);
  if (!material) return [];
  return listMaterialRevisions({ teacherId: input.teacherId, materialId: material.id });
}

// Restores a prior version by saving it — reuses saveClassContentForBooking
// so the Pro gate, validation, and (crucially) the pre-overwrite snapshot all
// apply exactly the same way a normal save does, keeping the restore itself
// reversible.
export async function restoreClassContentRevisionForBooking(input: {
  teacherId: string;
  bookingId: string;
  revisionId: string;
  locale: AppLocale;
}): Promise<SaveClassContentResult> {
  const en = usesEnglishCopy(input.locale);
  const booking = await findOwnedBooking(input.teacherId, input.bookingId);
  if (!booking) {
    return {
      ok: false,
      code: "not-found",
      message: en ? "Class not found." : "Clase no encontrada.",
    };
  }

  const revision = await prisma.materialRevision.findFirst({
    where: { id: input.revisionId, teacherId: input.teacherId },
    select: { body: true, source: true, material: { select: { bookingId: true } } },
  });
  if (!revision || revision.material.bookingId !== booking.id) {
    return {
      ok: false,
      code: "not-found",
      message: en ? "That version is no longer available." : "Esa versión ya no está disponible.",
    };
  }

  return saveClassContentForBooking({
    teacherId: input.teacherId,
    bookingId: input.bookingId,
    body: revision.body,
    source: (revision.source as ClassContentSource) ?? "manual",
    locale: input.locale,
  });
}

// ---------- standalone library material generation (gap G2) ----------
//
// Sibling of generateClassContentForBooking above: same Pro gate and monthly
// cap (shared with class-content generation — "one AI plumbing, two
// outputs," not a second quota to track), different prompt (no booking, no
// single student). Never writes a LibraryMaterial itself — the caller reviews
// the draft and saves it via saveContentToLibraryAction, same as
// class-content's "generate, then explicitly save" flow.

export type GenerateLibraryMaterialResult =
  | { ok: true; body: string }
  | {
      ok: false;
      code: "not-pro" | "invalid" | "cap" | "not-configured" | "error";
      message: string;
    };

export async function generateLibraryMaterialForTeacher(input: {
  teacherId: string;
  topic: string;
  levelId?: string | null;
  focusTagIds: string[];
  // The teacher's chosen lesson template (D-46) — same structure-following as
  // the booking-scoped generator.
  templateId?: string | null;
  locale: AppLocale;
  // The language the material is written in, if the caller offers the picker.
  // Omitted → the locale default, which is what the mobile generate route
  // (no picker yet) relies on.
  language?: string | null;
}): Promise<GenerateLibraryMaterialResult> {
  const en = usesEnglishCopy(input.locale);

  const gate = await gateProFeature(input.teacherId, "class_content");
  if (!gate.ok)
    return { ok: false, code: "not-pro", message: upgradeNudge(gate.limit, input.locale) };

  const topic = input.topic.trim().slice(0, 500);
  const focusTagIds = input.focusTagIds.filter(Boolean).slice(0, 12);
  const tags = await resolveFocusTagsWithCategory(input.teacherId, focusTagIds);
  // The teacher's chosen "format" tag (if any) drives the deliverable shape;
  // everything else is just additional focus. Only the first format tag is
  // used as the shape — picking two formats at once ("worksheet" + "song")
  // has no coherent single output, so we take the one the picker put first.
  const formatTag = tags.find((t) => t.categoryCode === "format");
  const focusLabels = tags.filter((t) => t.id !== formatTag?.id).map((t) => t.label);

  if (!topic && !formatTag && focusLabels.length === 0) {
    return {
      ok: false,
      code: "invalid",
      message: en
        ? "Describe the material or pick a format/focus first."
        : "Describe el material o elige un formato/enfoque primero.",
    };
  }

  const usedThisMonth = await prisma.classContentGeneration.count({
    where: { teacherId: input.teacherId, createdAt: { gte: monthStartUtc(new Date()) } },
  });
  if (usedThisMonth >= CLASS_CONTENT_AI_MONTHLY_CAP) {
    return {
      ok: false,
      code: "cap",
      message: en
        ? `You've reached this month's AI generation limit (${CLASS_CONTENT_AI_MONTHLY_CAP}). You can still write the material yourself.`
        : `Alcanzaste el límite de generaciones con IA de este mes (${CLASS_CONTENT_AI_MONTHLY_CAP}). Aún puedes escribir el material tú mismo.`,
    };
  }

  const levelLabel = input.levelId
    ? (
        await prisma.level.findFirst({
          where: { id: input.levelId, teacherId: input.teacherId },
          select: { label: true },
        })
      )?.label
    : null;

  // Resolve the teacher's chosen template (tenant-scoped) and bound the slice we
  // inject as the material's structure (D-46), same as the class-content path.
  const templateBody = (
    await resolveClassContentTemplateBody(input.teacherId, input.templateId)
  )?.slice(0, CLASS_CONTENT_TEMPLATE_PROMPT_MAX_CHARS);

  const { generateMaterial } = await import("@/lib/ai/anthropic");
  const result = await generateMaterial({
    topic,
    levelLabel: levelLabel ?? null,
    formatLabel: formatTag?.label ?? null,
    focusLabels,
    templateBody: templateBody ?? null,
    forClass: false,
    locale: input.locale,
    language: input.language ?? null,
    ...(await resolveSubject(input.teacherId)),
  });

  if (!result.ok) {
    if (result.reason === "not-configured") {
      return {
        ok: false,
        code: "not-configured",
        message: en
          ? "AI generation isn't available right now. You can still write the material yourself."
          : "La generación con IA no está disponible ahora. Aún puedes escribir el material tú mismo.",
      };
    }
    return {
      ok: false,
      code: "error",
      message: en
        ? "Couldn't generate the material. Please try again."
        : "No se pudo generar el material. Inténtalo de nuevo.",
    };
  }

  // Shares class_content_generations with class-content compose — one
  // monthly AI cap across both outputs, not two.
  await prisma.classContentGeneration.create({ data: { teacherId: input.teacherId } });

  trackServerEvent({
    name: "library_material_generated",
    distinctId: input.teacherId,
    properties: {
      teacherId: input.teacherId,
      hasLevel: Boolean(levelLabel),
      hasFormat: Boolean(formatTag),
      focusCount: focusLabels.length,
      hasTopic: Boolean(topic),
      usedTemplate: Boolean(templateBody),
    },
  });

  return { ok: true, body: result.body };
}

// --- Streaming generation ---------------------------------------------------
// The live "watch it write" flow can't use generateLibraryMaterialForTeacher
// (which buffers the whole body); it needs the gate/validate/cap/resolve step
// split from the model call so the route can stream deltas in between and
// record the quota only once the stream completes. These two helpers are that
// split — identical rules to the non-streaming path.

export type PreparedLibraryPrompt = {
  hasLevel: boolean;
  hasFormat: boolean;
  focusCount: number;
  hasTopic: boolean;
  usedTemplate: boolean;
};

export type PrepareLibraryPromptResult =
  | { ok: true; promptInput: MaterialPromptInput; meta: PreparedLibraryPrompt }
  | { ok: false; code: "not-pro" | "invalid" | "cap"; message: string };

export async function prepareLibraryMaterialPrompt(input: {
  teacherId: string;
  topic: string;
  levelId?: string | null;
  focusTagIds: string[];
  templateId?: string | null;
  locale: AppLocale;
  language?: string | null;
}): Promise<PrepareLibraryPromptResult> {
  const en = usesEnglishCopy(input.locale);

  const gate = await gateProFeature(input.teacherId, "class_content");
  if (!gate.ok)
    return { ok: false, code: "not-pro", message: upgradeNudge(gate.limit, input.locale) };

  const topic = input.topic.trim().slice(0, 500);
  const focusTagIds = input.focusTagIds.filter(Boolean).slice(0, 12);
  const tags = await resolveFocusTagsWithCategory(input.teacherId, focusTagIds);
  const formatTag = tags.find((t) => t.categoryCode === "format");
  const focusLabels = tags.filter((t) => t.id !== formatTag?.id).map((t) => t.label);

  if (!topic && !formatTag && focusLabels.length === 0) {
    return {
      ok: false,
      code: "invalid",
      message: en
        ? "Describe the material or pick a format/focus first."
        : "Describe el material o elige un formato/enfoque primero.",
    };
  }

  const usedThisMonth = await prisma.classContentGeneration.count({
    where: { teacherId: input.teacherId, createdAt: { gte: monthStartUtc(new Date()) } },
  });
  if (usedThisMonth >= CLASS_CONTENT_AI_MONTHLY_CAP) {
    return {
      ok: false,
      code: "cap",
      message: en
        ? `You've reached this month's AI generation limit (${CLASS_CONTENT_AI_MONTHLY_CAP}). You can still write the material yourself.`
        : `Alcanzaste el límite de generaciones con IA de este mes (${CLASS_CONTENT_AI_MONTHLY_CAP}). Aún puedes escribir el material tú mismo.`,
    };
  }

  const levelLabel = input.levelId
    ? (
        await prisma.level.findFirst({
          where: { id: input.levelId, teacherId: input.teacherId },
          select: { label: true },
        })
      )?.label
    : null;
  const templateBody = (
    await resolveClassContentTemplateBody(input.teacherId, input.templateId)
  )?.slice(0, CLASS_CONTENT_TEMPLATE_PROMPT_MAX_CHARS);

  return {
    ok: true,
    promptInput: {
      topic,
      levelLabel: levelLabel ?? null,
      formatLabel: formatTag?.label ?? null,
      focusLabels,
      templateBody: templateBody ?? null,
      forClass: false,
      locale: input.locale,
      language: input.language ?? null,
      ...(await resolveSubject(input.teacherId)),
    },
    meta: {
      hasLevel: Boolean(levelLabel),
      hasFormat: Boolean(formatTag),
      focusCount: focusLabels.length,
      hasTopic: Boolean(topic),
      usedTemplate: Boolean(templateBody),
    },
  };
}

// Burn one quota row + track the event — called only after a stream completes
// successfully ("failures don't burn quota"). Shares class_content_generations
// with class-content compose, one monthly cap across both outputs.
export async function recordLibraryMaterialGeneration(
  teacherId: string,
  meta: PreparedLibraryPrompt,
): Promise<void> {
  await prisma.classContentGeneration.create({ data: { teacherId } });
  trackServerEvent({
    name: "library_material_generated",
    distinctId: teacherId,
    properties: { teacherId, ...meta },
  });
}

// ---------- "Edit with AI" refine (D-73) ----------
//
// The change-in-place counterpart to the generate paths above: instead of
// composing a fresh material, it applies a teacher's free-text instruction to an
// EXISTING body and returns the revised Markdown. Scope-agnostic — a refine only
// needs the current body + the instruction, so there's no booking/student/level/
// tag context and one handler serves both the library and booking surfaces. Same
// Pro gate + shared monthly cap + one-row-per-success accounting as generate: a
// refine is a Claude call, so it counts. Never writes the material itself — the
// caller sets the returned body into the editor and saves through the normal
// save path (version history snapshots the pre-refine body on that save).

export type RefineMaterialResult =
  | { ok: true; body: string }
  | {
      ok: false;
      code: "not-pro" | "invalid" | "cap" | "not-configured" | "error";
      message: string;
    };

export async function refineMaterialForTeacher(input: {
  teacherId: string;
  currentBody: string;
  instruction: string;
  locale: AppLocale;
  // The language the material is written in, if the caller offers the picker.
  // Omitted → the locale default, same axis as the generate paths.
  language?: string | null;
}): Promise<RefineMaterialResult> {
  const en = usesEnglishCopy(input.locale);

  // Same gate as authoring class content / library content (viewing stays free).
  const gate = await gateProFeature(input.teacherId, "class_content");
  if (!gate.ok)
    return { ok: false, code: "not-pro", message: upgradeNudge(gate.limit, input.locale) };

  const instruction = input.instruction.trim().slice(0, MATERIAL_REFINE_INSTRUCTION_MAX_CHARS);
  if (!instruction) {
    return {
      ok: false,
      code: "invalid",
      message: en
        ? "Describe the change you want the AI to make."
        : "Describe el cambio que quieres que haga la IA.",
    };
  }
  // The body must be present and within the ceiling — a refine edits what's
  // there, it can't invent a document from nothing.
  const bodyValidation = validateClassContentBody(input.currentBody, input.locale);
  if (!bodyValidation.ok) return { ok: false, code: "invalid", message: bodyValidation.error };

  const usedThisMonth = await prisma.classContentGeneration.count({
    where: { teacherId: input.teacherId, createdAt: { gte: monthStartUtc(new Date()) } },
  });
  if (usedThisMonth >= CLASS_CONTENT_AI_MONTHLY_CAP) {
    return {
      ok: false,
      code: "cap",
      message: en
        ? `You've reached this month's AI generation limit (${CLASS_CONTENT_AI_MONTHLY_CAP}). You can still edit the material yourself.`
        : `Alcanzaste el límite de generaciones con IA de este mes (${CLASS_CONTENT_AI_MONTHLY_CAP}). Aún puedes editar el material tú mismo.`,
    };
  }

  const { refineMaterial } = await import("@/lib/ai/anthropic");
  const result = await refineMaterial({
    currentBody: bodyValidation.body,
    instruction,
    locale: input.locale,
    language: input.language ?? null,
    ...(await resolveSubject(input.teacherId)),
  });

  if (!result.ok) {
    if (result.reason === "not-configured") {
      return {
        ok: false,
        code: "not-configured",
        message: en
          ? "AI editing isn't available right now. You can still edit the material yourself."
          : "La edición con IA no está disponible ahora. Aún puedes editar el material tú mismo.",
      };
    }
    return {
      ok: false,
      code: "error",
      message: en
        ? "Couldn't apply the change. Please try again."
        : "No se pudo aplicar el cambio. Inténtalo de nuevo.",
    };
  }

  // One row per success — shares the class-content generation quota with the
  // generate paths ("one AI plumbing," one cap). Failures don't burn quota.
  await prisma.classContentGeneration.create({ data: { teacherId: input.teacherId } });

  trackServerEvent({
    name: "material_refined",
    distinctId: input.teacherId,
    properties: {
      teacherId: input.teacherId,
      instructionChars: instruction.length,
      bodyChars: bodyValidation.body.length,
    },
  });

  return { ok: true, body: result.body };
}

// Checkpoints the body as it stood immediately BEFORE an AI refine is applied
// client-side (material-editor.tsx's per-section splice, or MaterialForm's
// whole-document refine) — not only at the next explicit Save. Without this,
// a refine followed by further manual edits and then one save collapses into
// a single revision describing the whole editing session, and the AI's
// specific change becomes unrecoverable from Version History the moment the
// in-session Undo (bounded, session-local — see editor.ts) is gone.
//
// Deliberately narrower than refineMaterialForTeacher's own gate: by the time
// a caller reaches this, a refine has already succeeded (Pro-gated, quota
// already spent) — this only persists a recovery point for it, so it's just
// an ownership check + a normal snapshot, reusing snapshotMaterialRevision
// exactly as every save-triggered snapshot does. Silently no-ops (never
// throws past ownership) when the material has never been saved yet (nothing
// to attach a revision to — same guard the save paths already apply) or the
// body is empty — this is best-effort recovery infra, not a user-facing
// mutation with its own error surface.
export async function snapshotMaterialRevisionBeforeRefine(input: {
  teacherId: string;
  materialId: string;
  body: string;
  source: ClassContentSource;
}): Promise<void> {
  const body = input.body.replace(/\r\n/g, "\n").trim().slice(0, CLASS_CONTENT_MAX_CHARS);
  if (!body) return;

  const material = await prisma.libraryMaterial.findFirst({
    where: { id: input.materialId, teacherId: input.teacherId, body: { not: null } },
    select: { id: true },
  });
  if (!material) return;

  await snapshotMaterialRevision({
    teacherId: input.teacherId,
    materialId: material.id,
    body,
    source: input.source,
  });
}

// Shared by every library-scoped create path (upload, save-content,
// generate-and-save) so a new item always lands at the end of its level's
// ordering, regardless of which flow created it.
export async function nextPositionInLevel(teacherId: string, levelId: string): Promise<number> {
  const last = await prisma.libraryMaterial.findFirst({
    where: { teacherId, levelId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return (last?.position ?? -1) + 1;
}

// ---------- library-scoped content material: create or edit-in-place ----------
//
// The library's "write" content-type in the unified material form (one form,
// three content types, docs/features/library-materials.md follow-up). Unlike
// a file/link item — delete-and-re-add, unchanged — a content material's body
// can now be edited in place, same as the booking-scoped one, sharing the
// same version-history log (materialId is already generic, D-69).

export type SaveLibraryContentResult =
  | { ok: true; materialId: string }
  | { ok: false; code: "not-pro" | "invalid" | "not-found"; message: string };

export async function saveLibraryContentMaterial(input: {
  teacherId: string;
  // Set = edit that material's body in place; absent = create a new one.
  materialId?: string | null;
  levelId: string;
  visibility: LibraryVisibility;
  label?: string | null;
  body: string;
  source: ClassContentSource;
  // Unified material: a content item may also carry a file/link on the same
  // row. `undefined` = leave unchanged, `null` = clear, string = set.
  storagePath?: string | null;
  linkUrl?: string | null;
  locale: AppLocale;
}): Promise<SaveLibraryContentResult> {
  const en = usesEnglishCopy(input.locale);

  const gate = await gateProFeature(input.teacherId, "class_content");
  if (!gate.ok)
    return { ok: false, code: "not-pro", message: upgradeNudge(gate.limit, input.locale) };

  const validation = validateClassContentBody(input.body, input.locale);
  if (!validation.ok) return { ok: false, code: "invalid", message: validation.error };

  const level = await prisma.level.findFirst({
    where: { id: input.levelId, teacherId: input.teacherId, archived: false },
    select: { id: true },
  });
  if (!level)
    return { ok: false, code: "invalid", message: en ? "Choose a level." : "Elige un nivel." };

  const label = input.label?.trim().slice(0, 80) || null;

  if (input.materialId) {
    // A content material only — never lets this path touch a booking-scoped
    // or file/link row (the same "attachment isn't editable" boundary the
    // library edit-form already enforces).
    const existing = await prisma.libraryMaterial.findFirst({
      where: {
        id: input.materialId,
        teacherId: input.teacherId,
        bookingId: null,
        body: { not: null },
      },
      select: { id: true, body: true, contentSource: true },
    });
    if (!existing) {
      return {
        ok: false,
        code: "not-found",
        message: en ? "Material not found." : "Material no encontrado.",
      };
    }
    if (existing.body != null && existing.body !== validation.body) {
      await snapshotMaterialRevision({
        teacherId: input.teacherId,
        materialId: existing.id,
        body: existing.body,
        source: (existing.contentSource as ClassContentSource) ?? "manual",
      });
    }
    const row = await prisma.libraryMaterial.update({
      where: { id: existing.id },
      data: {
        levelId: level.id,
        visibility: input.visibility,
        label,
        body: validation.body,
        contentSource: input.source,
        ...(input.storagePath !== undefined ? { storagePath: input.storagePath } : {}),
        ...(input.linkUrl !== undefined ? { linkUrl: input.linkUrl } : {}),
      },
      select: { id: true },
    });
    return { ok: true, materialId: row.id };
  }

  const row = await prisma.libraryMaterial.create({
    data: {
      teacherId: input.teacherId,
      levelId: level.id,
      visibility: input.visibility,
      label,
      body: validation.body,
      contentSource: input.source,
      storagePath: input.storagePath ?? null,
      linkUrl: input.linkUrl ?? null,
      position: await nextPositionInLevel(input.teacherId, level.id),
    },
    select: { id: true },
  });

  trackServerEvent({
    name: "library_item_added",
    distinctId: input.teacherId,
    properties: {
      teacherId: input.teacherId,
      levelId: level.id,
      visibility: input.visibility,
      attachmentKind: "content",
      source: input.source,
      tagCount: 0,
    },
  });

  return { ok: true, materialId: row.id };
}

// Version history for a library-scoped content material (mirrors
// listClassContentRevisionsForBooking's booking-scoped counterpart). Null
// when the material isn't the caller's own content material.
export async function listLibraryMaterialRevisions(input: {
  teacherId: string;
  materialId: string;
}): Promise<MaterialRevisionRow[] | null> {
  const material = await prisma.libraryMaterial.findFirst({
    where: {
      id: input.materialId,
      teacherId: input.teacherId,
      bookingId: null,
      body: { not: null },
    },
    select: { id: true },
  });
  if (!material) return null;
  return listMaterialRevisions({ teacherId: input.teacherId, materialId: material.id });
}

export async function restoreLibraryMaterialRevision(input: {
  teacherId: string;
  materialId: string;
  revisionId: string;
  locale: AppLocale;
}): Promise<SaveLibraryContentResult> {
  const en = usesEnglishCopy(input.locale);
  const material = await prisma.libraryMaterial.findFirst({
    where: {
      id: input.materialId,
      teacherId: input.teacherId,
      bookingId: null,
      body: { not: null },
    },
    select: { id: true, levelId: true, visibility: true, label: true },
  });
  if (!material || !material.levelId) {
    return {
      ok: false,
      code: "not-found",
      message: en ? "Material not found." : "Material no encontrado.",
    };
  }

  const revision = await prisma.materialRevision.findFirst({
    where: { id: input.revisionId, teacherId: input.teacherId, materialId: material.id },
    select: { body: true, source: true },
  });
  if (!revision) {
    return {
      ok: false,
      code: "not-found",
      message: en ? "That version is no longer available." : "Esa versión ya no está disponible.",
    };
  }

  return saveLibraryContentMaterial({
    teacherId: input.teacherId,
    materialId: material.id,
    levelId: material.levelId,
    visibility: material.visibility,
    label: material.label,
    body: revision.body,
    source: (revision.source as ClassContentSource) ?? "manual",
    locale: input.locale,
  });
}

// ---------- unified file/link attachment save (library + booking) ----------
//
// One save path for both scopes, used by the "File" and "Link" tabs of the
// unified material form. Storage upload itself (resolveMaterialAttachment)
// stays with the caller — a Next.js-specific helper — this just handles
// gating, persistence, and (booking-scoped only) the send-now-if-elapsed
// notification. Booking-scoped materials are Pro-gated (the scheduling
// itself is the paid part); a reusable library upload stays free, unchanged.

export type SaveMaterialAttachmentResult =
  | { ok: true; materialId: string }
  | { ok: false; code: "not-pro" | "invalid" | "not-found"; message: string };

export async function saveMaterialAttachment(input: {
  teacherId: string;
  bookingId?: string | null;
  levelId?: string | null;
  visibility?: LibraryVisibility;
  label?: string | null;
  // Library-scoped only — a free-text grouping (e.g. "Unit 3") distinct from
  // the focus-tag taxonomy. Booking-scoped materials have no unit of their own.
  unit?: string | null;
  storagePath?: string | null;
  linkUrl?: string | null;
  // Booking-scoped only. Null = always visible, no push (D-69) — the teacher
  // explicitly chose not to schedule a notification for this attachment.
  sendTiming?: MaterialSendTiming | null;
  locale: AppLocale;
}): Promise<SaveMaterialAttachmentResult> {
  const en = usesEnglishCopy(input.locale);
  const label = input.label?.trim().slice(0, 80) || null;

  if (input.bookingId) {
    const gate = await gateProFeature(input.teacherId, "materials");
    if (!gate.ok)
      return { ok: false, code: "not-pro", message: upgradeNudge(gate.limit, input.locale) };

    const booking = await prisma.booking.findFirst({
      where: { id: input.bookingId, teacherId: input.teacherId },
      select: { id: true, studentId: true, scheduledStart: true, status: true },
    });
    if (!booking) {
      return {
        ok: false,
        code: "not-found",
        message: en ? "Class not found." : "Clase no encontrada.",
      };
    }

    const sendTiming = input.sendTiming ?? null;
    const created = await prisma.libraryMaterial.create({
      data: {
        teacherId: input.teacherId,
        bookingId: booking.id,
        visibility: "at_or_below",
        storagePath: input.storagePath ?? null,
        linkUrl: input.linkUrl ?? null,
        label,
        sendTiming,
      },
      select: { id: true },
    });

    trackServerEvent({
      name: "materials_attached",
      distinctId: input.teacherId,
      properties: {
        teacherId: input.teacherId,
        bookingId: booking.id,
        sendTiming: sendTiming ?? "always",
        attachmentKind: input.storagePath ? "file" : "link",
      },
    });

    // A null timing is "always visible, no push" — nothing to enqueue, ever.
    if (
      sendTiming &&
      booking.status === "scheduled" &&
      materialSendTimeElapsed(sendTiming, booking.scheduledStart, new Date())
    ) {
      const fallbackUrl = input.linkUrl ?? null;
      if (input.storagePath || fallbackUrl) {
        const id = await enqueueMaterialsSend(prisma, {
          teacherId: input.teacherId,
          studentId: booking.studentId,
          bookingId: booking.id,
          storagePath: input.storagePath ?? null,
          materialsUrl: fallbackUrl,
        });
        try {
          await emitNotificationQueued({ notificationId: id, teacherId: input.teacherId });
        } catch (err) {
          log.warn("emit failed", { error: err });
        }
      }
    }

    return { ok: true, materialId: created.id };
  }

  // Library-scoped: free, level-required, no notification.
  if (!input.levelId) {
    return { ok: false, code: "invalid", message: en ? "Choose a level." : "Elige un nivel." };
  }
  const level = await prisma.level.findFirst({
    where: { id: input.levelId, teacherId: input.teacherId, archived: false },
    select: { id: true },
  });
  if (!level) {
    return { ok: false, code: "invalid", message: en ? "Choose a level." : "Elige un nivel." };
  }

  const created = await prisma.libraryMaterial.create({
    data: {
      teacherId: input.teacherId,
      levelId: level.id,
      visibility: input.visibility ?? "at_or_below",
      storagePath: input.storagePath ?? null,
      linkUrl: input.linkUrl ?? null,
      label,
      unit: input.unit?.trim().slice(0, 80) || null,
      position: await nextPositionInLevel(input.teacherId, level.id),
    },
    select: { id: true },
  });

  trackServerEvent({
    name: "library_item_added",
    distinctId: input.teacherId,
    properties: {
      teacherId: input.teacherId,
      levelId: level.id,
      visibility: input.visibility ?? "at_or_below",
      attachmentKind: input.storagePath ? "file" : "link",
      tagCount: 0,
    },
  });

  return { ok: true, materialId: created.id };
}
