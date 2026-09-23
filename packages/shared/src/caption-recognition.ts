// Live captions run in the participants' browsers (D-185): speech-to-text is
// the browser's own SpeechRecognition, translation is the browser's on-device
// Translator where it has one and our server otherwise. This module is the
// pure half of that design — every decision two clients (and the server) must
// agree on, with no browser API in sight so each is testable in node.
//
// The one fact that shapes all of it was measured, not assumed (D-185's
// Phase 0): Android Chrome's SpeechRecognition hears NOTHING while the same
// page publishes its microphone to a LiveKit call — neither from the default
// mic nor from the published track, whatever the capture constraints. Desktop
// Chrome hears both, and will also recognise a REMOTE participant's track.
// So a direction of speech is not always recognised by the person speaking:
// when their device cannot, the other participant's desktop browser does it
// from the call audio it already receives. And when NEITHER device can —
// two phones — the speaker's own browser streams their microphone to a paid
// speech-to-text service instead ("cloud", D-185's addendum), the one case
// the browsers leave uncovered.

import type { CallRole, CaptionDirection, CaptionLine } from "./captions";

// ---------------------------------------------------------------------------
// The class's caption session — what POST /api/captions/config returns
// ---------------------------------------------------------------------------

// Everything a participant's browser needs to caption one class, resolved by
// the server for a caller proven to be one of its two participants.
// `teacherIdentity` is how a client tells the two people in the room apart:
// the teacher joins LiveKit as her own id, while a student joins as her
// linked row's id, which need not be the booking's studentId — so the student
// is "the participant who is not the teacher", never a stored id.
export type CaptionSession = {
  bookingId: string;
  // The caller's own role in this class.
  role: CallRole;
  teacherIdentity: string;
  // Keyed by SPEAKER: the language they speak (and are recognised in) and the
  // language the other side reads.
  directions: Record<CallRole, CaptionDirection>;
  // SpeechRecognition.lang for each speaker (recognitionLocale).
  recognitionLocales: Record<CallRole, string>;
  // D-22: whether the student's speech may be captioned at all.
  studentConsent: boolean;
  // Whether the paid speech-to-text fallback is configured on the server, so
  // a speaker no browser here can recognise may be assigned "cloud". Both
  // clients read it from the same answer, so they agree on the assignment.
  cloudRecognition: boolean;
};

// ---------------------------------------------------------------------------
// Recognition locale
// ---------------------------------------------------------------------------

// SpeechRecognition.lang wants a regional tag where the region changes the
// model ("es-MX" and "es-ES" are different recognisers), while the product
// stores a bare language ("es"). The only region the product knows for sure is
// the teacher's own country, so a teacher's speech is recognised as
// `<language>-<her country>` when that pair is a real regional variant, and as
// the bare language otherwise. A student's speech always uses the bare code:
// a student has no country on file, and guessing one from the teacher's would
// hand a Colombian student a Spanish-from-Spain model because her teacher
// lives in Madrid.
//
// Only pairs listed here are ever composed, so a Japanese teacher in Mexico
// gets "ja", never the meaningless "ja-MX". The lists are the regions browser
// recognisers publish variants for; a missing pair costs a little accuracy,
// never a failure.
const REGIONAL_VARIANTS: Readonly<Record<string, readonly string[]>> = {
  ar: ["AE", "BH", "DZ", "EG", "IQ", "JO", "KW", "LB", "LY", "MA", "OM", "QA", "SA", "TN", "YE"],
  de: ["AT", "CH", "DE"],
  en: ["AU", "CA", "GB", "IE", "IN", "NZ", "PH", "SG", "US", "ZA"],
  es: [
    "AR",
    "BO",
    "CL",
    "CO",
    "CR",
    "DO",
    "EC",
    "ES",
    "GT",
    "HN",
    "MX",
    "NI",
    "PA",
    "PE",
    "PR",
    "PY",
    "SV",
    "US",
    "UY",
    "VE",
  ],
  fr: ["BE", "CA", "CH", "FR"],
  it: ["CH", "IT"],
  nl: ["BE", "NL"],
  pt: ["BR", "PT"],
};

export function recognitionLocale(language: string, country?: string | null): string {
  const trimmed = language.trim();
  // Already regional ("es-MX"): the caller knows better than a table.
  if (trimmed.includes("-")) return trimmed;
  const lang = trimmed.toLowerCase();
  const region = country?.trim().toUpperCase();
  if (region && REGIONAL_VARIANTS[lang]?.includes(region)) return `${lang}-${region}`;
  return lang;
}

// The bare language of a tag: "es-MX" → "es". Translation works on languages,
// not regions, and two tags that share one need no translation at all.
export function baseLanguage(tag: string): string {
  return tag.trim().split("-")[0].toLowerCase();
}

// ---------------------------------------------------------------------------
// Can this browser recognise speech during a call?
// ---------------------------------------------------------------------------

// What a client knows about its own browser. Gathered from `window` and
// `navigator` by the caller; kept as plain booleans here.
export type RecognitionEnvironment = {
  // window.SpeechRecognition (or the webkit-prefixed one) exists.
  hasRecognition: boolean;
  // SpeechRecognition.available is a function — the on-device API. It shipped
  // after start(MediaStreamTrack) did, and the specification offers no direct
  // way to detect the track overload (web-speech-api issue #126), so this is
  // the proxy for "start(track) is honoured". It matters: a browser that
  // silently ignores the track records the local microphone instead, which
  // would caption the teacher's own voice as if the student had said it.
  hasOnDeviceApi: boolean;
  // A Chromium engine (navigator.userAgentData lists "Chromium"). The only
  // engine measured recognising a track during a call.
  chromium: boolean;
  // A phone or tablet. Android was measured and cannot recognise during a
  // call; iOS was not tested, and every iOS browser is WebKit, which is
  // already excluded above.
  mobile: boolean;
};

// True when this browser can recognise both its own speech and the other
// participant's, while in a call. Deliberately claims only what was measured
// (desktop Chromium): an unproven browser answers false and its speech is
// recognised by the other side instead, which is a working caption rather
// than a silent one.
export function canRecognizeDuringCall(env: RecognitionEnvironment): boolean {
  return env.hasRecognition && env.hasOnDeviceApi && env.chromium && !env.mobile;
}

// The LiveKit participant attribute each client publishes about itself:
// "1" when canRecognizeDuringCall is true, "0" otherwise. Both clients read
// both attributes to run the same assignment below.
export const CAPTIONS_RECOGNIZER_ATTRIBUTE = "captionsAsr";

// The teacher's room-wide captions switch (D-27: teacher-toggled). Only the
// teacher's own attribute is ever trusted as the switch.
export const CAPTIONS_ON_ATTRIBUTE = "captionsOn";

// ---------------------------------------------------------------------------
// Who recognises whom
// ---------------------------------------------------------------------------

export type RecognizerInputs = {
  // The teacher's switch.
  captionsOn: boolean;
  // Whether the teacher / the student is in the room, and whether each one's
  // browser can recognise during a call (their published attribute). An
  // absent participant is simply `present: false`.
  teacher: { present: boolean; capable: boolean };
  student: { present: boolean; capable: boolean };
  // D-22: the student's speech is only ever captioned with her consent (her
  // guardian's for a minor). The teacher's own speech needs none.
  studentConsent: boolean;
  // CaptionSession.cloudRecognition: the paid fallback is configured.
  cloudAvailable: boolean;
};

// Who recognises one speaker: a participant's browser (by role), or "cloud" —
// the speaker's OWN browser streaming their microphone to the paid
// speech-to-text service, because no browser in the room can recognise.
export type Recognizer = CallRole | "cloud";

// For each speaker, who recognises their speech — or null when nobody does.
// Both clients compute this from the same room state, so they agree on it
// without talking to each other; a client runs exactly the recognisers
// assigned to its own role, plus the "cloud" one for its own speaker.
export type RecognizerAssignment = Record<CallRole, Recognizer | null>;

export function assignRecognizers(inputs: RecognizerInputs): RecognizerAssignment {
  const assign = (speaker: CallRole): Recognizer | null => {
    const listener: CallRole = speaker === "teacher" ? "student" : "teacher";
    if (!inputs.captionsOn) return null;
    if (speaker === "student" && !inputs.studentConsent) return null;
    // Nobody to caption for, and a speaker who is not here says nothing.
    if (!inputs[speaker].present || !inputs[listener].present) return null;
    // The speaker's own browser first: it has the cleanest audio (before the
    // network) and keeps each person's speech on their own device.
    if (inputs[speaker].capable) return speaker;
    if (inputs[listener].capable) return listener;
    // Only when no browser here can recognise: never two paths for one
    // speaker, and never paid minutes a free browser could have covered. The
    // consent check above already applies — the student's speech never
    // leaves her device for this without it.
    if (inputs.cloudAvailable) return "cloud";
    return null;
  };
  return { teacher: assign("teacher"), student: assign("student") };
}

// The server's half of the "cloud" rule, run before it mints a speech-to-text
// token: the caller's own browser may stream to the paid service only when the
// room, as LiveKit itself reports it, is one no browser can caption — so an
// authenticated participant cannot run up minutes from a room where a
// computer is doing the work for free. Reads the same two attributes the
// browsers publish; LiveKit's copy is the one the caller cannot edit after the
// fact, but it is still self-reported, so this bounds cost, not trust (the
// route's rate limits do the rest).
export type RoomParticipantAttributes = {
  identity: string;
  attributes: Readonly<Record<string, string>>;
};

export type CloudRecognitionRefusal =
  "caller-absent" | "alone" | "captions-off" | "browser-can-recognise";

export function cloudRecognitionRefusal(args: {
  participants: readonly RoomParticipantAttributes[];
  callerIdentity: string;
  teacherIdentity: string;
}): CloudRecognitionRefusal | null {
  const { participants, callerIdentity, teacherIdentity } = args;
  if (!participants.some((p) => p.identity === callerIdentity)) return "caller-absent";
  // Nobody to caption for (assignRecognizers asks the same).
  if (!participants.some((p) => p.identity !== callerIdentity)) return "alone";
  // Only the teacher's own switch counts (D-27).
  const teacher = participants.find((p) => p.identity === teacherIdentity);
  if (teacher?.attributes[CAPTIONS_ON_ATTRIBUTE] !== "true") return "captions-off";
  if (participants.some((p) => p.attributes[CAPTIONS_RECOGNIZER_ATTRIBUTE] === "1")) {
    return "browser-can-recognise";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

// Where a finished utterance is translated. "none" when speaker and listener
// share a language: showing the recognised text as-is is the translation.
export type TranslationRoute = "none" | "device" | "server";

// `deviceAvailability` is the browser Translator's own answer for this
// language pair — Translator.availability() — or null when the browser has no
// Translator at all (every mobile browser, and desktop browsers other than
// Chrome). "downloadable"/"downloading" still route to the device: the model
// arrives once and is then free and local, and a failed download is handled
// by the caller falling back to the server.
export function chooseTranslationRoute(
  source: string,
  target: string,
  deviceAvailability: string | null,
): TranslationRoute {
  if (baseLanguage(source) === baseLanguage(target)) return "none";
  if (
    deviceAvailability === "available" ||
    deviceAvailability === "downloadable" ||
    deviceAvailability === "downloading"
  ) {
    return "device";
  }
  return "server";
}

// The longest utterance the translation route accepts. Speech recognisers can
// hand back one very long final after a minute of uninterrupted talk, so the
// client splits rather than dropping it; the route rejects anything longer so
// an authenticated caller cannot turn it into a bulk translation endpoint.
export const MAX_CAPTION_CHARS = 500;

// Split an utterance into pieces of at most `max` characters, at sentence
// ends where possible, then at spaces, and only as a last resort mid-word.
// Whitespace is normalised; empty input gives no pieces.
export function splitUtterance(text: string, max = MAX_CAPTION_CHARS): string[] {
  const normalised = text.replace(/\s+/g, " ").trim();
  if (!normalised) return [];
  const pieces: string[] = [];
  let rest = normalised;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    const sentenceEnd = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("? "),
      window.lastIndexOf("! "),
    );
    let cut: number;
    if (sentenceEnd > 0) cut = sentenceEnd + 1;
    else if (window.lastIndexOf(" ") > 0) cut = window.lastIndexOf(" ");
    else cut = max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

// ---------------------------------------------------------------------------
// The wire line
// ---------------------------------------------------------------------------

// Building the packet for one finished utterance. The recogniser is the only
// component that holds all four facts a language-lesson subtitle needs — the
// source text, the translation, the speaker and both language codes — and
// anything it does not attach here is unrecoverable downstream.
export function buildCaptionLine(args: {
  // What the listener reads.
  translated: string;
  // What was actually said, verbatim.
  source: string;
  sourceLanguage: string;
  targetLanguage: string;
  speakerIdentity: string;
  listenerIdentity: string;
  // Monotonic within the publisher; see captionLineId.
  seq: number;
  now: number;
}): CaptionLine {
  const line: CaptionLine = {
    t: "line",
    for: args.listenerIdentity,
    id: captionLineId(args.speakerIdentity, args.now, args.seq),
    text: args.translated,
    from: args.speakerIdentity,
    lang: args.targetLanguage,
    srcLang: args.sourceLanguage,
  };
  const src = args.source.trim();
  // Omit `src` when the translation came back identical to what was said —
  // routine when the speaker briefly uses the listener's own language, or
  // when both share one. Sending it would stack the same sentence twice in
  // the band's two-line layout. Case-insensitive because the only difference
  // is often capitalisation, and that is not two languages.
  if (src && src.toLowerCase() !== args.translated.trim().toLowerCase()) line.src = src;
  return line;
}

// Unique per receiver's feed, which keys lines by id so a redelivery replaces
// rather than stacks. The speaker is part of it because two browsers can now
// produce lines for the same viewer — her own recogniser (for the other
// person's speech) and the other person's — and a clock-and-counter id from
// each could collide. The counter separates two lines finalised in the same
// millisecond.
export function captionLineId(speakerIdentity: string, now: number, seq: number): string {
  return `${speakerIdentity}:${now}-${seq}`;
}
