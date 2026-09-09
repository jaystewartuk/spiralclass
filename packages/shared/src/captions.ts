// The live-caption data-channel protocol. Pure and dependency-free so the web
// every consumer shares ONE definition — every consumer of the room's
// data channel agrees on the wire shape without drifting. Encoded as JSON over
// LiveKit's reliable data channel under a dedicated topic.
//
// Two message kinds travel the channel:
//   * "line"  — one finished, translated caption to show.
//   * "state" — captions just turned on/off for this participant; tells the
//               receiver to show or hide the caption band (so turning
//               captions off clears the screen immediately rather than
//               leaving the last line stranded).
//
// `for` (required on every message, since the LiveKit captions Agent — see
// the captions architecture review — publishes into a room with
// more than 2 participants): the LiveKit participant identity this message is
// addressed to. Before the Agent, there were always exactly 2 human
// participants and a publisher's own `publishData` is never echoed back to
// itself, so "whatever arrives over this topic must be the other side's
// line" held by construction. A third room participant breaks that
// assumption, so every message now names its intended recipient explicitly;
// a receiver must check `msg.for === myOwnIdentity` before rendering.
//
// TextEncoder/TextDecoder are used for the JSON<->bytes step. They exist in the
// browser and in the React Native runtime that livekit-client already relies on
// for its own data methods, so both consumers are covered.

// LiveKit data-channel topic the caption packets ride on. Namespaced so a caption
// packet is never confused with any other use of the room's data channel.
export const CAPTION_TOPIC = "captions";

export type CaptionLine = {
  t: "line";
  // The LiveKit participant identity this line is addressed to.
  for: string;
  // Stable id for this line, so a re-render or a duplicate delivery replaces
  // rather than stacks. Monotonic per publisher session is enough.
  id: string;
  // The translated caption text (target language, e.g. English).
  text: string;
  // WHAT THE SPEAKER ACTUALLY SAID, verbatim, before translation.
  //
  // This is a language-teaching product: the words the other person just
  // produced ARE the lesson, and until now the one component that had them
  // (the Agent, which asks Deepgram for them and then hands them to Claude)
  // threw them away and shipped only the translation. A learner watching a
  // subtitle that says "how are you?" cannot map it back to the sounds she
  // just heard; one that shows "¿cómo estás?" over "how are you?" is the
  // whole point of captioning a lesson rather than a meeting.
  //
  // OPTIONAL, and every consumer must render fine without it: any client
  // build older than this field omits it, and a
  // translation that came back identical to the source is deliberately sent
  // without it rather than duplicating one line twice on screen.
  src?: string;
  // The speaker's LiveKit participant identity (NOT their name — the client
  // already has the room's participant list and resolves the display name
  // itself, so a rename mid-call can't leave a stale name embedded in a
  // packet). Optional for the same backwards-compatibility reason as `src`;
  // a 1:1 room lets a receiver fall back to "the other person".
  from?: string;
  // BCP-47 codes for `text` and `src` respectively, so a viewer-side
  // renderer can set `lang` on each line — screen readers and hyphenation
  // both get it wrong otherwise when the two languages sit in one card.
  lang?: string;
  srcLang?: string;
};

export type CaptionState = {
  t: "state";
  // The LiveKit participant identity this state change is addressed to.
  for: string;
  // Whether captions are currently on. false → receiver hides the band.
  on: boolean;
};

export type CaptionMessage = CaptionLine | CaptionState;

// Serialize a message to the bytes LiveKit's publishData expects.
export function encodeCaption(msg: CaptionMessage): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(msg)) as Uint8Array<ArrayBuffer>;
}

// Parse bytes back into a CaptionMessage, or null if the payload is not a
// well-formed caption packet. Defensive on every field so a malformed or foreign
// packet on the channel degrades to "ignore" rather than throwing into the
// DataReceived handler.
export function decodeCaption(bytes: Uint8Array): CaptionMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.for !== "string" || obj.for.length === 0) return null;
  if (obj.t === "line") {
    if (typeof obj.id !== "string" || typeof obj.text !== "string") return null;
    // The optional enrichment fields (src/from/lang/srcLang) are picked off
    // one at a time and DROPPED individually when malformed, rather than
    // failing the whole packet the way a bad `id`/`text` does. The line is
    // still showable without any of them, and a receiver that discarded a
    // perfectly good subtitle over a junk `lang` attribute would be trading
    // the feature for the garnish.
    const line: CaptionLine = { t: "line", for: obj.for, id: obj.id, text: obj.text };
    if (typeof obj.src === "string" && obj.src.length > 0) line.src = obj.src;
    if (typeof obj.from === "string" && obj.from.length > 0) line.from = obj.from;
    if (typeof obj.lang === "string" && obj.lang.length > 0) line.lang = obj.lang;
    if (typeof obj.srcLang === "string" && obj.srcLang.length > 0) line.srcLang = obj.srcLang;
    return line;
  }
  if (obj.t === "state") {
    if (typeof obj.on !== "boolean") return null;
    return { t: "state", for: obj.for, on: obj.on };
  }
  return null;
}

// The captions Agent's own LiveKit participant identity. It joins every
// caption-enabled class room as a real third participant, so ANY client code
// that reasons about "the other person in this call" must exclude it — a
// remote-participant list is not a list of humans.
//
// Lives here rather than only in packages/livekit-captions-agent/src/config.ts
// (which now re-exports this) because the clients need it too, and two
// independently-maintained copies of a participant identity is precisely the
// kind of drift that produces silent, no-error bugs. Production 2026-07-26→29:
// "open material for the student" addressed its message to
// remoteParticipants[0], which could be the Agent, so the student never
// received it and nothing logged an error.
export const CAPTIONS_AGENT_IDENTITY = "captions-agent";

export function isCaptionsAgentIdentity(identity: string | undefined | null): boolean {
  return identity === CAPTIONS_AGENT_IDENTITY;
}

// The humans among a room's remote participants. The Agent publishes no media
// tracks, so a track-derived list already excludes it — but a
// `room.remoteParticipants`-derived one does NOT, and that is the list most
// "is the other person here?" checks reach for first.
export function humanRemotes<T extends { identity: string }>(remotes: Iterable<T>): T[] {
  return [...remotes].filter((p) => !isCaptionsAgentIdentity(p.identity));
}

// The two roles in a captioned call, and the language each speaks → the
// language the OTHER side should read. Bidirectional: the teacher's caption
// stream translates INTO the student's language, and vice versa (D-27, which
// replaced a hardcoded es/en swap with the resolved language pair).
export type CallRole = "teacher" | "student";

export type CaptionDirection = { source: string; target: string };

// Given who is speaking and the already-resolved language pair for this call
// (booking override ?? Teacher.teachingLanguage / Student.nativeLanguage
// defaults — the caller resolves that, this stays a pure function of role +
// languages), the ASR source language and the translation target language.
export function resolveCaptionDirection(params: {
  role: CallRole;
  teacherLanguage: string;
  studentLanguage: string;
}): CaptionDirection {
  return params.role === "teacher"
    ? { source: params.teacherLanguage, target: params.studentLanguage }
    : { source: params.studentLanguage, target: params.teacherLanguage };
}
