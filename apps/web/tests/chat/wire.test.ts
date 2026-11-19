import type { Message } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #73: a message deleted for everyone before the fix still carries its image
// or file storage path in production. The wire must not hand the other person
// a working link (or the document's name) for it, whatever the row says.

const mintImage = vi.fn(async (p: string) => `https://r2.test/image/${p}`);
const mintFile = vi.fn(async (p: string) => `https://r2.test/file/${p}`);
const mintAudio = vi.fn(async (p: string) => `https://r2.test/audio/${p}`);
const mintVideo = vi.fn(async (p: string) => `https://r2.test/video/${p}`);

vi.mock("@/lib/storage/chat-image", () => ({
  mintChatImageSignedUrl: (p: string) => mintImage(p),
}));
vi.mock("@/lib/storage/chat-file", () => ({ mintChatFileSignedUrl: (p: string) => mintFile(p) }));
vi.mock("@/lib/storage/chat-audio", () => ({
  mintChatAudioSignedUrl: (p: string) => mintAudio(p),
}));
vi.mock("@/lib/storage/chat-video", () => ({
  mintChatVideoSignedUrl: (p: string) => mintVideo(p),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    messageReaction: { findMany: async () => [] },
    message: { findUnique: async () => null },
  },
}));

const { toChatWireMessage } = await import("@/lib/chat/wire");

function message(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    teacherId: "t1",
    studentId: "s1",
    senderRole: "student",
    body: null,
    voiceStoragePath: null,
    voiceDurationMs: null,
    videoStoragePath: null,
    videoDurationMs: null,
    imageStoragePath: "t1/s1/photo.jpg",
    imageWidth: 1200,
    imageHeight: 800,
    fileStoragePath: "t1/s1/statement.pdf",
    fileName: "bank-statement.pdf",
    fileSizeBytes: 48_000,
    fileMimeType: "application/pdf",
    createdAt: new Date("2026-11-01T10:00:00Z"),
    readAt: null,
    editedAt: null,
    deletedAt: null,
    replyToId: null,
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("toChatWireMessage", () => {
  it("carries no link or file details for a deleted message that still has storage paths", async () => {
    const wire = await toChatWireMessage(
      message({
        deletedAt: new Date("2026-11-01T10:05:00Z"),
        voiceStoragePath: "t1/s1/v.webm",
        voiceDurationMs: 3000,
        videoStoragePath: "t1/s1/c.mp4",
        videoDurationMs: 5000,
      }),
    );

    expect(wire).toMatchObject({
      imageUrl: null,
      imageWidth: null,
      imageHeight: null,
      fileUrl: null,
      fileName: null,
      fileSizeBytes: null,
      fileMimeType: null,
      voiceUrl: null,
      videoUrl: null,
    });
    expect(mintImage).not.toHaveBeenCalled();
    expect(mintFile).not.toHaveBeenCalled();
    expect(mintAudio).not.toHaveBeenCalled();
    expect(mintVideo).not.toHaveBeenCalled();
  });

  it("still links a live message's photo and document", async () => {
    const wire = await toChatWireMessage(message());

    expect(wire.imageUrl).toBe("https://r2.test/image/t1/s1/photo.jpg");
    expect(wire.fileUrl).toBe("https://r2.test/file/t1/s1/statement.pdf");
    expect(wire.fileName).toBe("bank-statement.pdf");
  });
});
