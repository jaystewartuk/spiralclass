import { trackServerEvent } from "@/lib/analytics/posthog";

// message_sent — one call site shared by every chat send route (text, voice,
// video, image, file; teacher + student; under api/chat/**).
// No Conversation model exists in this schema — a thread is
// implicitly the (teacherId, studentId) pair — so conversationId is a stable
// synthetic id built from that pair, not a real row id.
export function trackMessageSent(params: {
  teacherId: string;
  studentId: string;
  senderRole: "teacher" | "student";
  hasAttachment: boolean;
}): void {
  const { teacherId, studentId, senderRole, hasAttachment } = params;
  trackServerEvent({
    name: "message_sent",
    distinctId: senderRole === "teacher" ? teacherId : studentId,
    properties: {
      teacherId,
      conversationId: `${teacherId}:${studentId}`,
      recipientType: senderRole === "teacher" ? "student" : "teacher",
      hasAttachment,
    },
  });
}
