import { afterEach, describe, expect, it, vi } from "vitest";

// The SIZE-CAP and OBJECT-EXISTENCE half of chat attachment finalize.
//
// Deliberately scoped: tests/storage/chat-media.test.ts already covers the
// path-validation half (thread prefix, traversal, nesting, disallowed
// extensions, cross-prefix confusion) and the presigners' content-type
// handling. This file does NOT re-litigate any of that. What had no coverage
// at all is what happens AFTER the path passes:
//
//   * the R2 HEAD — does the object the client claims to have uploaded
//     actually exist, or would we persist a message row pointing at nothing
//   * the per-kind byte cap, including its exact boundary
//
// The caps are the part most likely to break silently.
// `validateChatMediaUpload` picks a validator, a HEAD function AND a cap from
// three parallel Records keyed by the same kind. One mis-keyed entry — the
// image row reaching for MAX_VIDEO_BYTES, say — reads as correct at a glance
// and widens a limit tenfold, so every kind is asserted against its own cap
// rather than one representative kind standing in for the rest.

const heads = vi.hoisted(() => ({
  audio: vi.fn<(p: string) => Promise<number | null>>(),
  video: vi.fn<(p: string) => Promise<number | null>>(),
  image: vi.fn<(p: string) => Promise<number | null>>(),
  file: vi.fn<(p: string) => Promise<number | null>>(),
}));
const presigns = vi.hoisted(() => ({
  audio: vi.fn(() => ({ uploadUrl: "u-audio", storagePath: "p-audio" })),
  video: vi.fn(() => ({ uploadUrl: "u-video", storagePath: "p-video" })),
  image: vi.fn(() => ({ uploadUrl: "u-image", storagePath: "p-image" })),
  file: vi.fn(() => ({ uploadUrl: "u-file", storagePath: "p-file" })),
}));

// Only the R2 round trip and the presigners are stubbed. The path validators
// and the cap CONSTANTS stay real — stubbing the caps would leave these tests
// asserting their own fixtures.
vi.mock("@/lib/storage/chat-audio", async (actual) => ({
  ...(await actual<typeof import("@/lib/storage/chat-audio")>()),
  headChatAudioObject: heads.audio,
  presignChatAudioUpload: presigns.audio,
}));
vi.mock("@/lib/storage/chat-video", async (actual) => ({
  ...(await actual<typeof import("@/lib/storage/chat-video")>()),
  headChatVideoObject: heads.video,
  presignChatVideoUpload: presigns.video,
}));
vi.mock("@/lib/storage/chat-image", async (actual) => ({
  ...(await actual<typeof import("@/lib/storage/chat-image")>()),
  headChatImageObject: heads.image,
  presignChatImageUpload: presigns.image,
}));
vi.mock("@/lib/storage/chat-file", async (actual) => ({
  ...(await actual<typeof import("@/lib/storage/chat-file")>()),
  headChatFileObject: heads.file,
  presignChatFileUpload: presigns.file,
}));

import { presignChatMedia, validateChatMediaUpload } from "@/lib/storage/chat-media";
import { MAX_AUDIO_BYTES } from "@/lib/storage/chat-audio";
import { MAX_VIDEO_BYTES } from "@/lib/storage/chat-video";
import { MAX_IMAGE_BYTES } from "@/lib/storage/chat-image";
import { MAX_FILE_BYTES } from "@/lib/storage/chat-file";

const T = "teacher-1";
const S = "student-1";

// Well-formed paths, copied from each module's own presigner. Note the
// asymmetry: voice has NO kind prefix because chat audio lives in its own
// bucket, while video/image/file are prefixed inside a shared one.
const PATHS = {
  voice: `${T}/${S}/1700000000.webm`,
  video: `video/${T}/${S}/1700000000.mp4`,
  image: `image/${T}/${S}/1700000000.jpg`,
  file: `file/${T}/${S}/1700000000.pdf`,
} as const;

const KINDS = [
  { kind: "voice" as const, head: heads.audio, max: MAX_AUDIO_BYTES },
  { kind: "video" as const, head: heads.video, max: MAX_VIDEO_BYTES },
  { kind: "image" as const, head: heads.image, max: MAX_IMAGE_BYTES },
  { kind: "file" as const, head: heads.file, max: MAX_FILE_BYTES },
];

afterEach(() => vi.clearAllMocks());

describe("validateChatMediaUpload — the object must actually exist", () => {
  it.each(KINDS)("$kind: reports not-uploaded when HEAD finds nothing", async ({ kind, head }) => {
    // Without this, finalize persists a message row pointing at an object that
    // was never uploaded — a permanently broken attachment in the thread.
    head.mockResolvedValue(null);

    expect(await validateChatMediaUpload(kind, PATHS[kind], T, S)).toEqual({
      ok: false,
      reason: "not-uploaded",
    });
  });

  it.each(KINDS)(
    "$kind: HEADs the exact path supplied, via its own prober",
    async ({ kind, head }) => {
      head.mockResolvedValue(10);

      await validateChatMediaUpload(kind, PATHS[kind], T, S);

      expect(head).toHaveBeenCalledWith(PATHS[kind]);
      // No cross-talk between the four probers.
      Object.values(heads)
        .filter((h) => h !== head)
        .forEach((h) => expect(h).not.toHaveBeenCalled());
    },
  );

  it("treats a zero-byte object as uploaded — null, not 0, is the missing signal", async () => {
    // A truthiness check here would misreport an empty upload as never-uploaded
    // and give the user a confusing failure instead of an empty file.
    heads.file.mockResolvedValue(0);

    expect(await validateChatMediaUpload("file", PATHS.file, T, S)).toEqual({ ok: true });
  });
});

describe("validateChatMediaUpload — each kind enforces its OWN cap", () => {
  it.each(KINDS)("$kind: accepts an object exactly AT the cap", async ({ kind, head, max }) => {
    // The check is `size > max`, so the cap itself is allowed. Pinning the
    // boundary stops a later `>=` from silently shrinking every limit by a byte.
    head.mockResolvedValue(max);

    expect(await validateChatMediaUpload(kind, PATHS[kind], T, S)).toEqual({ ok: true });
  });

  it.each(KINDS)("$kind: rejects one byte OVER its cap", async ({ kind, head, max }) => {
    head.mockResolvedValue(max + 1);

    expect(await validateChatMediaUpload(kind, PATHS[kind], T, S)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("does not let an image borrow the much larger video cap", async () => {
    // The concrete mis-keyed-Record failure: images cap at 10 MB, video at
    // 100 MB. If the image row ever pointed at MAX_VIDEO_BYTES this is the
    // assertion that notices.
    expect(MAX_IMAGE_BYTES).toBeLessThan(MAX_VIDEO_BYTES);
    heads.image.mockResolvedValue(MAX_IMAGE_BYTES + 1);

    expect(await validateChatMediaUpload("image", PATHS.image, T, S)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("does not let a voice note borrow the larger file cap", async () => {
    expect(MAX_AUDIO_BYTES).toBeLessThan(MAX_FILE_BYTES);
    heads.audio.mockResolvedValue(MAX_AUDIO_BYTES + 1);

    expect(await validateChatMediaUpload("voice", PATHS.voice, T, S)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });
});

describe("presignChatMedia — dispatches to exactly one presigner", () => {
  it.each([
    ["voice", presigns.audio],
    ["video", presigns.video],
    ["image", presigns.image],
    ["file", presigns.file],
  ] as const)("%s uses its own presigner and no other", (kind, presigner) => {
    presignChatMedia(kind, T, S, "application/pdf", 1700000000);

    expect(presigner).toHaveBeenCalledWith(T, S, "application/pdf", 1700000000);
    Object.values(presigns)
      .filter((p) => p !== presigner)
      .forEach((p) => expect(p).not.toHaveBeenCalled());
  });

  it("passes the caller's timestamp through rather than reading the clock", () => {
    // The storage path embeds the timestamp; taking it as a parameter is what
    // makes the presign deterministic and testable at all.
    presignChatMedia("file", T, S, "application/pdf", 42);

    expect(presigns.file).toHaveBeenCalledWith(T, S, "application/pdf", 42);
  });

  it("surfaces a presigner's error result unchanged", () => {
    presigns.file.mockReturnValueOnce({ error: "bad-type" } as never);

    expect(presignChatMedia("file", T, S, "application/x-evil", 1)).toEqual({ error: "bad-type" });
  });
});
