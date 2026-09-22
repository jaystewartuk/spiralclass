import { inngest } from "../client";
import { logger } from "@/lib/logger";
import type { AppLocale } from "@/lib/i18n";
import {
  completePodcast,
  estimatePodcastDurationSec,
  failPodcast,
  preparePodcastJob,
} from "@/lib/materials/podcast";
import { MAX_PODCAST_BYTES } from "@/lib/materials/config";
import { headMaterialPodcastObject, uploadMaterialPodcast } from "@/lib/storage/material-podcast";

const log = logger({ surface: "material-podcast" });

// Generates a material's podcast: Claude writes a spoken single-narrator script,
// ElevenLabs renders it to an mp3, the mp3 lands in the material-podcasts R2
// bucket, and the MaterialPodcast row flips pending → ready (or failed). Runs
// off the request path because TTS render is slow.
//
// Idempotency: every DB write is guarded by the pending-status transition
// (preparePodcastJob bails "not-pending", completePodcast/failPodcast only touch
// a still-pending row), so a retry after a prior success is a no-op and quota is
// never double-burned. Each external call is its own step.run; the raw audio
// bytes never cross a step boundary (synth+upload live in one step) so nothing
// large is serialized into the run's state.
//
// @/lib/ai/{anthropic,tts} are imported dynamically inside the steps
// (server-only) so this module's static graph stays clean. tts.ts picks the
// TTS rail (Google preferred, ElevenLabs fallback) by which key is configured.
export const onMaterialPodcastRequestedFn = inngest.createFunction(
  {
    id: "on-material-podcast-requested",
    retries: 3,
    triggers: [{ event: "material.podcast.requested" }],
  },
  ({ event, step }) =>
    onMaterialPodcastRequestedHandler({
      event: event as unknown as PodcastRequestedEvent,
      step: step as unknown as PodcastReqStep,
    }),
);

// Structural step shape so both the Inngest wrapper above and the pg-boss
// event definition (lib/jobs/events.ts) drive the same body (Phase 2a,
// docs/architecture/overview.md). Only step.run is used — no
// long sleep — so a pg-boss `{ run: (id, fn) => fn() }` shim is exact.
type PodcastReqStep = { run: <T>(id: string, fn: () => T | Promise<T>) => Promise<T> };
export type PodcastRequestedEvent = {
  data: {
    teacherId: string;
    materialId: string;
    language?: string | null;
    targetDurationMin?: number | null;
    locale: "en" | "es";
  };
  ts?: number;
};

export async function onMaterialPodcastRequestedHandler({
  event,
  step,
}: {
  event: PodcastRequestedEvent;
  step: PodcastReqStep;
}) {
  const { teacherId, materialId } = event.data;
  const locale = event.data.locale as AppLocale;
  const language = event.data.language ?? null;
  const targetDurationMin = event.data.targetDurationMin ?? 4;

  // 1. Re-validate at job time + build the prompt input (also the pending guard).
  const prep = await step.run("prepare", () =>
    preparePodcastJob({ teacherId, materialId, language, targetDurationMin, locale }),
  );
  if (!prep.ok) {
    // "gone"/"not-pending" — nothing to do (already handled or row vanished).
    // Real problems (not-pro/cap/invalid) surface as a failed row for the UI.
    if (prep.reason !== "gone" && prep.reason !== "not-pending") {
      await step.run("mark-failed-prepare", () =>
        failPodcast({ teacherId, materialId, reason: prep.reason }),
      );
    }
    return { ok: false, reason: prep.reason };
  }

  // 2. Script (Claude).
  const scripted = await step.run("build-script", async () => {
    const { generatePodcastScript } = await import("@/lib/ai/anthropic");
    return generatePodcastScript(prep.promptInput);
  });
  if (!scripted.ok) {
    await step.run("mark-failed-script", () =>
      failPodcast({ teacherId, materialId, reason: `script:${scripted.reason}` }),
    );
    return { ok: false, reason: `script:${scripted.reason}` };
  }

  // 3. Synthesize + upload in ONE step so the mp3 bytes never cross a step
  //    boundary (Inngest serializes each step's return into run state).
  const rendered = await step.run("render-and-upload", async () => {
    const { synthesizePodcast } = await import("@/lib/ai/tts");
    const synth = await synthesizePodcast(scripted.script, { language, locale });
    if (!synth.ok) return { ok: false as const, reason: `synth:${synth.reason}` };
    if (synth.audio.byteLength > MAX_PODCAST_BYTES) {
      return { ok: false as const, reason: "synth:too-large" };
    }
    const timestamp = event.ts ?? Date.now();
    const up = await uploadMaterialPodcast(teacherId, materialId, synth.audio, timestamp);
    if ("error" in up) return { ok: false as const, reason: `upload:${up.error}` };
    const size = await headMaterialPodcastObject(up.storagePath);
    if (size === null) return { ok: false as const, reason: "upload:not-landed" };
    return { ok: true as const, storagePath: up.storagePath, voiceId: synth.voiceId };
  });
  if (!rendered.ok) {
    await step.run("mark-failed-render", () =>
      failPodcast({ teacherId, materialId, reason: rendered.reason }),
    );
    return { ok: false, reason: rendered.reason };
  }

  // 4. Finalize: mark ready + burn exactly one quota row (pending→ready guarded).
  const durationSec = estimatePodcastDurationSec(scripted.script);
  const done = await step.run("finalize", () =>
    completePodcast({
      teacherId,
      materialId,
      storagePath: rendered.storagePath,
      script: scripted.script,
      voice: rendered.voiceId,
      durationSec,
    }),
  );

  log.info("podcast generated", { materialId, durationSec, burned: done.burned });
  return { ok: true, materialId, durationSec };
}
