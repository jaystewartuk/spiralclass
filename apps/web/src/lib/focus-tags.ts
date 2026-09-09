import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import type { AppLocale } from "@/lib/i18n";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import { focusTagSeedFor, FOCUS_TAG_BUILTIN_CATEGORIES, FORMAT_TAG_SEEDS } from "@/lib/focus-packs";
import {
  FOCUS_TAG_CATEGORY_LABEL_MAX_CHARS,
  FOCUS_TAG_CATEGORY_MAX_PER_TEACHER,
  FOCUS_TAG_LABEL_MAX_CHARS,
  FOCUS_TAG_MAX_PER_TEACHER,
} from "@/lib/focus-tag-editing";

// Focus tags — the teacher's "what to work on" taxonomy that seeds AI
// class-content compose (docs/features/classes-lesson-content.md, D-20).
//
// Mirrors src/lib/levels.ts: tags are teacher-scoped rows seeded from a pack
// (chosen by the language the teacher teaches), not a fixed enum, so packs stay
// subject-agnostic. This file is the single source of truth for seeding and
// reading them. The stored `code` is pack-prefixed (`${pack}:${key}`) so a
// teacher who teaches two subjects can carry two packs without code collisions.
//
// Categories (below) are a SEPARATE teacher-scoped table, not a fixed enum on
// the tag row — a category is itself renameable/reorderable/deletable, the
// same CRUD a teacher already has over tags. `ensureTeacherFocusCategories`
// seeds the 5 builtins once per teacher; everything downstream (tag seeding,
// the compose picker's grouping) resolves through `FocusTag.categoryId`.

export type FocusTagRow = {
  id: string;
  code: string;
  label: string;
  categoryId: string;
  position: number;
};

export type FocusTagCategoryRow = {
  id: string;
  code: string;
  label: string;
  position: number;
};

type Db = PrismaClient | Prisma.TransactionClient;

const select = {
  id: true,
  code: true,
  label: true,
  categoryId: true,
  position: true,
} as const;

const categorySelect = {
  id: true,
  code: true,
  label: true,
  position: true,
} as const;

// Idempotent: relies on the unique (teacher_id, code) index, so calling it
// again only fills in any builtin the teacher doesn't have yet (including
// right after she's renamed/reordered the others) and never duplicates.
// Positions are fixed 0..4 — a teacher's own reordering (saveFocusCategories)
// is what actually determines the picker order after the first seed.
export async function ensureTeacherFocusCategories(
  teacherId: string,
  locale: AppLocale,
  db: Db = defaultPrisma,
): Promise<void> {
  const en = locale === "en";
  await db.focusTagCategory.createMany({
    data: FOCUS_TAG_BUILTIN_CATEGORIES.map((c, i) => ({
      teacherId,
      code: c.code,
      label: en ? c.labelEn : c.labelEs,
      position: i,
    })),
    skipDuplicates: true,
  });
}

// Returns the teacher's active categories ordered for the picker. Self-heals
// like getTeacherFocusTags: an empty result seeds the 5 builtins and re-reads.
export async function getTeacherFocusCategories(
  teacherId: string,
  locale: AppLocale,
  db: Db = defaultPrisma,
): Promise<FocusTagCategoryRow[]> {
  const where = { teacherId, archived: false } as const;
  let categories = await db.focusTagCategory.findMany({
    where,
    select: categorySelect,
    orderBy: { position: "asc" },
  });
  if (categories.length === 0) {
    await ensureTeacherFocusCategories(teacherId, locale, db);
    categories = await db.focusTagCategory.findMany({
      where,
      select: categorySelect,
      orderBy: { position: "asc" },
    });
  }
  return categories;
}

// Idempotent: relies on the unique (teacher_id, code) index, so calling it
// again — even after the teacher changes the language she teaches — only adds the new pack's
// missing tags and never duplicates. Existing tags (including any the teacher
// archived) are left untouched. Positions are offset so a second pack appends
// after the first rather than colliding on order.
//
// Ensures the teacher's categories exist first and resolves each seed's
// category KEY (e.g. "grammar") to that teacher's own FocusTagCategory.id —
// if the teacher has since archived that builtin category, the seed for that
// one tag is skipped rather than resurrecting a category she deliberately
// removed.
export async function ensureTeacherFocusTags(
  teacherId: string,
  targetLanguage: string | null | undefined,
  locale: AppLocale,
  db: Db = defaultPrisma,
): Promise<void> {
  const { pack, seeds } = focusTagSeedFor(targetLanguage);
  const categories = await getTeacherFocusCategories(teacherId, locale, db);
  const categoryIdByCode = new Map(categories.map((c) => [c.code, c.id]));

  // The format axis (worksheet / reading / song / quiz…) isn't
  // language-specific like grammar or vocabulary, so it's layered onto
  // every teacher's tags regardless of which pack they picked —
  // see FORMAT_TAG_SEEDS in @/lib/focus-packs.
  const allSeeds = [
    ...seeds.map((s) => ({ ...s, pack })),
    ...FORMAT_TAG_SEEDS.map((s) => ({
      key: s.key,
      label: locale === "en" ? s.labelEn : s.labelEs,
      category: "format" as const,
      pack: "format",
    })),
  ];

  // Offset positions past whatever the teacher already has so packs stack
  // cleanly instead of fighting over the same ordinals.
  const max = await db.focusTag.aggregate({
    where: { teacherId },
    _max: { position: true },
  });
  const base = (max._max.position ?? 0) + 1;
  const data = allSeeds.flatMap((s, i) => {
    const categoryId = categoryIdByCode.get(s.category);
    if (!categoryId) return [];
    return [
      { teacherId, code: `${s.pack}:${s.key}`, label: s.label, categoryId, position: base + i },
    ];
  });
  await db.focusTag.createMany({ data, skipDuplicates: true });
}

// Returns the teacher's active focus tags ordered for the picker. Self-heals:
// if the teacher has none yet, it seeds the pack for the language they teach and
// re-reads — so the first time the picker renders, the seed IS the UI (like
// levels). `targetLanguage` is the teacher's current value, used only for that
// first-time seed.
export async function getTeacherFocusTags(
  teacherId: string,
  targetLanguage: string | null | undefined,
  locale: AppLocale,
  db: Db = defaultPrisma,
): Promise<FocusTagRow[]> {
  const where = { teacherId, archived: false } as const;
  let tags = await db.focusTag.findMany({ where, select, orderBy: { position: "asc" } });
  if (tags.length === 0) {
    await ensureTeacherFocusTags(teacherId, targetLanguage, locale, db);
    tags = await db.focusTag.findMany({ where, select, orderBy: { position: "asc" } });
  }
  return tags;
}

// Resolve a set of posted focus-tag ids to their labels, scoped to the teacher
// (never trust posted ids — only the teacher's own, active tags resolve). Used
// by the compose action to turn a selection into prompt text. Order follows the
// teacher's tag ordering, not the posted order, so the prompt reads sensibly.
export async function resolveFocusTagLabels(
  teacherId: string,
  tagIds: string[],
  db: Db = defaultPrisma,
): Promise<string[]> {
  const ids = [...new Set(tagIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = await db.focusTag.findMany({
    where: { teacherId, archived: false, id: { in: ids } },
    select: { label: true, position: true },
    orderBy: { position: "asc" },
  });
  return rows.map((r) => r.label);
}

// Resolve posted focus-tag ids to the teacher's OWN active ids (never trust
// posted ids — same tenant-scoping as resolveFocusTagLabels, but returning
// ids instead of labels). Used to validate a tag selection before writing it
// into a join table (e.g. library_material_focus_tags, gap G1) — a foreign or
// archived id is silently dropped rather than rejecting the whole save.
export async function resolveOwnedFocusTagIds(
  teacherId: string,
  tagIds: string[],
  db: Db = defaultPrisma,
): Promise<string[]> {
  const ids = [...new Set(tagIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = await db.focusTag.findMany({
    where: { teacherId, archived: false, id: { in: ids } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export type FocusTagWithCategory = { id: string; label: string; categoryCode: string };

// Like resolveFocusTagLabels, but also returns each tag's category CODE (not
// its teacher-authored label) — lets a caller distinguish the "format" axis
// from the rest without hardcoding category ids. Used by library-material AI
// generation (gap G2) to steer output shape ("produce a Lectura") separately
// from the general focus list ("about the preterite, cooking").
export async function resolveFocusTagsWithCategory(
  teacherId: string,
  tagIds: string[],
  db: Db = defaultPrisma,
): Promise<FocusTagWithCategory[]> {
  const ids = [...new Set(tagIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = await db.focusTag.findMany({
    where: { teacherId, archived: false, id: { in: ids } },
    select: { id: true, label: true, position: true, category: { select: { code: true } } },
    orderBy: { position: "asc" },
  });
  return rows.map((r) => ({ id: r.id, label: r.label, categoryCode: r.category.code }));
}

export type FocusGroup = {
  categoryId: string;
  categoryLabel: string;
  tags: { id: string; label: string }[];
};

// Groups a teacher's focus tags by category, in the teacher's own category
// order — the single source of truth for the pill picker shown on both
// platforms (web ClassContentPanel, mobile TeacherClassContentPanel). Because
// categories are now real per-teacher rows (not a fixed enum), this is just
// "iterate categories in position order, attach their tags" — no more
// canonical-order-plus-append-unknowns logic.
export async function getTeacherFocusGroups(
  teacherId: string,
  targetLanguage: string | null | undefined,
  locale: AppLocale,
  db: Db = defaultPrisma,
): Promise<FocusGroup[]> {
  const [focusTags, categories] = await Promise.all([
    getTeacherFocusTags(teacherId, targetLanguage, locale, db),
    getTeacherFocusCategories(teacherId, locale, db),
  ]);
  const tagsByCategory = new Map<string, { id: string; label: string }[]>();
  for (const t of focusTags) {
    const arr = tagsByCategory.get(t.categoryId) ?? [];
    arr.push({ id: t.id, label: t.label });
    tagsByCategory.set(t.categoryId, arr);
  }
  return categories
    .map((c) => ({
      categoryId: c.id,
      categoryLabel: c.label,
      tags: tagsByCategory.get(c.id) ?? [],
    }))
    .filter((g) => g.tags.length > 0);
}

// ---- Teacher-editable CRUD (D-20's deferred follow-up + the category redesign) ----
//
// The seed packs above give every teacher a usable picker with zero setup, but
// they were never meant to be the ceiling — a teacher who needs a sixth
// vocabulary domain or an entirely new category shouldn't need a code change.
// This section lets a teacher rename/add/reorder/archive their own tags AND
// categories. It's authoring, so it rides the same gateProFeature("class_content")
// gate as saving/generating class content; reading (getTeacherFocusTags /
// getTeacherFocusCategories above) stays free. Mirrors the replace-set
// convention in app/actions/onboarding.ts (saveTemplatesAction): the settings
// form round-trips the teacher's whole active set, id-less+kept rows are
// created, id+unkept rows are archived, and the array order becomes the new
// position — simpler than a drag handle that writes individual position numbers.

// Declared in lib/focus-tag-editing.ts and re-exported here, not defined
// twice. This module imports prisma, so the settings editor (a client
// component) cannot read a cap from it — and a cap copied into the editor is a
// cap that drifts from the validation below. Every existing importer of
// `@/lib/focus-tags` keeps the names it already used.
export {
  FOCUS_TAG_LABEL_MAX_CHARS,
  FOCUS_TAG_CATEGORY_LABEL_MAX_CHARS,
  FOCUS_TAG_MAX_PER_TEACHER,
  FOCUS_TAG_CATEGORY_MAX_PER_TEACHER,
} from "./focus-tag-editing";

export type FocusTagInputRow = {
  // Empty/omitted = a new tag created by this save.
  id?: string;
  label: string;
  categoryId: string;
  // false = archive (existing row) or discard (new row never persisted).
  keep: boolean;
};

export type FocusTagCategoryInputRow = {
  // Empty/omitted = a new category created by this save.
  id?: string;
  label: string;
  // false = archive (existing row) or discard (new row never persisted).
  // Archiving is rejected if the category still has active tags — see below.
  keep: boolean;
};

// code is teacher-scoped-unique, so a collision only needs to be impossible
// within one teacher's rows — the random suffix makes that true across
// concurrent saves too, without a retry loop.
function slugifyLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "tag";
}

function generateCustomFocusTagCode(label: string): string {
  return `custom:${slugifyLabel(label)}-${randomBytes(3).toString("hex")}`;
}

function generateCustomFocusCategoryCode(label: string): string {
  return `custom:${slugifyLabel(label)}-${randomBytes(3).toString("hex")}`;
}

export type SaveFocusTagsResult =
  { ok: true; tags: FocusTagRow[] } | { ok: false; code: "not-pro" | "invalid"; message: string };

// Replace-set save: the caller submits every row the teacher currently sees
// in settings (existing + any newly added), each flagged `keep` or not. Runs
// as one transaction so a mid-save failure never leaves a partial reorder.
export async function saveFocusTagsForTeacher(
  input: {
    teacherId: string;
    locale: AppLocale;
    rows: FocusTagInputRow[];
  },
  db: Db = defaultPrisma,
): Promise<SaveFocusTagsResult> {
  const en = input.locale === "en";

  // Pass `db` through so this reuses the caller's transaction connection
  // instead of opening a second one on the global client — with a
  // single-connection pool (common serverless config), calling
  // gateProFeature() without `db` while already inside prisma.$transaction
  // self-deadlocks: the transaction holds the pool's only connection while
  // gateProFeature's own query waits forever for a connection to free up.
  const gate = await gateProFeature(input.teacherId, "class_content", db);
  if (!gate.ok)
    return { ok: false, code: "not-pro", message: upgradeNudge(gate.limit, input.locale) };

  if (input.rows.length > FOCUS_TAG_MAX_PER_TEACHER) {
    return {
      ok: false,
      code: "invalid",
      message: en ? "Too many focus tags in one save." : "Demasiados enfoques en un solo guardado.",
    };
  }

  const kept = input.rows.filter((r) => r.keep);
  if (kept.length > 0) {
    // A posted categoryId must resolve to one of THIS teacher's own active
    // categories — never trust the client, and never let a tag point at an
    // archived or another teacher's category.
    const validCategories = await db.focusTagCategory.findMany({
      where: { teacherId: input.teacherId, archived: false },
      select: { id: true },
    });
    const validCategoryIds = new Set(validCategories.map((c) => c.id));

    for (const row of kept) {
      const label = row.label.trim();
      if (!label) {
        return {
          ok: false,
          code: "invalid",
          message: en ? "Every focus tag needs a name." : "Cada enfoque necesita un nombre.",
        };
      }
      if (label.length > FOCUS_TAG_LABEL_MAX_CHARS) {
        return {
          ok: false,
          code: "invalid",
          message: en
            ? "A focus tag name is too long."
            : "Un nombre de enfoque es demasiado largo.",
        };
      }
      if (!row.categoryId || !validCategoryIds.has(row.categoryId)) {
        return {
          ok: false,
          code: "invalid",
          message: en
            ? "Every focus tag needs a valid category."
            : "Cada enfoque necesita una categoría válida.",
        };
      }
    }
  }

  // No inner $transaction here (unlike the web/mobile packages batch save) —
  // this function takes an injectable `db` for unit testing (mirrors every
  // other function in this file), and a Prisma.TransactionClient doesn't expose
  // $transaction itself. Callers that want atomicity pass a tx client in, e.g.
  // `prisma.$transaction((tx) => saveFocusTagsForTeacher(input, tx), {timeout: ...})`.
  //
  // Writes fire concurrently via Promise.all, NOT awaited one at a time — a
  // full seeded pack replace-set can be 30+ rows, and each round trip to the
  // DB pays real network latency; sequential awaits blew the caller's
  // interactive-transaction timeout in production (5000ms default) well
  // before a Spanish-pack-sized save finished. `position` is assigned from
  // each row's index in the submitted order BEFORE dispatching, so it's
  // correct regardless of which write resolves first.
  let position = 0;
  const writes = input.rows.map((row) => {
    const label = row.label.trim();
    if (!row.id) {
      // Id-less + discarded is a row the teacher added then removed in the
      // same form submission — nothing to persist.
      if (!row.keep) return null;
      return db.focusTag.create({
        data: {
          teacherId: input.teacherId,
          code: generateCustomFocusTagCode(label),
          label,
          categoryId: row.categoryId,
          position: position++,
        },
      });
    }
    if (!row.keep) {
      return db.focusTag.updateMany({
        where: { id: row.id, teacherId: input.teacherId },
        data: { archived: true },
      });
    }
    return db.focusTag.updateMany({
      where: { id: row.id, teacherId: input.teacherId },
      data: { label, categoryId: row.categoryId, position: position++, archived: false },
    });
  });
  await Promise.all(writes);

  // A plain read, NOT getTeacherFocusTags — that self-seeds on an empty
  // result, which would silently undo a teacher deliberately archiving her
  // entire list (e.g. to start a custom taxonomy from scratch).
  const tags = await db.focusTag.findMany({
    where: { teacherId: input.teacherId, archived: false },
    select,
    orderBy: { position: "asc" },
  });
  return { ok: true, tags };
}

export type SaveFocusTagCategoriesResult =
  | { ok: true; categories: FocusTagCategoryRow[] }
  | { ok: false; code: "not-pro" | "invalid" | "in-use"; message: string };

// Replace-set save for categories — the CRUD counterpart to saveFocusTagsForTeacher,
// same convention. The one rule tags don't have: archiving (deleting) a
// category the teacher still has active tags filed under is rejected outright
// rather than silently orphaning or cascading — the teacher has to move or
// delete those tags first, so "delete a category" is always visible and
// deliberate. `onDelete: Restrict` on FocusTag.categoryId is the DB-level
// backstop for this same rule.
export async function saveFocusCategoriesForTeacher(
  input: {
    teacherId: string;
    locale: AppLocale;
    rows: FocusTagCategoryInputRow[];
  },
  db: Db = defaultPrisma,
): Promise<SaveFocusTagCategoriesResult> {
  const en = input.locale === "en";

  // Pass `db` through so this reuses the caller's transaction connection
  // instead of opening a second one on the global client — with a
  // single-connection pool (common serverless config), calling
  // gateProFeature() without `db` while already inside prisma.$transaction
  // self-deadlocks: the transaction holds the pool's only connection while
  // gateProFeature's own query waits forever for a connection to free up.
  const gate = await gateProFeature(input.teacherId, "class_content", db);
  if (!gate.ok)
    return { ok: false, code: "not-pro", message: upgradeNudge(gate.limit, input.locale) };

  if (input.rows.length > FOCUS_TAG_CATEGORY_MAX_PER_TEACHER) {
    return {
      ok: false,
      code: "invalid",
      message: en
        ? "Too many categories in one save."
        : "Demasiadas categorías en un solo guardado.",
    };
  }

  const kept = input.rows.filter((r) => r.keep);
  for (const row of kept) {
    const label = row.label.trim();
    if (!label) {
      return {
        ok: false,
        code: "invalid",
        message: en ? "Every category needs a name." : "Cada categoría necesita un nombre.",
      };
    }
    if (label.length > FOCUS_TAG_CATEGORY_LABEL_MAX_CHARS) {
      return {
        ok: false,
        code: "invalid",
        message: en ? "A category name is too long." : "Un nombre de categoría es demasiado largo.",
      };
    }
  }

  const toArchiveIds = input.rows.filter((r) => !r.keep && r.id).map((r) => r.id!);
  if (toArchiveIds.length > 0) {
    const counts = await db.focusTag.groupBy({
      by: ["categoryId"],
      where: { teacherId: input.teacherId, archived: false, categoryId: { in: toArchiveIds } },
      _count: { _all: true },
    });
    if (counts.length > 0) {
      const blocked = await db.focusTagCategory.findMany({
        where: { id: { in: counts.map((c) => c.categoryId) } },
        select: { id: true, label: true },
      });
      const countById = new Map(counts.map((c) => [c.categoryId, c._count._all]));
      const parts = blocked.map((c) => `"${c.label}" (${countById.get(c.id) ?? 0})`);
      return {
        ok: false,
        code: "in-use",
        message: en
          ? `Can't delete ${parts.join(", ")} — still has focus tags. Move or delete them first.`
          : `No se puede eliminar ${parts.join(", ")} — todavía tiene enfoques. Muévelos o elimínalos primero.`,
      };
    }
  }

  // Concurrent, not sequential — see the matching comment in
  // saveFocusTagsForTeacher (same fix for the same production timeout).
  let position = 0;
  const writes = input.rows.map((row) => {
    const label = row.label.trim();
    if (!row.id) {
      if (!row.keep) return null;
      return db.focusTagCategory.create({
        data: {
          teacherId: input.teacherId,
          code: generateCustomFocusCategoryCode(label),
          label,
          position: position++,
        },
      });
    }
    if (!row.keep) {
      return db.focusTagCategory.updateMany({
        where: { id: row.id, teacherId: input.teacherId },
        data: { archived: true },
      });
    }
    return db.focusTagCategory.updateMany({
      where: { id: row.id, teacherId: input.teacherId },
      data: { label, position: position++, archived: false },
    });
  });
  await Promise.all(writes);

  const categories = await db.focusTagCategory.findMany({
    where: { teacherId: input.teacherId, archived: false },
    select: categorySelect,
    orderBy: { position: "asc" },
  });
  return { ok: true, categories };
}
