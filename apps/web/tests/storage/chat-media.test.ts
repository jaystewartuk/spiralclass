import { beforeAll, describe, expect, it } from "vitest";
import { isChatAudioPath, presignChatAudioUpload } from "@/lib/storage/chat-audio";
import { isChatVideoPath, presignChatVideoUpload } from "@/lib/storage/chat-video";
import { isChatImagePath, presignChatImageUpload } from "@/lib/storage/chat-image";
import { isChatFilePath, presignChatFileUpload } from "@/lib/storage/chat-file";
import { presignChatMedia, validateChatMediaUpload } from "@/lib/storage/chat-media";

const TEACHER = "t1";
const STUDENT = "s1";

// Fake R2 config so presign (a pure SigV4 URL build — no network) can run.
beforeAll(() => {
  process.env.CHAT_AUDIO_R2_BUCKET = "chat-media";
  process.env.CHAT_AUDIO_R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.CHAT_AUDIO_R2_ACCESS_KEY = "AKIATEST";
  process.env.CHAT_AUDIO_R2_SECRET = "secretkey";
  process.env.CHAT_AUDIO_R2_REGION = "auto";
});

describe("chat media path validation", () => {
  it("accepts an in-thread audio path with an allowed extension", () => {
    expect(isChatAudioPath(`${TEACHER}/${STUDENT}/123.m4a`, TEACHER, STUDENT)).toBe(true);
  });

  it("accepts an in-thread video path under the video/ prefix", () => {
    expect(isChatVideoPath(`video/${TEACHER}/${STUDENT}/123.mp4`, TEACHER, STUDENT)).toBe(true);
  });

  it("rejects another thread's prefix (no cross-thread attach)", () => {
    expect(isChatAudioPath(`other/${STUDENT}/123.m4a`, TEACHER, STUDENT)).toBe(false);
    expect(isChatAudioPath(`${TEACHER}/evil/123.m4a`, TEACHER, STUDENT)).toBe(false);
  });

  it("rejects path traversal and nesting", () => {
    expect(isChatAudioPath(`${TEACHER}/${STUDENT}/../x.m4a`, TEACHER, STUDENT)).toBe(false);
    expect(isChatAudioPath(`${TEACHER}/${STUDENT}/sub/x.m4a`, TEACHER, STUDENT)).toBe(false);
  });

  it("rejects a disallowed extension", () => {
    expect(isChatAudioPath(`${TEACHER}/${STUDENT}/123.exe`, TEACHER, STUDENT)).toBe(false);
    expect(isChatVideoPath(`video/${TEACHER}/${STUDENT}/123.m4a`, TEACHER, STUDENT)).toBe(false);
  });

  it("audio guard rejects a video-prefixed path and vice versa", () => {
    expect(isChatAudioPath(`video/${TEACHER}/${STUDENT}/1.mp4`, TEACHER, STUDENT)).toBe(false);
    expect(isChatVideoPath(`${TEACHER}/${STUDENT}/1.m4a`, TEACHER, STUDENT)).toBe(false);
  });

  it("accepts an in-thread image path under the image/ prefix", () => {
    expect(isChatImagePath(`image/${TEACHER}/${STUDENT}/123.jpg`, TEACHER, STUDENT)).toBe(true);
  });

  it("accepts an in-thread file path under the file/ prefix", () => {
    expect(isChatFilePath(`file/${TEACHER}/${STUDENT}/123.pdf`, TEACHER, STUDENT)).toBe(true);
  });

  it("image/file guards reject cross-prefix paths and disallowed extensions", () => {
    expect(isChatImagePath(`file/${TEACHER}/${STUDENT}/1.jpg`, TEACHER, STUDENT)).toBe(false);
    expect(isChatFilePath(`image/${TEACHER}/${STUDENT}/1.pdf`, TEACHER, STUDENT)).toBe(false);
    expect(isChatImagePath(`image/${TEACHER}/${STUDENT}/1.exe`, TEACHER, STUDENT)).toBe(false);
    // No executables/scripts in the document allowlist.
    expect(isChatFilePath(`file/${TEACHER}/${STUDENT}/1.exe`, TEACHER, STUDENT)).toBe(false);
    expect(isChatFilePath(`file/${TEACHER}/${STUDENT}/1.sh`, TEACHER, STUDENT)).toBe(false);
  });
});

describe("presign", () => {
  it("mints a PUT URL + server-chosen storage path scoped to the thread", () => {
    const r = presignChatAudioUpload(TEACHER, STUDENT, "audio/mp4", 1717171717);
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error(r.error);
    expect(r.storagePath).toBe(`${TEACHER}/${STUDENT}/1717171717.m4a`);
    expect(r.uploadUrl).toContain("acct.r2.cloudflarestorage.com");
    expect(r.uploadUrl).toContain("/chat-media/");
    expect(r.uploadUrl).toContain("X-Amz-Signature=");
  });

  it("video presign lands under the video/ prefix", () => {
    const r = presignChatVideoUpload(TEACHER, STUDENT, "video/mp4", 42);
    if ("error" in r) throw new Error(r.error);
    expect(r.storagePath).toBe(`video/${TEACHER}/${STUDENT}/42.mp4`);
  });

  it("rejects an unknown content type", () => {
    expect(presignChatMedia("voice", TEACHER, STUDENT, "application/zip", 1)).toEqual({
      error: "bad-type",
    });
  });

  it("image presign lands under the image/ prefix", () => {
    const r = presignChatImageUpload(TEACHER, STUDENT, "image/png", 7);
    if ("error" in r) throw new Error(r.error);
    expect(r.storagePath).toBe(`image/${TEACHER}/${STUDENT}/7.png`);
  });

  it("file presign lands under the file/ prefix", () => {
    const r = presignChatFileUpload(TEACHER, STUDENT, "application/pdf", 9);
    if ("error" in r) throw new Error(r.error);
    expect(r.storagePath).toBe(`file/${TEACHER}/${STUDENT}/9.pdf`);
  });

  it("rejects an executable content type for the file kind", () => {
    expect(presignChatMedia("file", TEACHER, STUDENT, "application/x-msdownload", 1)).toEqual({
      error: "bad-type",
    });
  });
});

describe("validateChatMediaUpload", () => {
  it("rejects a bad path before touching R2 (no HEAD)", async () => {
    const res = await validateChatMediaUpload("voice", "evil/path.m4a", TEACHER, STUDENT);
    expect(res).toEqual({ ok: false, reason: "bad-path" });
  });
});
