"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Mic, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useT } from "@/components/locale-provider";
import {
  generateMaterialPodcastAction,
  getMaterialPodcastStatusAction,
  type MaterialPodcastStatus,
} from "@/app/actions/library";

export type PodcastInitial = {
  status: MaterialPodcastStatus["status"];
  url: string | null;
  durationSec: number | null;
  error: string | null;
};

// Podcast generation on the material form — turns a saved material's body into a
// short, single-narrator audio episode (Claude writes the script, ElevenLabs
// renders it, off the request path via Inngest). Rendered only for a saved
// material with a body; while generating it polls status until ready/failed and
// then shows an inline audio player. Hidden entirely when podcast generation
// isn't configured (`enabled` false) — the graceful-degrade posture.

function formatDuration(sec: number | null): string | null {
  if (!sec || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const POLL_MS = 4000;

export function MaterialPodcastSection({
  materialId,
  enabled,
  initial,
}: {
  materialId: string;
  enabled: boolean;
  // Optional seed; when omitted the section hydrates its current state on mount
  // (edit forms mount lazily, one at a time, so this is a cheap single fetch).
  initial?: PodcastInitial;
}) {
  const t = useT();
  const [status, setStatus] = useState<MaterialPodcastStatus["status"]>(initial?.status ?? "none");
  const [url, setUrl] = useState<string | null>(initial?.url ?? null);
  const [durationSec, setDurationSec] = useState<number | null>(initial?.durationSec ?? null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guards the hydrate fetch to a single run even though the effect lists its
  // (stable) deps — avoids re-fetching if the parent ever re-renders with a new
  // `initial`/prop identity.
  const hydratedRef = useRef(false);

  // Hydrate current state on mount when no seed was provided.
  useEffect(() => {
    if (hydratedRef.current || initial || !enabled) return;
    hydratedRef.current = true;
    let cancelled = false;
    void (async () => {
      const view = await getMaterialPodcastStatusAction(materialId);
      if (cancelled) return;
      setStatus(view.status);
      setUrl(view.url);
      setDurationSec(view.durationSec);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, initial, materialId]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  // While the podcast is generating, poll the status action until it lands.
  useEffect(() => {
    if (status !== "pending") {
      stopPolling();
      return;
    }
    if (pollTimer.current) return;
    pollTimer.current = setInterval(async () => {
      const next = await getMaterialPodcastStatusAction(materialId);
      if (next.status === "ready" || next.status === "failed" || next.status === "none") {
        setStatus(next.status === "none" ? "failed" : next.status);
        setUrl(next.url);
        setDurationSec(next.durationSec);
        if (next.status === "failed") setError(t("classContent.podcast.failed"));
        stopPolling();
      }
    }, POLL_MS);
    return stopPolling;
  }, [status, materialId, stopPolling, t]);

  useEffect(() => stopPolling, [stopPolling]);

  function generate() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("materialId", materialId);
      const res = await generateMaterialPodcastAction(undefined, fd);
      if (res?.error) {
        setError(res.error);
        return;
      }
      // Accepted (or already in flight) → show generating + start polling.
      setStatus("pending");
      setUrl(null);
    });
  }

  if (!enabled) return null;

  const duration = formatDuration(durationSec);
  const isBusy = pending || status === "pending";

  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3">
      <div className="flex items-center gap-1.5">
        <Mic className="size-4 text-primary" aria-hidden />
        <Label>{t("classContent.podcast.title")}</Label>
      </div>

      {status === "ready" && url ? (
        <div className="space-y-2">
          <audio controls src={url} className="w-full" preload="none">
            <track kind="captions" />
          </audio>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t("classContent.podcast.ready")}
              {duration ? ` · ${duration}` : ""}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={generate} disabled={isBusy}>
              <RefreshCw className="mr-1 size-3.5" aria-hidden />
              {t("classContent.podcast.regenerate")}
            </Button>
          </div>
        </div>
      ) : status === "pending" ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-live="polite">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("classContent.podcast.pending")}
        </p>
      ) : (
        <div className="space-y-1.5">
          <Button type="button" variant="secondary" onClick={generate} disabled={isBusy}>
            <Mic className="mr-1 size-4" aria-hidden />
            {isBusy ? t("classContent.podcast.generating") : t("classContent.podcast.generate")}
          </Button>
          <p className="text-xs text-muted-foreground">{t("classContent.podcast.help")}</p>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
