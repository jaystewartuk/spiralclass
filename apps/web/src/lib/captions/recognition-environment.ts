import { canRecognizeDuringCall, type RecognitionEnvironment } from "@spiralclass/shared";
import type { MediaRecorderCtorLike, WebSocketCtorLike } from "@/lib/captions/cloud-recognizer";
import type { SpeechRecognitionCtorLike, TranslatorApiLike } from "@/lib/captions/recognizer";

// Reading the browser for live captions (D-185): which speech and translation
// APIs exist, and whether this browser can recognise during a call. The
// decision itself is canRecognizeDuringCall in @spiralclass/shared; this is
// only the gathering, with `window` passed in so a test can describe any
// browser.

type BrowserLike = {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
  Translator?: unknown;
  WebSocket?: unknown;
  MediaRecorder?: unknown;
  navigator?: {
    userAgent?: string;
    userAgentData?: { mobile?: boolean; brands?: { brand: string }[] };
  };
};

export function speechRecognitionCtor(win: BrowserLike): SpeechRecognitionCtorLike | null {
  const ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as SpeechRecognitionCtorLike) : null;
}

export function translatorApi(win: BrowserLike): TranslatorApiLike | null {
  const api = win.Translator as TranslatorApiLike | undefined;
  return api && typeof api.availability === "function" && typeof api.create === "function"
    ? api
    : null;
}

// What the cloud fallback streams with (cloud-recognizer.ts). Both exist in
// every current browser; null only where one does not, and the fallback then
// gives up as unsupported rather than throwing mid-call.
export function webSocketCtor(win: BrowserLike): WebSocketCtorLike | null {
  return typeof win.WebSocket === "function" ? (win.WebSocket as WebSocketCtorLike) : null;
}

export function mediaRecorderCtor(win: BrowserLike): MediaRecorderCtorLike | null {
  return typeof win.MediaRecorder === "function"
    ? (win.MediaRecorder as MediaRecorderCtorLike)
    : null;
}

// Phones and tablets, from the Client Hints bit where the browser has it and
// the user agent otherwise. An iPad reporting a desktop Safari user agent is
// not Chromium, so it is excluded by the engine check anyway.
const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile/i;

export function recognitionEnvironment(win: BrowserLike): RecognitionEnvironment {
  const ctor = speechRecognitionCtor(win);
  const uaData = win.navigator?.userAgentData;
  return {
    hasRecognition: ctor !== null,
    hasOnDeviceApi: typeof ctor?.available === "function",
    // userAgentData only exists in Chromium, and lists "Chromium" in brands.
    chromium: Boolean(uaData?.brands?.some((b) => b.brand === "Chromium")),
    mobile: uaData?.mobile ?? MOBILE_UA.test(win.navigator?.userAgent ?? ""),
  };
}

export function browserCanRecognizeDuringCall(win: BrowserLike): boolean {
  return canRecognizeDuringCall(recognitionEnvironment(win));
}
