import { describe, expect, it, vi } from "vitest";

// message_sent — the shared trackMessageSent() call site all 20 chat send
// routes (text/voice/video/image/file × teacher/student × web/mobile) use.

const trackServerEventMock = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent: trackServerEventMock }));

const { trackMessageSent } = await import("@/lib/chat/analytics");

describe("trackMessageSent", () => {
  it("keys distinctId + recipientType off the teacher sending", () => {
    trackMessageSent({
      teacherId: "t1",
      studentId: "s1",
      senderRole: "teacher",
      hasAttachment: false,
    });
    expect(trackServerEventMock).toHaveBeenCalledWith({
      name: "message_sent",
      distinctId: "t1",
      properties: {
        teacherId: "t1",
        conversationId: "t1:s1",
        recipientType: "student",
        hasAttachment: false,
      },
    });
  });

  it("keys distinctId + recipientType off the student sending", () => {
    trackMessageSent({
      teacherId: "t1",
      studentId: "s1",
      senderRole: "student",
      hasAttachment: true,
    });
    expect(trackServerEventMock).toHaveBeenCalledWith({
      name: "message_sent",
      distinctId: "s1",
      properties: {
        teacherId: "t1",
        conversationId: "t1:s1",
        recipientType: "teacher",
        hasAttachment: true,
      },
    });
  });
});
