import { prisma } from "@/lib/prisma";
import type { AppLocale } from "@/lib/i18n";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { resolveFocusTagsWithCategory } from "@/lib/focus-tags";
import { usesEnglishCopy, languageName, stripAnswerKeyMarkdown } from "@spiralclass/shared";
import { logger } from "@/lib/logger";
import { hasAnthropicCreds, podcastsEnabled } from "@/lib/env";
import { enqueue } from "@/lib/jobs/enqueue";
import {
  CLASS_CONTENT_AI_MONTHLY_CAP,
  PODCAST_DEFAULT_DURATION_MIN,
  PODCAST_WORDS_PER_MINUTE,
  monthStartUtc,
} from "@/lib/materials/config";
import type { PodcastPromptInput } from "@/lib/materials/podcast-prompt";
import { mintMaterialPodcastSignedUrl } from "@/lib/storage/material-podcast";

const log = logger({ surface: "materials-podcast" });

// Orchestration for material podcast generation — the sync half (gate + cap +
// enqueue) plus the read side. The slow work (Claude script → ElevenLabs synth
// → R2 upload) runs in the Inngest job (on-material-podcast-requested.ts), which
// calls the *JobStep helpers below. Gating is the SHARED class_content Pro-cap,
// exactly like handlers.ts: one monthly quota pool across text + podcast, one
// ClassContentGeneration row burned per successful podcast.
//
// @/lib/ai/{anthropic,elevenlabs} pull in `server-only`; they're imported
// dynamically inside the job (not here) so the enqueue/read paths — and the
// route-inventory test that loads every handler — don't drag them into their graph.

// Estimate a podcast's duration from its script: word count over a single
// narrator's average pace. No ffmpeg probe — good enough for a "~4 min" label.
export function estimatePodcastDurationSec(script: string): number {
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round((words / PODCAST_WORDS_PER_MINUTE) * 60));
}

// Shared subject resolve (mirrors handlers.ts): the language a teacher teaches,
// resolved to its English name for the prompt. Null when unset.
async function resolveTargetLanguage(teacherId: string): Promise<string | null> {
  const teacher = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: { targetLanguage: true },
  });
  return teacher?.targetLanguage ? languageName(teacher.targetLanguage) : null;
}

async function usedThisMonth(teacherId: string): Promise<number> {
  return prisma.classContentGeneration.count({
    where: { teacherId, createdAt: { gte: monthStartUtc(new Date()) } },
  });
}

function capMessage(en: boolean): string {
  return en
    ? `You've reached this month's AI generation limit (${CLASS_CONTENT_AI_MONTHLY_CAP}). You can still write and record content yourself.`
    : `Alcanzaste el límite de generaciones con IA de este mes (${CLASS_CONTENT_AI_MONTHLY_CAP}). Aún puedes crear el contenido tú mismo.`;
}

export type RequestPodcastResult =
  | { ok: true }
  | {
      ok: false;
      code: "not-pro" | "cap" | "not-found" | "invalid" | "not-configured" | "already-pending";
      message: string;
    };

// Enqueue podcast generation for a SAVED material: gate → cap → creds → material
// (must have a body) → idempotency → upsert the MaterialPodcast row to `pending`
// → emit the Inngest event. Never renders here; the job does. The material fetch
// is tenant-scoped and scope-agnostic (works for a library item or a booking's
// content material alike).
export async function requestMaterialPodcast(input: {
  teacherId: string;
  materialId: string;
  language?: string | null;
  targetDurationMin?: number | null;
  locale: AppLocale;
}): Promise<RequestPodcastResult> {
  const en = usesEnglishCopy(input.locale);

  const gate = await gateProFeature(input.teacherId, "class_content");
  if (!gate.ok)
    return { ok: false, code: "not-pro", message: upgradeNudge(gate.limit, input.locale) };

  // Both halves are required — the script (Claude) and the audio (a TTS rail:
  // Google preferred, ElevenLabs fallback).
  if (!hasAnthropicCreds() || !podcastsEnabled()) {
    return {
      ok: false,
      code: "not-configured",
      message: en
        ? "Podcast generation isn't available right now."
        : "La generación de podcast no está disponible ahora.",
    };
  }

  if ((await usedThisMonth(input.teacherId)) >= CLASS_CONTENT_AI_MONTHLY_CAP) {
    return { ok: false, code: "cap", message: capMessage(en) };
  }

  const material = await prisma.libraryMaterial.findFirst({
    where: { id: input.materialId, teacherId: input.teacherId },
    select: { id: true, body: true, podcast: { select: { status: true } } },
  });
  if (!material) {
    return {
      ok: false,
      code: "not-found",
      message: en ? "Material not found." : "Material no encontrado.",
    };
  }
  if (!material.body || material.body.trim().length === 0) {
    return {
      ok: false,
      code: "invalid",
      message: en
        ? "Add some written content before generating a podcast."
        : "Agrega contenido escrito antes de generar un podcast.",
    };
  }
  if (material.podcast?.status === "pending") {
    return {
      ok: false,
      code: "already-pending",
      message: en ? "A podcast is already being generated." : "Ya se está generando un podcast.",
    };
  }

  const targetDurationMin = input.targetDurationMin ?? PODCAST_DEFAULT_DURATION_MIN;

  // Reuse the one row (regenerate replaces the prior audio); clear stale
  // storage/error so a failed→pending retry doesn't show a dead player.
  await prisma.materialPodcast.upsert({
    where: { materialId: material.id },
    create: { materialId: material.id, teacherId: input.teacherId, status: "pending" },
    update: { status: "pending", error: null },
  });

  await enqueue("material.podcast.requested", {
    teacherId: input.teacherId,
    materialId: material.id,
    language: input.language ?? null,
    targetDurationMin,
    // The event schema carries "en" | "es" (narration default); the handler
    // re-widens to AppLocale. Cast preserves the exact prior runtime value —
    // inngest.send accepted the AppLocale under the same narrow type before.
    locale: input.locale as "en" | "es",
  });

  trackServerEvent({
    name: "material_podcast_requested",
    distinctId: input.teacherId,
    properties: { teacherId: input.teacherId, materialId: material.id },
  });

  return { ok: true };
}

export type MaterialPodcastView = {
  status: "pending" | "ready" | "failed";
  url: string | null;
  durationSec: number | null;
  generatedAt: Date | null;
  error: string | null;
};

// Read the current podcast state for a material (tenant-scoped). Mints a signed
// playback URL only when `ready`. Null when the material has no podcast row.
export async function getMaterialPodcast(input: {
  teacherId: string;
  materialId: string;
}): Promise<MaterialPodcastView | null> {
  const row = await prisma.materialPodcast.findFirst({
    where: { materialId: input.materialId, teacherId: input.teacherId },
    select: {
      status: true,
      storagePath: true,
      durationSec: true,
      generatedAt: true,
      error: true,
    },
  });
  if (!row) return null;
  const url =
    row.status === "ready" && row.storagePath
      ? await mintMaterialPodcastSignedUrl(row.storagePath)
      : null;
  return {
    status: row.status,
    url,
    durationSec: row.durationSec,
    generatedAt: row.generatedAt,
    error: row.error,
  };
}

// ---------- job-side helpers (called from the Inngest function) ----------

export type PreparePodcastResult =
  | { ok: true; promptInput: PodcastPromptInput }
  | { ok: false; terminal: true; reason: "gone" | "not-pending" | "not-pro" | "cap" | "invalid" };

// Re-validate at job time (the queue could have crossed a month boundary, or
// the teacher downgraded) and build the script prompt input. Returns a terminal
// skip when the row is no longer pending — the guard that makes a retry after a
// prior success a no-op, so quota can't be double-burned.
export async function preparePodcastJob(input: {
  teacherId: string;
  materialId: string;
  language?: string | null;
  targetDurationMin: number;
  locale: AppLocale;
}): Promise<PreparePodcastResult> {
  const material = await prisma.libraryMaterial.findFirst({
    where: { id: input.materialId, teacherId: input.teacherId },
    select: {
      body: true,
      levelId: true,
      level: { select: { label: true } },
      focusTags: { select: { focusTagId: true } },
      podcast: { select: { status: true } },
    },
  });
  if (!material) return { ok: false, terminal: true, reason: "gone" };
  if (material.podcast?.status !== "pending")
    return { ok: false, terminal: true, reason: "not-pending" };
  if (!material.body || material.body.trim().length === 0) {
    return { ok: false, terminal: true, reason: "invalid" };
  }

  // The narrator gets the STUDENT copy of the body. A podcast is a
  // student-facing artifact — getStudentLibraryView mints a playback URL for
  // it — so narrating the `> [!answer]` callouts would read the answer key
  // aloud, undoing every text-side filter in one listen. Stripping the PROMPT
  // input rather than the script is what makes that structural: the model is
  // never given the solutions, so it cannot allude to them either.
  //
  // A body that is nothing but an answer key strips to empty and has nothing
  // to narrate — the same terminal `invalid` an empty body already gets.
  const narratableBody = stripAnswerKeyMarkdown(material.body);
  if (narratableBody.trim().length === 0) {
    return { ok: false, terminal: true, reason: "invalid" };
  }

  const gate = await gateProFeature(input.teacherId, "class_content");
  if (!gate.ok) return { ok: false, terminal: true, reason: "not-pro" };
  if ((await usedThisMonth(input.teacherId)) >= CLASS_CONTENT_AI_MONTHLY_CAP) {
    return { ok: false, terminal: true, reason: "cap" };
  }

  const focusTagIds = material.focusTags.map((t) => t.focusTagId);
  const tags = focusTagIds.length
    ? await resolveFocusTagsWithCategory(input.teacherId, focusTagIds)
    : [];
  const focusLabels = tags.map((t) => t.label);

  return {
    ok: true,
    promptInput: {
      body: narratableBody,
      levelLabel: material.level?.label ?? null,
      focusLabels,
      language: input.language ?? null,
      targetLanguage: await resolveTargetLanguage(input.teacherId),
      locale: input.locale,
      targetDurationMin: input.targetDurationMin,
    },
  };
}

// Write `ready` + the audio pointer and burn exactly one quota row. Guarded by
// the pending→ready transition in the update `where` so a duplicate/retry after
// success is a no-op (updateMany returns count 0) and never double-burns.
export async function completePodcast(input: {
  teacherId: string;
  materialId: string;
  storagePath: string;
  script: string;
  voice: string;
  durationSec: number;
}): Promise<{ burned: boolean }> {
  const res = await prisma.materialPodcast.updateMany({
    where: { materialId: input.materialId, teacherId: input.teacherId, status: "pending" },
    data: {
      status: "ready",
      storagePath: input.storagePath,
      script: input.script,
      voice: input.voice,
      durationSec: input.durationSec,
      generatedAt: new Date(),
      error: null,
    },
  });
  if (res.count === 0) return { burned: false }; // already finalized by a prior run
  await prisma.classContentGeneration.create({ data: { teacherId: input.teacherId } });
  trackServerEvent({
    name: "material_podcast_generated",
    distinctId: input.teacherId,
    properties: {
      teacherId: input.teacherId,
      materialId: input.materialId,
      durationSec: input.durationSec,
    },
  });
  return { burned: true };
}

// Mark the podcast failed with a short reason for the UI. Only flips a row still
// `pending` (a later successful retry must win); never burns quota.
export async function failPodcast(input: {
  teacherId: string;
  materialId: string;
  reason: string;
}): Promise<void> {
  await prisma.materialPodcast.updateMany({
    where: { materialId: input.materialId, teacherId: input.teacherId, status: "pending" },
    data: { status: "failed", error: input.reason.slice(0, 300) },
  });
  log.warn("podcast generation failed", { materialId: input.materialId, reason: input.reason });
}
