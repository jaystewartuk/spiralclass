"use server";

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import {
  materialLinkSchema,
  removeMaterialObject,
  resolveMaterialAttachment,
} from "@/lib/storage/materials-upload";
import { notifyLibraryMaterialAssigned } from "@/lib/notifications/materials";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import { validateClassContentBody } from "@/lib/materials/config";
import {
  generateClassContentForBooking,
  generateLibraryMaterialForTeacher,
  getClassContentForBooking,
  listClassContentRevisionsForBooking,
  listLibraryMaterialRevisions,
  nextPositionInLevel,
  refineMaterialForTeacher,
  restoreClassContentRevisionForBooking,
  restoreLibraryMaterialRevision,
  saveClassContentForBooking,
  saveLibraryContentMaterial,
  saveMaterialAttachment,
  snapshotMaterialRevisionBeforeRefine,
  type ClassContentSource,
  type MaterialRevisionRow,
} from "@/lib/materials/handlers";
import { removeUnreferencedMaterialImages } from "@/lib/materials/image-cleanup";
import { syncLibraryMaterialFocusTags } from "@/lib/materials/tags";
import { revalidateAfterAction } from "@/lib/revalidate";

// The material library (docs/features/library-materials.md;
// merged with per-class materials at D-69, docs/features/library-materials.md).
//
// One table, two scopes, discriminated by `bookingId`:
//   * reusable library items (bookingId null) — level-gated, browsable, files
//     live in the private `class-materials` bucket under a distinct
//     `${teacherId}/library/...` prefix so the 60-day per-class purge never
//     sees them.
//   * booking-scoped materials (bookingId set) — private to one class; a
//     file/link sent on a schedule (`sendTiming` set, the old ClassMaterial)
//     or the class's AI/typed content (`sendTiming` null, the old
//     ClassContent — authored via app/actions/class-content.ts instead, since
//     that flow has its own Pro gate, versioning, and AI compose).
// Every read/write scopes on teacher_id (tenant isolation).

export type LibraryState = { error?: string; ok?: string } | undefined;
// Booking-scoped file/link attach state — `ok` is a boolean flag here (no
// success message payload), matching the retired app/actions/materials.ts.
export type MaterialsState = { error?: string; ok?: boolean } | undefined;

const visibilitySchema = z.enum(["at_or_below", "exact", "all"]);

// ---------- tagging (gap G1) ----------
//
// Reuses the teacher's existing focus-tag taxonomy (category / format /
// theme) — see docs/features/library-materials.md. Posted ids are always
// re-validated against the teacher's own active tags before writing, never
// trusted as-is.

function readFocusTagIds(formData: FormData): string[] {
  return formData.getAll("focusTagId").map((v) => String(v));
}

// ---------- unified material form (docs/features/library-materials.md) ----------
//
// One form, three content types, both scopes: a reusable library item
// (bookingId absent) or a booking-private material (bookingId set). "Write"
// saves a body (create or edit-in-place); "File"/"Link" are attachments
// (always create — replacing one is delete-and-re-add, unchanged). Both
// content-type actions dispatch on bookingId presence to the right
// lib/materials/handlers.ts function, so the Pro gate, tenant-scoping, and
// (for booking-scoped file/link) the send-timing/notify pipeline are exactly
// what the scope already required before this form existed.

const optionalSendTimingSchema = z
  .string()
  .transform((v) => (v ? v : null))
  .pipe(z.enum(["confirmation", "t_5d", "t_24h", "t_1h"]).nullable());

export async function saveMaterialAttachmentAction(
  _prev: MaterialsState,
  formData: FormData,
): Promise<MaterialsState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  const bookingId = String(formData.get("bookingId") ?? "") || null;
  const levelId = String(formData.get("levelId") ?? "") || null;
  const visibility = visibilitySchema.safeParse(formData.get("visibility") ?? "at_or_below");
  const labelInput = String(formData.get("label") ?? "")
    .slice(0, 80)
    .trim();
  const unitInput = String(formData.get("unit") ?? "")
    .slice(0, 80)
    .trim();
  const linkUrlRaw = String(formData.get("linkUrl") ?? "").trim();
  const file = formData.get("file");
  const sendTiming = optionalSendTimingSchema.safeParse(formData.get("sendTiming") ?? "");
  if (!sendTiming.success) {
    return {
      error: en ? "Choose when to send the material." : "Selecciona cuándo enviar el material.",
    };
  }
  if (!visibility.success) {
    return { error: en ? "Invalid visibility." : "Visibilidad inválida." };
  }

  //: tenant-scope every booking lookup before touching storage.
  let booking: { id: string } | null = null;
  if (bookingId) {
    booking = await prisma.booking.findFirst({
      where: { id: bookingId, teacherId: teacher.id },
      select: { id: true },
    });
    if (!booking) return { error: en ? "Class not found." : "Clase no encontrada." };
  }

  const attachment = await resolveMaterialAttachment({
    file,
    linkUrl: linkUrlRaw,
    pathPrefix: booking ? `${teacher.id}/${booking.id}` : `${teacher.id}/library`,
    en,
  });
  if ("error" in attachment) return { error: attachment.error };

  // Auto-derive label from filename when the teacher leaves the title blank.
  const autoLabel =
    !labelInput && file instanceof File && file.name
      ? file.name
          .replace(/\.[^.]+$/, "")
          .replace(/[-_]/g, " ")
          .trim()
          .slice(0, 80)
      : null;

  const result = await saveMaterialAttachment({
    teacherId: teacher.id,
    bookingId: booking?.id ?? null,
    levelId,
    visibility: visibility.data,
    label: labelInput || autoLabel,
    unit: unitInput || null,
    storagePath: attachment.ok.kind === "file" ? attachment.ok.storagePath : null,
    linkUrl: attachment.ok.kind === "link" ? attachment.ok.linkUrl : null,
    sendTiming: sendTiming.data,
    locale,
  });
  if (!result.ok) return { error: result.message };

  if (!booking) {
    const focusTagIds = readFocusTagIds(formData);
    if (focusTagIds.length > 0) {
      await syncLibraryMaterialFocusTags(teacher.id, result.materialId, focusTagIds);
    }
  }
  await flushAnalytics();

  // One call site, one revalidation: see @/lib/revalidate for why an action
  // must never revalidate twice.
  revalidateAfterAction(booking ? `/dashboard/classes/${booking.id}` : "/dashboard/materials");
  return { ok: true, error: undefined };
}

export type SaveMaterialContentState =
  { error?: string; ok?: boolean; materialId?: string } | undefined;

// The unified material save (the three-way "Write / File / Link" gate is gone:
// one form, all fields present). A single material row can now carry a body AND
// a file AND a link at once. When a body is present it saves through the content
// path (Pro-gated authoring, version history) with the file/link riding on the
// same row; with no body it falls back to the plain file/link attachment path.
export async function saveMaterialContentAction(
  _prev: SaveMaterialContentState,
  formData: FormData,
): Promise<SaveMaterialContentState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  const bookingId = String(formData.get("bookingId") ?? "") || null;
  const materialId = String(formData.get("materialId") ?? "") || null;
  const levelId = String(formData.get("levelId") ?? "");
  const visibility = visibilitySchema.catch("at_or_below").parse(formData.get("visibility"));
  const label =
    String(formData.get("label") ?? "")
      .slice(0, 80)
      .trim() || null;
  const source: ClassContentSource =
    String(formData.get("source") ?? "") === "ai" ? "ai" : "manual";
  const body = String(formData.get("body") ?? "");
  const hasBody = body.trim().length > 0;

  // Tenant-scope the booking before it names a storage path prefix.
  if (bookingId) {
    const owned = await prisma.booking.findFirst({
      where: { id: bookingId, teacherId: teacher.id },
      select: { id: true },
    });
    if (!owned) return { error: en ? "Class not found." : "Clase no encontrada." };
  }

  // Resolve the file and link pieces independently — either, both, or neither
  // may be present. `undefined` = the field wasn't in this submit (leave any
  // existing value); `null` = present-but-empty (clear it); a string = set it.
  const file = formData.get("file");
  let storagePath: string | null | undefined = undefined;
  if (file instanceof File && file.size > 0) {
    const uploaded = await resolveMaterialAttachment({
      file,
      linkUrl: "",
      pathPrefix: bookingId ? `${teacher.id}/${bookingId}` : `${teacher.id}/library`,
      en,
    });
    if ("error" in uploaded) return { error: uploaded.error };
    storagePath = uploaded.ok.kind === "file" ? uploaded.ok.storagePath : undefined;
  }

  let linkUrl: string | null | undefined = undefined;
  if (formData.has("linkUrl")) {
    const raw = String(formData.get("linkUrl") ?? "").trim();
    if (!raw) {
      linkUrl = null;
    } else {
      const parsed = materialLinkSchema.safeParse(raw);
      if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? (en ? "Invalid URL" : "URL inválida") };
      }
      linkUrl = parsed.data;
    }
  }

  // Auto-derive a label from the filename when the teacher left it blank.
  const resolvedLabel =
    label ??
    (storagePath && file instanceof File && file.name
      ? file.name
          .replace(/\.[^.]+$/, "")
          .replace(/[-_]/g, " ")
          .trim()
          .slice(0, 80) || null
      : null);

  if (hasBody) {
    const result = bookingId
      ? await saveClassContentForBooking({
          teacherId: teacher.id,
          bookingId,
          body,
          source,
          storagePath,
          linkUrl,
          locale,
        })
      : await saveLibraryContentMaterial({
          teacherId: teacher.id,
          materialId,
          levelId,
          visibility,
          label: resolvedLabel,
          body,
          source,
          storagePath,
          linkUrl,
          locale,
        });
    await flushAnalytics();
    if (!result.ok) return { error: result.message };

    if (!bookingId) {
      const focusTagIds = readFocusTagIds(formData);
      if (formData.has("focusTagIdsPresent") || focusTagIds.length > 0) {
        await syncLibraryMaterialFocusTags(teacher.id, result.materialId, focusTagIds);
      }
    }
    revalidateAfterAction(bookingId ? `/dashboard/classes/${bookingId}` : "/dashboard/materials");
    return { ok: true, materialId: result.materialId };
  }

  // No body → a plain file/link attachment. Require at least one piece.
  if (!storagePath && !linkUrl) {
    return {
      error: en ? "Add content, a file, or a link." : "Agrega contenido, un archivo o un enlace.",
    };
  }
  const sendTiming = optionalSendTimingSchema.safeParse(formData.get("sendTiming") ?? "");
  if (!sendTiming.success) {
    return {
      error: en ? "Choose when to send the material." : "Selecciona cuándo enviar el material.",
    };
  }
  const unit =
    String(formData.get("unit") ?? "")
      .slice(0, 80)
      .trim() || null;
  const result = await saveMaterialAttachment({
    teacherId: teacher.id,
    bookingId,
    levelId: bookingId ? null : levelId,
    visibility,
    label: resolvedLabel,
    unit: bookingId ? null : unit,
    storagePath: storagePath ?? null,
    linkUrl: linkUrl ?? null,
    sendTiming: sendTiming.data,
    locale,
  });
  await flushAnalytics();
  if (!result.ok) return { error: result.message };

  if (!bookingId) {
    const focusTagIds = readFocusTagIds(formData);
    if (formData.has("focusTagIdsPresent") || focusTagIds.length > 0) {
      await syncLibraryMaterialFocusTags(teacher.id, result.materialId, focusTagIds);
    }
  }
  revalidateAfterAction(bookingId ? `/dashboard/classes/${bookingId}` : "/dashboard/materials");
  return { ok: true, materialId: result.materialId };
}

// ---------- AI compose (gap G2 + D-17), unified across both scopes ----------

export type GenerateMaterialState = { error?: string; body?: string } | undefined;

export async function generateMaterialDraftAction(
  _prev: GenerateMaterialState,
  formData: FormData,
): Promise<GenerateMaterialState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();

  const bookingId = String(formData.get("bookingId") ?? "") || null;
  const topic = String(formData.get("topic") ?? "");
  const focusTagIds = readFocusTagIds(formData);
  const templateId = String(formData.get("templateId") ?? "") || null;
  // The language the material is written in — the same axis the streaming
  // library route already carries. Blank → the locale default.
  const language = String(formData.get("language") ?? "") || null;
  // Lesson continuity (opt-in): previous-class materials picked as "continue
  // from" context. Booking-scoped only — the library-generation branch below
  // never reads this.
  const continueFromMaterialIds = formData.getAll("continueFromMaterialId").map((v) => String(v));

  const result = bookingId
    ? await generateClassContentForBooking({
        teacherId: teacher.id,
        bookingId,
        topic,
        focusTagIds,
        templateId,
        locale,
        language,
        continueFromMaterialIds,
      })
    : await generateLibraryMaterialForTeacher({
        teacherId: teacher.id,
        topic,
        levelId: String(formData.get("levelId") ?? "") || null,
        focusTagIds,
        templateId,
        locale,
        language,
      });
  await flushAnalytics();
  if (!result.ok) return { error: result.message };
  return { body: result.body };
}

// ---------- "Edit with AI" refine (D-73), unified across both scopes ----------

export type RefineMaterialState = { error?: string; body?: string } | undefined;

// Apply a teacher's free-text change to the current draft body and return the
// revised Markdown. Scope-agnostic — a refine only needs the body + the
// instruction — so one action serves the library and booking surfaces alike,
// mirroring generateMaterialDraftAction. Never saves; the client sets the
// returned body into the editor and saves through the normal path.
export async function refineMaterialDraftAction(
  _prev: RefineMaterialState,
  formData: FormData,
): Promise<RefineMaterialState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();

  const currentBody = String(formData.get("body") ?? "");
  const instruction = String(formData.get("instruction") ?? "");
  const language = String(formData.get("language") ?? "") || null;

  const result = await refineMaterialForTeacher({
    teacherId: teacher.id,
    currentBody,
    instruction,
    locale,
    language,
  });
  await flushAnalytics();
  if (!result.ok) return { error: result.message };
  return { body: result.body };
}

// Fire-and-forget checkpoint, dispatched by the client (material-form.tsx)
// the instant a refine result applies — a Version History entry for "what
// was here before the AI changed it" that survives further edits in the same
// session, not just whatever the next explicit Save happens to overwrite.
// Best-effort and silent BY DESIGN: called with the client's already-known
// pre-refine body directly (not FormData/useActionState — there's no pending
// UI state or error to show), and any failure here must never surface to the
// teacher over what is, from her side, an already-applied AI edit. A missed
// checkpoint only makes Version History one entry coarser; the in-session
// Undo (material-editor.tsx) still covers this specific change either way.
export async function snapshotRefineCheckpointAction(input: {
  materialId: string;
  body: string;
  source: ClassContentSource;
}): Promise<void> {
  try {
    const teacher = await requireOnboardedTeacher();
    await snapshotMaterialRevisionBeforeRefine({
      teacherId: teacher.id,
      materialId: input.materialId,
      body: input.body,
      source: input.source,
    });
  } catch {
    // best-effort — see header comment.
  }
}

// ---------- podcast generation (async, single-narrator TTS) ----------

export type MaterialPodcastState = { error?: string; ok?: boolean; status?: "pending" } | undefined;

// Enqueue podcast generation for a saved material. The audio is produced by the
// Inngest job; this returns as soon as the request is accepted and the row is
// marked pending. The UI then polls getMaterialPodcastStatusAction below.
export async function generateMaterialPodcastAction(
  _prev: MaterialPodcastState,
  formData: FormData,
): Promise<MaterialPodcastState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const materialId = String(formData.get("materialId") ?? "");
  const language = String(formData.get("language") ?? "") || null;

  const { requestMaterialPodcast } = await import("@/lib/materials/podcast");
  const result = await requestMaterialPodcast({
    teacherId: teacher.id,
    materialId,
    language,
    locale,
  });
  await flushAnalytics();
  if (!result.ok) {
    // already-pending isn't an error to the user — the poll will show progress.
    if (result.code === "already-pending") return { status: "pending" };
    return { error: result.message };
  }
  const material = await prisma.libraryMaterial.findFirst({
    where: { id: materialId, teacherId: teacher.id },
    select: { bookingId: true },
  });
  revalidateAfterAction(
    material?.bookingId ? `/dashboard/classes/${material.bookingId}` : "/dashboard/materials",
  );
  return { ok: true, status: "pending" };
}

export type MaterialPodcastStatus = {
  status: "none" | "pending" | "ready" | "failed";
  url: string | null;
  durationSec: number | null;
  error: string | null;
};

// Poll a material's podcast state (tenant-scoped). Returns a signed playback URL
// only when ready; "none" when no podcast has ever been requested.
export async function getMaterialPodcastStatusAction(
  materialId: string,
): Promise<MaterialPodcastStatus> {
  const teacher = await requireOnboardedTeacher();
  const { getMaterialPodcast } = await import("@/lib/materials/podcast");
  const view = await getMaterialPodcast({ teacherId: teacher.id, materialId });
  if (!view) return { status: "none", url: null, durationSec: null, error: null };
  return { status: view.status, url: view.url, durationSec: view.durationSec, error: view.error };
}

// ---------- version history (task 5), unified across both scopes ----------

export async function listMaterialRevisionsFor(input: {
  teacherId: string;
  bookingId?: string | null;
  materialId?: string | null;
}): Promise<MaterialRevisionRow[]> {
  if (input.bookingId) {
    return (
      (await listClassContentRevisionsForBooking({
        teacherId: input.teacherId,
        bookingId: input.bookingId,
      })) ?? []
    );
  }
  if (!input.materialId) return [];
  return (
    (await listLibraryMaterialRevisions({
      teacherId: input.teacherId,
      materialId: input.materialId,
    })) ?? []
  );
}

export type RestoreMaterialRevisionState =
  { error?: string; ok?: boolean; body?: string; source?: ClassContentSource } | undefined;

export async function restoreMaterialRevisionAction(
  _prev: RestoreMaterialRevisionState,
  formData: FormData,
): Promise<RestoreMaterialRevisionState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const bookingId = String(formData.get("bookingId") ?? "") || null;
  const materialId = String(formData.get("materialId") ?? "");
  const revisionId = String(formData.get("revisionId") ?? "");

  const result = bookingId
    ? await restoreClassContentRevisionForBooking({
        teacherId: teacher.id,
        bookingId,
        revisionId,
        locale,
      })
    : await restoreLibraryMaterialRevision({
        teacherId: teacher.id,
        materialId,
        revisionId,
        locale,
      });
  await flushAnalytics();
  if (!result.ok) return { error: result.message };

  if (bookingId) {
    revalidateAfterAction(`/dashboard/classes/${bookingId}`);
    const restored = await getClassContentForBooking({ teacherId: teacher.id, bookingId });
    return { ok: true, body: restored?.body, source: restored?.source };
  }
  revalidateAfterAction("/dashboard/materials");
  const restored = await prisma.libraryMaterial.findFirst({
    where: { id: result.materialId, teacherId: teacher.id },
    select: { body: true, contentSource: true },
  });
  return {
    ok: true,
    body: restored?.body ?? undefined,
    source: (restored?.contentSource as ClassContentSource | undefined) ?? undefined,
  };
}

// ---------- save native content to the library (D-20, Layer 4) ----------

// Saves authored/AI-drafted class content into the library as a reusable native
// item at a level — the "author once, assign to many" path. Distinct from
// saveMaterialContentAction: this always CREATES a fresh library copy of a
// booking's content, never edits it in place.
export async function saveContentToLibraryAction(
  _prev: LibraryState,
  formData: FormData,
): Promise<LibraryState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  const gate = await gateProFeature(teacher.id, "class_content");
  if (!gate.ok) return { error: upgradeNudge(gate.limit, locale) };

  const levelId = String(formData.get("levelId") ?? "");
  const visibility = visibilitySchema.safeParse(formData.get("visibility") ?? "at_or_below");
  const source = String(formData.get("source") ?? "") === "ai" ? "ai" : "manual";
  const label =
    String(formData.get("label") ?? "")
      .slice(0, 80)
      .trim() || null;
  const validation = validateClassContentBody(String(formData.get("body") ?? ""), locale);
  if (!validation.ok) return { error: validation.error };
  if (!visibility.success) {
    return { error: en ? "Invalid visibility." : "Visibilidad inválida." };
  }

  const level = await prisma.level.findFirst({
    where: { id: levelId, teacherId: teacher.id, archived: false },
    select: { id: true },
  });
  if (!level) return { error: en ? "Choose a level." : "Elige un nivel." };

  const created = await prisma.libraryMaterial.create({
    data: {
      teacherId: teacher.id,
      levelId: level.id,
      visibility: visibility.data,
      label,
      body: validation.body,
      contentSource: source,
      position: await nextPositionInLevel(teacher.id, level.id),
    },
    select: { id: true },
  });
  const focusTagIds = readFocusTagIds(formData);
  if (focusTagIds.length > 0) {
    await syncLibraryMaterialFocusTags(teacher.id, created.id, focusTagIds);
  }

  trackServerEvent({
    name: "library_item_added",
    distinctId: teacher.id,
    properties: {
      teacherId: teacher.id,
      levelId: level.id,
      visibility: visibility.data,
      attachmentKind: "content",
      source,
      tagCount: focusTagIds.length,
    },
  });
  await flushAnalytics();

  revalidateAfterAction("/dashboard/materials");
  return {
    ok: en ? "Saved to your library." : "Guardado en tu biblioteca.",
  };
}

// ---------- edit details ----------

// Edits the text details of an existing item: name, unit, visibility, and
// level. The attachment (file/link) is intentionally not editable here —
// replacing it means new storage, so that stays a delete-and-re-add. Moving an
// item to a different level appends it to the end of the destination level so
// it never collides with an existing position there.
export async function updateLibraryMaterialAction(
  _prev: LibraryState,
  formData: FormData,
): Promise<LibraryState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  const id = String(formData.get("materialId") ?? "");
  const levelId = String(formData.get("levelId") ?? "");
  const visibility = visibilitySchema.safeParse(formData.get("visibility") ?? "at_or_below");
  const label =
    String(formData.get("label") ?? "")
      .slice(0, 80)
      .trim() || null;
  const unit =
    String(formData.get("unit") ?? "")
      .slice(0, 80)
      .trim() || null;

  if (!visibility.success) {
    return { error: en ? "Invalid visibility." : "Visibilidad inválida." };
  }

  // The item must be this teacher's.
  const material = await prisma.libraryMaterial.findFirst({
    where: { id, teacherId: teacher.id },
    select: { id: true, levelId: true },
  });
  if (!material) {
    return { error: en ? "Material not found." : "Material no encontrado." };
  }

  // The (possibly new) level must belong to this teacher and be active.
  const level = await prisma.level.findFirst({
    where: { id: levelId, teacherId: teacher.id, archived: false },
    select: { id: true },
  });
  if (!level) {
    return { error: en ? "Choose a level." : "Elige un nivel." };
  }

  const levelChanged = level.id !== material.levelId;

  await prisma.libraryMaterial.update({
    where: { id: material.id },
    data: {
      levelId: level.id,
      visibility: visibility.data,
      label,
      unit,
      // Re-home to the end of the destination level only when it changed.
      ...(levelChanged ? { position: await nextPositionInLevel(teacher.id, level.id) } : {}),
    },
    select: { id: true },
  });
  // Only touch tags when the picker was actually rendered — checked via an
  // explicit marker, not formData.has("focusTagId"): the teacher deselecting
  // every tag posts zero focusTagId fields too, and that must still clear
  // them. A client that never rendered the picker at all (e.g. an older one)
  // omits the marker and existing tags are left untouched.
  if (formData.has("focusTagIdsPresent")) {
    await syncLibraryMaterialFocusTags(teacher.id, material.id, readFocusTagIds(formData));
  }

  revalidateAfterAction("/dashboard/materials");
  return { ok: en ? "Material updated." : "Material actualizado." };
}

// ---------- archive / unarchive ----------

export async function setLibraryMaterialArchivedAction(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const id = String(formData.get("materialId") ?? "");
  const archived = String(formData.get("archived") ?? "") === "true";
  if (!id) return;

  // Scope to teacher; updateMany is a no-op if the id isn't theirs.
  await prisma.libraryMaterial.updateMany({
    where: { id, teacherId: teacher.id },
    data: { archived },
  });
  revalidateAfterAction("/dashboard/materials");
}

// ---------- hard delete (frees storage) ----------

export async function deleteLibraryMaterialAction(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const id = String(formData.get("materialId") ?? "");
  if (!id) return;

  const material = await prisma.libraryMaterial.findFirst({
    where: { id, teacherId: teacher.id },
    select: { id: true, storagePath: true, bookingId: true, body: true },
  });
  if (!material) return;

  // Free the storage object first; the row (and its assignments, via cascade)
  // goes next. Storage removal is best-effort — a leaked object is better than
  // a dangling row.
  if (material.storagePath) {
    await removeMaterialObject(material.storagePath);
  }
  // Images embedded in the body are separate objects from the file
  // attachment above, and are only swept when no other material still
  // references them.
  await removeUnreferencedMaterialImages({
    teacherId: teacher.id,
    materialId: material.id,
    body: material.body,
  });
  await prisma.libraryMaterial.delete({ where: { id: material.id } });
  // A booking-scoped row (D-69) renders on its class page instead of the
  // library list, and the delete is issued from whichever of the two the
  // teacher is looking at. One revalidation, for that page.
  revalidateAfterAction(
    material.bookingId ? `/dashboard/classes/${material.bookingId}` : "/dashboard/materials",
  );
}

// ---------- reorder within a level ----------

export async function moveLibraryMaterialAction(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const id = String(formData.get("materialId") ?? "");
  const direction = String(formData.get("direction") ?? "");
  if (!id || (direction !== "up" && direction !== "down")) return;

  const item = await prisma.libraryMaterial.findFirst({
    where: { id, teacherId: teacher.id },
    select: { id: true, levelId: true, position: true },
  });
  if (!item) return;

  // Find the adjacent item in the same level to swap positions with.
  const neighbor = await prisma.libraryMaterial.findFirst({
    where: {
      teacherId: teacher.id,
      levelId: item.levelId,
      position: direction === "up" ? { lt: item.position } : { gt: item.position },
    },
    orderBy: { position: direction === "up" ? "desc" : "asc" },
    select: { id: true, position: true },
  });
  if (!neighbor) return; // already at the edge

  await prisma.$transaction([
    prisma.libraryMaterial.update({
      where: { id: item.id },
      data: { position: neighbor.position },
    }),
    prisma.libraryMaterial.update({
      where: { id: neighbor.id },
      data: { position: item.position },
    }),
  ]);
  revalidateAfterAction("/dashboard/materials");
}

// ---------- per-student assignment + completion (the notebook) ----------

// Verifies the student is linked to the teacher and the material is theirs,
// returning both ids or null. Shared by assign / unassign / setCompleted.
async function verifyAssignmentTargets(
  teacherId: string,
  studentId: string,
  materialId: string,
): Promise<boolean> {
  const [link, material] = await Promise.all([
    prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId } },
      select: { studentId: true },
    }),
    // Reusable items only — a booking-scoped material (D-69) is private to
    // its class and never assignable to a student's notebook.
    prisma.libraryMaterial.findFirst({
      where: { id: materialId, teacherId, bookingId: null },
      select: { id: true },
    }),
  ]);
  return Boolean(link && material);
}

export type AssignMaterialState = { error?: string; ok?: boolean } | undefined;

export async function assignLibraryMaterialAction(
  _prev: AssignMaterialState,
  formData: FormData,
): Promise<AssignMaterialState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const studentId = String(formData.get("studentId") ?? "");
  const materialId = String(formData.get("materialId") ?? "");
  // Every failure surfaces — this action used to return silently, which
  // left the teacher believing material was assigned when nothing saved
  // (review item 8).
  if (!studentId || !materialId) {
    return {
      error: en ? "Choose a material first." : "Primero elige un material.",
    };
  }
  if (!(await verifyAssignmentTargets(teacher.id, studentId, materialId))) {
    return {
      error: en
        ? "That material or student is no longer available. Reload the page and try again."
        : "Ese material o alumno ya no está disponible. Recarga la página e intenta de nuevo.",
    };
  }

  // Was this material already on the student's notebook? Re-assigning is an
  // idempotent no-op, so we only notify on the first assignment — otherwise a
  // teacher toggling things would re-ping the student.
  const alreadyAssigned = await prisma.studentLibraryItem.findUnique({
    where: { studentId_libraryMaterialId: { studentId, libraryMaterialId: materialId } },
    select: { id: true },
  });

  // Idempotent on the unique (student_id, library_material_id) index.
  await prisma.studentLibraryItem.upsert({
    where: { studentId_libraryMaterialId: { studentId, libraryMaterialId: materialId } },
    create: { teacherId: teacher.id, studentId, libraryMaterialId: materialId },
    update: {},
  });

  trackServerEvent({
    name: "library_item_assigned",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, studentId, libraryMaterialId: materialId },
  });

  // Tell the student a new material landed on their account. The class-materials
  // path notifies via materials_send; this is the account-level counterpart.
  if (!alreadyAssigned) {
    await notifyLibraryMaterialAssigned(prisma, {
      teacherId: teacher.id,
      studentId,
      libraryMaterialId: materialId,
    });
  }
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/students/${studentId}`);
  return { ok: true };
}

export async function unassignLibraryMaterialAction(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const studentId = String(formData.get("studentId") ?? "");
  const materialId = String(formData.get("materialId") ?? "");
  if (!studentId || !materialId) return;

  // teacherId scoping makes this a no-op for items that aren't this teacher's.
  await prisma.studentLibraryItem.deleteMany({
    where: { teacherId: teacher.id, studentId, libraryMaterialId: materialId },
  });
  revalidateAfterAction(`/dashboard/students/${studentId}`);
}

// Teacher-driven completion (it's her notebook). completedBy records who
// flipped it so we can open self-marking to students later without a migration.
export async function setLibraryItemCompletedAction(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const studentId = String(formData.get("studentId") ?? "");
  const materialId = String(formData.get("materialId") ?? "");
  const completed = String(formData.get("completed") ?? "") === "true";
  if (!studentId || !materialId) return;

  const result = await prisma.studentLibraryItem.updateMany({
    where: { teacherId: teacher.id, studentId, libraryMaterialId: materialId },
    data: completed
      ? { completedAt: new Date(), completedBy: "teacher" }
      : { completedAt: null, completedBy: null },
  });
  if (result.count === 0) return;

  trackServerEvent({
    name: "library_item_completed",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, studentId, libraryMaterialId: materialId, completed },
  });
  await flushAnalytics();

  revalidateAfterAction(`/dashboard/students/${studentId}`);
}
