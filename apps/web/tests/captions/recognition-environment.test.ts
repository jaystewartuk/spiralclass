import { describe, expect, it } from "vitest";
import {
  browserCanRecognizeDuringCall,
  recognitionEnvironment,
  speechRecognitionCtor,
  translatorApi,
} from "@/lib/captions/recognition-environment";

// Reading a browser into the booleans canRecognizeDuringCall decides on. The
// user agents here are the real ones from the Phase 0 devices.

function SR() {}
SR.available = async () => "available";
function OldSR() {}

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";
const chromium = [{ brand: "Chromium" }, { brand: "Google Chrome" }];

describe("recognitionEnvironment", () => {
  it("reads desktop Chrome as able to recognise during a call", () => {
    const win = {
      SpeechRecognition: SR,
      Translator: { availability: async () => "", create: async () => ({}) },
      navigator: { userAgent: CHROME_MAC, userAgentData: { mobile: false, brands: chromium } },
    };
    expect(recognitionEnvironment(win)).toEqual({
      hasRecognition: true,
      hasOnDeviceApi: true,
      chromium: true,
      mobile: false,
    });
    expect(browserCanRecognizeDuringCall(win)).toBe(true);
  });

  it("reads Android Chrome as unable, whatever APIs it exposes", () => {
    const win = {
      SpeechRecognition: SR,
      navigator: { userAgent: CHROME_ANDROID, userAgentData: { mobile: true, brands: chromium } },
    };
    expect(browserCanRecognizeDuringCall(win)).toBe(false);
  });

  it("falls back to the user agent for mobile when Client Hints are absent", () => {
    expect(recognitionEnvironment({ navigator: { userAgent: CHROME_ANDROID } }).mobile).toBe(true);
    expect(recognitionEnvironment({ navigator: { userAgent: CHROME_MAC } }).mobile).toBe(false);
  });

  it("reads Safari, with only the prefixed API and no Client Hints, as unable", () => {
    const win = { webkitSpeechRecognition: OldSR, navigator: { userAgent: SAFARI_MAC } };
    expect(recognitionEnvironment(win)).toMatchObject({
      hasRecognition: true,
      hasOnDeviceApi: false,
      chromium: false,
    });
    expect(browserCanRecognizeDuringCall(win)).toBe(false);
  });

  it("copes with a bare window", () => {
    expect(browserCanRecognizeDuringCall({})).toBe(false);
  });
});

describe("speechRecognitionCtor / translatorApi", () => {
  it("prefers the unprefixed constructor and ignores non-functions", () => {
    expect(speechRecognitionCtor({ SpeechRecognition: SR, webkitSpeechRecognition: OldSR })).toBe(
      SR,
    );
    expect(speechRecognitionCtor({ webkitSpeechRecognition: OldSR })).toBe(OldSR);
    expect(speechRecognitionCtor({ SpeechRecognition: {} })).toBeNull();
  });

  it("accepts a Translator only with both methods", () => {
    const api = { availability: async () => "", create: async () => ({}) };
    expect(translatorApi({ Translator: api })).toBe(api);
    expect(translatorApi({ Translator: { availability: async () => "" } })).toBeNull();
    expect(translatorApi({})).toBeNull();
  });
});
