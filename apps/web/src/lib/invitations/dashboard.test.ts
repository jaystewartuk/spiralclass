import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { buildInvitationDashboard } from "./dashboard";

// Issue #85: the teacher's invitation list must say when an invite did not
// arrive, which it learns from the latest `invitation` notifications row the
// send left and the delivery webhook updated.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-16T12:00:00Z");
const LATER = new Date("2026-12-01T00:00:00Z");

type NotifRow = {
  teacherId: string;
  recipientType: string;
  templateName: string;
  status: string;
  metadata: unknown;
  createdAt: Date;
};

function fakeDb(input: {
  students: Array<{ id: string; email: string }>;
  invitations: Array<{ id: string; studentId: string; email: string }>;
  notifications: NotifRow[];
}) {
  const db = {
    teacherStudent: {
      findMany: async () =>
        input.students.map((s) => ({
          createdAt: NOW,
          student: { id: s.id, name: s.id, email: s.email, authUserId: null },
        })),
    },
    studentInvitation: {
      findMany: async () =>
        input.invitations.map((i) => ({
          ...i,
          teacherId: TEACHER_ID,
          status: "pending",
          expiresAt: LATER,
          createdAt: NOW,
          acceptedAt: null,
          lastSentAt: NOW,
        })),
    },
    notification: {
      findMany: async ({
        where,
      }: {
        where: { teacherId: string; recipientType: string; templateName: string };
      }) =>
        input.notifications
          .filter(
            (n) =>
              n.teacherId === where.teacherId &&
              n.recipientType === where.recipientType &&
              n.templateName === where.templateName,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    },
  };
  return db as unknown as PrismaClient;
}

function inviteRow(invitationId: string, status: string, createdAt: Date): NotifRow {
  return {
    teacherId: TEACHER_ID,
    recipientType: "student",
    templateName: "invitation",
    status,
    metadata: { invitationId },
    createdAt,
  };
}

describe("buildInvitationDashboard delivery", () => {
  it("flags a pending invitation whose latest send bounced", async () => {
    const db = fakeDb({
      students: [
        { id: "s-bounced", email: "typo@exmaple.com" },
        { id: "s-ok", email: "ok@example.com" },
      ],
      invitations: [
        { id: "inv-bounced", studentId: "s-bounced", email: "typo@exmaple.com" },
        { id: "inv-ok", studentId: "s-ok", email: "ok@example.com" },
      ],
      notifications: [
        inviteRow("inv-bounced", "failed", NOW),
        inviteRow("inv-ok", "delivered", NOW),
      ],
    });
    const { rows } = await buildInvitationDashboard(TEACHER_ID, db, NOW);
    const byId = Object.fromEntries(rows.map((r) => [r.studentId, r]));
    expect(byId["s-bounced"]?.undeliveredTo).toBe("typo@exmaple.com");
    expect(byId["s-bounced"]?.state).toBe("pending");
    expect(byId["s-ok"]?.undeliveredTo).toBeNull();
  });

  it("clears the flag once a newer resend has not bounced", async () => {
    const db = fakeDb({
      students: [{ id: "s1", email: "s1@example.com" }],
      invitations: [{ id: "inv-1", studentId: "s1", email: "s1@example.com" }],
      notifications: [
        inviteRow("inv-1", "failed", new Date("2026-11-10T00:00:00Z")),
        inviteRow("inv-1", "sent", new Date("2026-11-15T00:00:00Z")),
      ],
    });
    const { rows } = await buildInvitationDashboard(TEACHER_ID, db, NOW);
    expect(rows[0]?.undeliveredTo).toBeNull();
  });

  it("does not flag an invitation with no send record (sent before records existed)", async () => {
    const db = fakeDb({
      students: [{ id: "s1", email: "s1@example.com" }],
      invitations: [{ id: "inv-1", studentId: "s1", email: "s1@example.com" }],
      notifications: [],
    });
    const { rows } = await buildInvitationDashboard(TEACHER_ID, db, NOW);
    expect(rows[0]?.undeliveredTo).toBeNull();
  });
});
