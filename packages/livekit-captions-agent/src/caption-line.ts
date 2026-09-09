import type { CaptionLine } from "@spiralclass/shared";
import type { SpeakerDirection } from "./direction";

// Building the wire packet for one finished utterance. Pure, and separated
// from RoomWorker for the same reason direction.ts and captions-toggle.ts
// are: the decisions here are worth asserting without standing up a LiveKit
// room, and there are two of them that are easy to get quietly wrong.
//
// The Agent is the ONLY component that ever holds all four facts a
// language-lesson subtitle needs — Deepgram gives it the source text, Claude
// the translation, the room the speaker, the room config the two language
// codes. Anything it does not attach here is unrecoverable downstream, which
// is exactly what happened before: it shipped the translation alone and the
// verbatim source, the thing a learner is actually trying to learn, was
// thrown away at this line.

export function buildCaptionLine(args: {
  // The translated text — what the listener can read.
  translated: string;
  // The verbatim ASR transcript of what was said.
  source: string;
  direction: SpeakerDirection;
  speakerIdentity: string;
  // Monotonic within the publisher; see `captionLineId`.
  seq: number;
  now: number;
}): CaptionLine {
  const { translated, source, direction, speakerIdentity, seq, now } = args;
  const line: CaptionLine = {
    t: "line",
    for: direction.listenerIdentity,
    id: captionLineId(now, seq),
    text: translated,
    from: speakerIdentity,
    lang: direction.target,
    srcLang: direction.source,
  };
  const src = source.trim();
  // Omit `src` when the translation came back identical to what was said.
  // The translation prompt explicitly instructs the model to return
  // already-target-language text unchanged, so this is a routine outcome (the
  // teacher speaking the student's own language for a moment), not an edge
  // case — and sending it anyway would stack the same sentence twice in the
  // band's dual-line layout, which reads as a bug.
  //
  // Case-insensitive because the only difference is often the model
  // capitalising a sentence the ASR did not; that is not two languages.
  if (src && src.toLowerCase() !== translated.trim().toLowerCase()) line.src = src;
  return line;
}

// Monotonic per publisher session, NOT a bare `Date.now()`. The receiver keys
// its caption feed by this id so a redelivery replaces rather than stacks —
// which means two segments finalizing inside the same millisecond (routine
// when both people talk over each other) would collide on a clock-only id and
// silently drop one of the two lines.
export function captionLineId(now: number, seq: number): string {
  return `${now}-${seq}`;
}
