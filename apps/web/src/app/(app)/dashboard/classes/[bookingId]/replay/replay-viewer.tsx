"use client";

import { useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useT } from "@/components/locale-provider";
import type { SpeakerUtterance } from "@/lib/transcription/types";
import type { ReplayBookmark } from "@/lib/lesson-notes/bookmarks";

// Recorded-class replay: media player + searchable, speaker-labelled
// transcript. Clicking a transcript row (or a search result) seeks the
// player to that utterance's start time — the core "replay" interaction.
// Client component because it needs the media ref + input state; the parent
// page does all the data fetching/gating server-side.
//
// The player is an <audio> or a <video> depending on `recordingKind`: room
// composites are audio-only as of D-135, but recordings made before that are
// `.mp4` with video and still have to play. Both elements are HTMLMediaElement,
// so the seek/play logic below is identical for either and is written once.

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Splits `text` into plain/matched segments around (case-insensitive)
// occurrences of `query`, for <mark> highlighting. Returns the whole text as
// one plain segment when there's no query or no match.
function highlightSegments(text: string, query: string): { text: string; match: boolean }[] {
  if (!query.trim()) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const segments: { text: string; match: boolean }[] = [];
  let cursor = 0;
  let idx = lower.indexOf(needle, cursor);
  if (idx === -1) return [{ text, match: false }];
  while (idx !== -1) {
    if (idx > cursor) segments.push({ text: text.slice(cursor, idx), match: false });
    segments.push({ text: text.slice(idx, idx + needle.length), match: true });
    cursor = idx + needle.length;
    idx = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}

export function ReplayViewer({
  recordingUrl,
  recordingKind,
  utterances,
  bookmarks = [],
  summary,
}: {
  recordingUrl: string | null;
  recordingKind: "audio" | "video";
  utterances: SpeakerUtterance[];
  bookmarks?: ReplayBookmark[];
  summary: { body: string; generatedAt: string } | null;
}) {
  const t = useT();
  const mediaRef = useRef<HTMLMediaElement>(null);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return utterances;
    return utterances.filter((u) => u.text.toLowerCase().includes(q));
  }, [utterances, query]);

  function seekTo(startMs: number) {
    const media = mediaRef.current;
    if (!media) return;
    media.currentTime = startMs / 1000;
    void media.play();
  }

  return (
    <div className="space-y-6">
      {summary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {t("web.dashboard.classes.replay.summaryTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="whitespace-pre-wrap">{summary.body}</p>
            <p className="text-muted-foreground text-xs">
              {t("web.dashboard.classes.summary.generated")}
              {summary.generatedAt}
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-6">
          {recordingUrl ? (
            recordingKind === "audio" ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption -- no track file; the transcript alongside is the accessible equivalent.
              <audio
                ref={mediaRef as React.RefObject<HTMLAudioElement>}
                src={recordingUrl}
                controls
                className="w-full"
              />
            ) : (
              // eslint-disable-next-line jsx-a11y/media-has-caption -- no track file; the transcript alongside is the accessible equivalent.
              <video
                ref={mediaRef as React.RefObject<HTMLVideoElement>}
                src={recordingUrl}
                controls
                className="w-full rounded-md bg-black"
              />
            )
          ) : (
            <p className="text-muted-foreground text-sm">
              {t("web.dashboard.classes.replay.videoUnavailable")}
            </p>
          )}
        </CardContent>
      </Card>

      {bookmarks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              {t("web.dashboard.classes.replay.bookmarksTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-wrap gap-2">
              {bookmarks.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    onClick={() => b.atMs !== null && seekTo(b.atMs)}
                    disabled={!recordingUrl || b.atMs === null}
                    className="hover:bg-muted/50 flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    <span>{b.label}</span>
                    {b.atMs !== null && (
                      <span className="text-muted-foreground tabular-nums">{formatMs(b.atMs)}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">
            {t("web.dashboard.classes.replay.transcriptTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("web.dashboard.classes.replay.searchPlaceholder")}
            aria-label={t("web.dashboard.classes.replay.searchPlaceholder")}
          />
          {filtered.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("web.dashboard.classes.replay.noMatches")}
            </p>
          ) : (
            <ul className="max-h-[28rem] space-y-2 overflow-y-auto">
              {filtered.map((u, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => seekTo(u.startMs)}
                    disabled={!recordingUrl}
                    className="border-muted hover:bg-muted/50 flex w-full items-start gap-2 rounded-md border-l-2 px-2 py-1.5 text-left text-sm disabled:cursor-default disabled:hover:bg-transparent"
                  >
                    <Badge
                      variant={u.speaker === "teacher" ? "default" : "secondary"}
                      className="mt-0.5 shrink-0"
                    >
                      {u.speaker === "teacher"
                        ? t("web.dashboard.classes.replay.speakerTeacher")
                        : t("web.dashboard.classes.replay.speakerStudent")}
                    </Badge>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {formatMs(u.startMs)}
                    </span>
                    <span className="min-w-0 flex-1">
                      {highlightSegments(u.text, query).map((seg, j) =>
                        seg.match ? (
                          <mark key={j} className="bg-warning/40 rounded px-0.5">
                            {seg.text}
                          </mark>
                        ) : (
                          <span key={j}>{seg.text}</span>
                        ),
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
