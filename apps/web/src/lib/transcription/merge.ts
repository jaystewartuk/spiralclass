import type { Speaker, SpeakerUtterance, TranscriptionResult, Word } from "./types";

// Merging the two per-speaker transcripts onto one booking timeline
// (lesson-insights Phase B). Each file's word timestamps are relative to ITS OWN
// egress start, and the two egresses don't start at the same instant, so we
// offset each file by its egress start (epoch ms) before merging.
//
// Files arrive one `lesson.audio.ready` event at a time, so we keep stored
// timestamps in ABSOLUTE epoch ms while merging incrementally — that's
// order-independent (no shared base to recompute as files trickle in). Once
// every file is in, `normalizeTimeline` rebases the whole transcript to a clean
// 0-based lesson timeline. All functions here are pure.

function shiftWord(w: Word, deltaMs: number): Word {
  return { ...w, startMs: w.startMs + deltaMs, endMs: w.endMs + deltaMs };
}

function shiftUtterance(u: SpeakerUtterance, deltaMs: number): SpeakerUtterance {
  return {
    ...u,
    startMs: u.startMs + deltaMs,
    endMs: u.endMs + deltaMs,
    words: u.words.map((w) => shiftWord(w, deltaMs)),
  };
}

const byStartMs = (a: SpeakerUtterance, b: SpeakerUtterance): number => a.startMs - b.startMs;

// Merge one freshly-transcribed file into the booking's existing utterances.
// `egressStartMs` is the file's egress start (epoch ms); each utterance is
// shifted onto that absolute timeline and tagged with the known speaker. Any
// existing utterances for the SAME speaker are dropped first, so reprocessing a
// file is idempotent. Result is ordered by absolute startMs.
export function mergeSpeakerSegment(
  existing: SpeakerUtterance[],
  incoming: { speaker: Speaker; egressStartMs: number; result: TranscriptionResult },
): SpeakerUtterance[] {
  const kept = existing.filter((u) => u.speaker !== incoming.speaker);
  const added: SpeakerUtterance[] = incoming.result.utterances.map((u) =>
    shiftUtterance({ ...u, speaker: incoming.speaker }, incoming.egressStartMs),
  );
  return [...kept, ...added].sort(byStartMs);
}

// Rebase a merged transcript so the earliest utterance starts at 0. Called once
// all files are in, to persist a clean lesson-relative timeline. No-op on empty.
export function normalizeTimeline(utterances: SpeakerUtterance[]): SpeakerUtterance[] {
  if (utterances.length === 0) return [];
  const base = Math.min(...utterances.map((u) => u.startMs));
  if (base === 0) return [...utterances].sort(byStartMs);
  return utterances.map((u) => shiftUtterance(u, -base)).sort(byStartMs);
}
