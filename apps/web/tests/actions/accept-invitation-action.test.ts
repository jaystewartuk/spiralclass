import { beforeEach, describe, expect, it, vi } from "vitest";

// acceptInvitationAction's time-to-acceptance read (D-175 / #62). After an
// acceptance it reads the invitation's `sentAt` for the funnel event. That read
// used to name only the invitation id; it now names the teacher the acceptance
// resolved from the token, so it can only ever report on that teacher's own
// invitation.

const TEACHER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TEACHER_ID = "11111111-1111-4111-8111-bbbbbbbbbbbb";
const STUDENT_ID = "22222222-2222-4222-8222-222222222222";
const INVITATION_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_INVITATION_ID = "33333333-3333-4333-8333-bbbbbbbbbbbb";

const SENT_AT = new Date(Date.now() - 90 * 60_000); // 90 minutes ago

// Invitation rows, id → owner and send time. findUnique follows Prisma: an
// absent (or `undefined`) teacherId is no filter at all, a present one must
// match the row.
const invitations = new Map<string, { teacherId: string; sentAt: Date }>();
let latestAcceptedId = INVITATION_ID;

const findUnique = vi.fn(async ({ where }: { where: { id: string; teacherId?: string } }) => {
  const row = invitations.get(where.id);
  if (!row || (where.teacherId !== undefined && row.teacherId !== where.teacherId)) return null;
  return { sentAt: row.sentAt };
});
const findFirst = vi.fn(async () => ({ id: latestAcceptedId }));

vi.mock("@/lib/prisma", () => ({
  prisma: { studentInvitation: { findUnique, findFirst } },
}));
vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(),
  getAuthUser: vi.fn(async () => ({ id: "user-1", email: "ana@example.com" })),
}));
vi.mock("@/lib/invitations/accept", () => ({
  acceptInvitation: vi.fn(async () => ({
    status: "accepted",
    alreadyAccepted: false,
    existingAccount: false,
    teacherId: TEACHER_ID,
    studentId: STUDENT_ID,
    linkedStudentId: STUDENT_ID,
  })),
}));
const trackServerEvent = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: (...args: unknown[]) => trackServerEvent(...args),
  flushAnalytics: vi.fn(async () => {}),
}));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "en") }));
vi.mock("@/lib/revalidate", () => ({ revalidateAfterAction: vi.fn() }));

const { acceptInvitationAction } = await import("@/app/actions/invitations");

function tokenForm(): FormData {
  const f = new FormData();
  f.set("token", "tok");
  return f;
}

const minutesToAccept = () =>
  (trackServerEvent.mock.calls[0]?.[0] as { properties: { minutesToAccept?: number } }).properties
    .minutesToAccept;

beforeEach(() => {
  vi.clearAllMocks();
  invitations.clear();
  invitations.set(INVITATION_ID, { teacherId: TEACHER_ID, sentAt: SENT_AT });
  invitations.set(OTHER_INVITATION_ID, { teacherId: OTHER_TEACHER_ID, sentAt: new Date(0) });
  latestAcceptedId = INVITATION_ID;
});

describe("acceptInvitationAction's time-to-acceptance read", () => {
  it("names the teacher the acceptance resolved", async () => {
    const res = await acceptInvitationAction(undefined, tokenForm());
    expect(res).toEqual({ status: "accepted", redirect: "/my-classes" });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: INVITATION_ID, teacherId: TEACHER_ID },
      select: { sentAt: true },
    });
    expect(minutesToAccept()).toBe(90);
  });

  it("never reads another teacher's invitation, even if the id lookup returned one", async () => {
    // The id lookup is forced to name another teacher's invitation, standing in
    // for one that is later loosened — the read is the last line. The funnel
    // event still fires; it just carries no time-to-accept.
    latestAcceptedId = OTHER_INVITATION_ID;
    const res = await acceptInvitationAction(undefined, tokenForm());
    expect(res).toEqual({ status: "accepted", redirect: "/my-classes" });
    expect(minutesToAccept()).toBeUndefined();
  });
});
