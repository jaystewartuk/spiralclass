import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #85: both invitation send paths — the first send (sendInvitations) and
// the resend action — must hand sendInvitationEmail who the send belongs to,
// so it can leave the notifications row the delivery webhook updates.

const TEACHER = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Mira",
  photoPath: null,
  updatedAt: new Date("2026-11-01T00:00:00Z"),
  locale: "es",
};
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const INVITATION_ID = "33333333-3333-4333-8333-333333333333";

const sendInvitationEmail = vi.fn();
const markInvitationSent = vi.fn(async () => {});
const discardUnsentInvitation = vi.fn(async () => {});
const provisionInvitation = vi.fn();
const rotateInvitationForResend = vi.fn();

vi.mock("@/lib/invitations/send", () => ({
  sendInvitationEmail,
  invitationEmailLocale: (s: string | null, t: string) => s ?? t,
  invitationAcceptUrl: (tok: string) => `https://x.test/i/${tok}`,
}));
vi.mock("@/lib/invitations/manage", () => ({
  markInvitationSent,
  discardUnsentInvitation,
  provisionInvitation,
  rotateInvitationForResend,
  cancelInvitation: vi.fn(),
}));
vi.mock("@/lib/storage/teacher-photo", () => ({ teacherPhotoPublicUrl: () => null }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => TEACHER),
  getAuthUser: vi.fn(),
}));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: vi.fn(),
  flushAnalytics: vi.fn(async () => {}),
}));
vi.mock("@/lib/revalidate", () => ({ revalidateAfterAction: vi.fn() }));

const { sendInvitations } = await import("@/lib/invitations/service");
const { resendInvitationAction } = await import("@/app/actions/invitations");

beforeEach(() => {
  vi.clearAllMocks();
  sendInvitationEmail.mockResolvedValue({ providerMessageId: "re_1" });
});

describe("sendInvitations", () => {
  it("passes the send's owner and the db to sendInvitationEmail", async () => {
    provisionInvitation.mockResolvedValue({
      status: "created",
      rawToken: "tok",
      studentLocale: "en",
      invitation: { id: INVITATION_ID, studentId: STUDENT_ID },
    });
    const db = { marker: true } as never;
    const { summary } = await sendInvitations(
      TEACHER as never,
      [{ email: "s@example.com", name: "Sam" } as never],
      db,
    );

    expect(summary.sent).toBe(1);
    expect(sendInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "s@example.com",
        record: { teacherId: TEACHER.id, studentId: STUDENT_ID, invitationId: INVITATION_ID },
      }),
      db,
    );
    expect(markInvitationSent).toHaveBeenCalledWith(INVITATION_ID, { resend: false }, db);
  });

  it("discards the invitation when the provider rejects the send", async () => {
    provisionInvitation.mockResolvedValue({
      status: "created",
      rawToken: "tok",
      studentLocale: null,
      invitation: { id: INVITATION_ID, studentId: STUDENT_ID },
    });
    sendInvitationEmail.mockRejectedValue(new Error("invitation-email-send-failed"));
    const db = {} as never;
    const { summary } = await sendInvitations(
      TEACHER as never,
      [{ email: "s@example.com", name: null } as never],
      db,
    );
    expect(summary.failed).toBe(1);
    expect(discardUnsentInvitation).toHaveBeenCalledWith(INVITATION_ID, db);
    expect(markInvitationSent).not.toHaveBeenCalled();
  });
});

describe("resendInvitationAction", () => {
  function form() {
    const fd = new FormData();
    fd.set("invitationId", INVITATION_ID);
    return fd;
  }

  it("records the resend against the invitation's student", async () => {
    rotateInvitationForResend.mockResolvedValue({
      status: "rotated",
      rawToken: "tok2",
      studentLocale: "es",
      invitation: { id: INVITATION_ID, studentId: STUDENT_ID, email: "s@example.com", name: "Sam" },
    });
    const res = await resendInvitationAction(undefined, form());

    expect(res?.ok).toBeTruthy();
    expect(sendInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "s@example.com",
        record: { teacherId: TEACHER.id, studentId: STUDENT_ID, invitationId: INVITATION_ID },
      }),
    );
    expect(markInvitationSent).toHaveBeenCalledWith(INVITATION_ID, { resend: true });
  });
});
