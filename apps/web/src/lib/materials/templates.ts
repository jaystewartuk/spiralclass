import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AppLocale } from "@/lib/i18n";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import {
  CLASS_CONTENT_TEMPLATE_LABEL_MAX_CHARS,
  CLASS_CONTENT_TEMPLATE_MAX_PER_TEACHER,
  validateClassContentBody,
} from "@/lib/materials/config";
import { usesEnglishCopy } from "@spiralclass/shared";

type Db = PrismaClient | Prisma.TransactionClient;

// Reusable lesson skeletons (task 3) — "start a new material from a template"
// instead of retyping the same structure every time. Teacher-scoped, so the web
// server actions and the mobile JSON API share this exact logic (web/mobile
// parity). Independent of the ClassContent/ClassMaterial merge (D-69) — a
// template is a Markdown skeleton, not a material itself.

export type ClassContentTemplateRow = { id: string; label: string; body: string };

// Reading the list is free — it's just the teacher's own saved skeletons, no
// different from re-opening a past class's content.
export async function listClassContentTemplates(
  teacherId: string,
): Promise<ClassContentTemplateRow[]> {
  return prisma.classContentTemplate.findMany({
    where: { teacherId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, label: true, body: true },
  });
}

// Resolve a chosen template's body for AI compose (D-46), tenant-scoped: only
// the teacher's OWN template resolves, so a posted id from another teacher (or a
// stale/deleted one) yields null and the generator falls back to its default
// shape — never an error, never another teacher's structure. Mirrors the
// never-trust-a-posted-id posture of resolveFocusTagLabels.
export async function resolveClassContentTemplateBody(
  teacherId: string,
  templateId: string | null | undefined,
): Promise<string | null> {
  if (!templateId) return null;
  const row = await prisma.classContentTemplate.findFirst({
    where: { id: templateId, teacherId },
    select: { body: true },
  });
  const body = row?.body?.trim();
  return body ? body : null;
}

export type SaveClassContentTemplateResult =
  | { ok: true; template: ClassContentTemplateRow }
  | { ok: false; code: "not-pro" | "invalid"; message: string };

// Saving a template is authoring, gated the same as save/generate (D-17).
export async function saveClassContentTemplate(input: {
  teacherId: string;
  label: string;
  body: string;
  locale: AppLocale;
}): Promise<SaveClassContentTemplateResult> {
  const en = usesEnglishCopy(input.locale);

  const gate = await gateProFeature(input.teacherId, "class_content");
  if (!gate.ok)
    return { ok: false, code: "not-pro", message: upgradeNudge(gate.limit, input.locale) };

  const validation = validateClassContentBody(input.body, input.locale);
  if (!validation.ok) return { ok: false, code: "invalid", message: validation.error };

  const label = input.label.trim().slice(0, CLASS_CONTENT_TEMPLATE_LABEL_MAX_CHARS);
  if (!label) {
    return {
      ok: false,
      code: "invalid",
      message: en ? "Name this template." : "Ponle un nombre a esta plantilla.",
    };
  }

  const last = await prisma.classContentTemplate.findFirst({
    where: { teacherId: input.teacherId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const row = await prisma.classContentTemplate.create({
    data: {
      teacherId: input.teacherId,
      label,
      body: validation.body,
      position: (last?.position ?? -1) + 1,
    },
    select: { id: true, label: true, body: true },
  });

  return { ok: true, template: row };
}

export async function deleteClassContentTemplate(input: {
  teacherId: string;
  templateId: string;
}): Promise<{ ok: true }> {
  // deleteMany (not delete) so an id that isn't this teacher's (or already
  // gone) is a no-op, never a throw.
  await prisma.classContentTemplate.deleteMany({
    where: { id: input.templateId, teacherId: input.teacherId },
  });
  return { ok: true };
}

// ---- Full CRUD manager ----------------------------------------------------
//
// The inline "save as template" on the materials panel only ever *creates*. A
// teacher building a method of her own needs to author a
// skeleton from scratch, edit its body as she refines it, reorder, and delete —
// so this is the standalone manager, mirroring the teacher-editable focus-tags
// follow-up (saveFocusTagsForTeacher). Same replace-set convention: the settings
// form round-trips the teacher's whole list, each row flagged keep/not; array
// order becomes the new `position`. Unlike focus tags there's no `archived`
// column, so a removed row is HARD-deleted (its body is the teacher's own text,
// nothing student-facing to grandfather). Authoring, so Pro-gated like every
// other material mutation (D-17); listing/reading stays free.

export type ClassContentTemplateInputRow = {
  // Empty/omitted = a new template created by this save.
  id?: string;
  label: string;
  body: string;
  // false = delete (existing row) or discard (a new row added then removed).
  keep: boolean;
};

export type SaveClassContentTemplatesResult =
  | { ok: true; templates: ClassContentTemplateRow[] }
  | { ok: false; code: "not-pro" | "invalid"; message: string };

// Replace-set save: the caller submits every row the teacher currently sees
// (existing + newly added), each flagged `keep`. Takes an injectable `db` so
// the web action can wrap it in a $transaction and unit tests can mock it —
// mirrors saveFocusTagsForTeacher. Validates all kept rows BEFORE any write, so
// an invalid submission never lands a partial reorder.
export async function saveClassContentTemplatesForTeacher(
  input: {
    teacherId: string;
    locale: AppLocale;
    rows: ClassContentTemplateInputRow[];
  },
  db: Db = prisma,
): Promise<SaveClassContentTemplatesResult> {
  const en = usesEnglishCopy(input.locale);

  // Pass `db` through so this reuses the caller's transaction connection
  // instead of opening a second one on the global client — with a
  // single-connection pool (common serverless config), calling
  // gateProFeature() without `db` while already inside prisma.$transaction
  // self-deadlocks: the transaction holds the pool's only connection while
  // gateProFeature's own query waits forever for a connection to free up
  // (see the same fix on saveFocusTagsForTeacher).
  const gate = await gateProFeature(input.teacherId, "class_content", db);
  if (!gate.ok)
    return { ok: false, code: "not-pro", message: upgradeNudge(gate.limit, input.locale) };

  if (input.rows.length > CLASS_CONTENT_TEMPLATE_MAX_PER_TEACHER) {
    return {
      ok: false,
      code: "invalid",
      message: en
        ? "Too many templates in one save."
        : "Demasiadas plantillas en un solo guardado.",
    };
  }

  // Validate every kept row up front (label + body) — normalize the body via the
  // same ceiling/empty gate the per-booking save uses.
  const kept = input.rows.filter((r) => r.keep);
  const normalized = new Map<ClassContentTemplateInputRow, { label: string; body: string }>();
  for (const row of kept) {
    const label = row.label.trim().slice(0, CLASS_CONTENT_TEMPLATE_LABEL_MAX_CHARS);
    if (!label) {
      return {
        ok: false,
        code: "invalid",
        message: en ? "Every template needs a name." : "Cada plantilla necesita un nombre.",
      };
    }
    const validation = validateClassContentBody(row.body, input.locale);
    if (!validation.ok) return { ok: false, code: "invalid", message: validation.error };
    normalized.set(row, { label, body: validation.body });
  }

  // Concurrent, not sequential — a teacher with many templates awaiting each
  // write one at a time can blow past the wrapping transaction's timeout
  // (see the same fix on saveFocusTagsForTeacher). `position` is assigned
  // from each row's index before dispatch, so it stays correct regardless of
  // which write resolves first.
  let position = 0;
  const writes = input.rows.map((row) => {
    if (!row.id) {
      // Id-less + discarded = added then removed in the same session; nothing to
      // persist.
      if (!row.keep) return null;
      const n = normalized.get(row)!;
      return db.classContentTemplate.create({
        data: {
          teacherId: input.teacherId,
          label: n.label,
          body: n.body,
          position: position++,
        },
      });
    }
    if (!row.keep) {
      // Hard delete — tenant-scoped so a foreign id is a no-op, never a throw.
      return db.classContentTemplate.deleteMany({
        where: { id: row.id, teacherId: input.teacherId },
      });
    }
    const n = normalized.get(row)!;
    return db.classContentTemplate.updateMany({
      where: { id: row.id, teacherId: input.teacherId },
      data: { label: n.label, body: n.body, position: position++ },
    });
  });
  await Promise.all(writes);

  const templates = await db.classContentTemplate.findMany({
    where: { teacherId: input.teacherId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, label: true, body: true },
  });
  return { ok: true, templates };
}
