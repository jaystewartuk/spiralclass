import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `acceptInvitation` is, by its own file comment, "the security choke point of
// the whole flow" — and it sat at ~4% line coverage. Everything a hostile or
// confused caller can do to a student invitation converges here: replaying a
// used link, opening someone else's link while signed in as yourself, racing a
// double-accept, or arriving with a Teacher account.
//
// It is also the ACQUISITION path. A student who cannot accept an invitation
// never becomes a customer, so a regression here is silent revenue loss rather
// than a visible crash — nothing errors, the funnel just stops converting.
//
// The module takes an injectable `db`, so these are pure unit tests against a
// hand-rolled fake: no DB, runs on every push. `resolveLinkedStudent` is mocked
// (its own linking invariants are lib/auth/student-link.ts's business); the
// token and status helpers stay REAL so the tests exercise the actual hashing
// and expiry derivation rather than a restatement of them.

const resolveLinkedStudent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/student-link", () => ({ resolveLinkedStudent }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { acceptInvitation, getInvitationLanding } from "@/lib/invitations/accept";
import { hashInvitationToken } from "@/lib/invitations/token";

// 32 base64url chars — inside the real TOKEN_SHAPE the module validates against.
const RAW_TOKEN = "abcdefghijklmnopqrstuvwxyz012345";
const TEACHER_ID = "teacher-1";
const STUDENT_ID = "student-1";
const USER = { id: "user-1", email: "Student@Example.com" };

const HOUR = 60 * 60 * 1000;

type InvitationRow = {
  id: string;
  teacherId: string;
  studentId: string;
  email: string;
  status: string;
  expiresAt: Date;
  acceptedByUserId: string | null;
};

function baseInvitation(overrides: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: "inv-1",
    teacherId: TEACHER_ID,
    studentId: STUDENT_ID,
    email: "student@example.com",
    status: "pending",
    expiresAt: new Date(Date.now() + 24 * HOUR),
    acceptedByUserId: null,
    ...overrides,
  };
}

const teacherStudentUpdateMany = vi.fn(async () => ({ count: 1 }));
const invitationUpdateMany = vi.fn(async () => ({ count: 1 }));
const findUnique = vi.fn<(args: { where: { tokenHash: string } }) => Promise<unknown>>();

function fakeDb() {
  const tx = {
    teacherStudent: { updateMany: teacherStudentUpdateMany },
    studentInvitation: { updateMany: invitationUpdateMany },
  };
  return {
    studentInvitation: { findUnique },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Parameters<typeof acceptInvitation>[1];
}

beforeEach(() => {
  resolveLinkedStudent.mockResolvedValue({
    status: "linked",
    id: STUDENT_ID,
    alreadyLinked: false,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("acceptInvitation — token validation", () => {
  it("rejects a malformed token without touching the database", async () => {
    const result = await acceptInvitation({ rawToken: "short!", user: USER }, fakeDb());

    expect(result).toEqual({ status: "invalid" });
    // The point of the shape check is to avoid the round trip at all.
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("looks the invitation up by HASH, never by the raw token", async () => {
    // The raw token exists only in the email link; the DB stores the hash, so a
    // table read can't reconstruct a live link. A refactor that queried by raw
    // token would defeat that and is exactly what this pins.
    findUnique.mockResolvedValue(null);

    await acceptInvitation({ rawToken: RAW_TOKEN, user: USER }, fakeDb());

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashInvitationToken(RAW_TOKEN) } }),
    );
    const [call] = findUnique.mock.calls;
    expect(JSON.stringify(call)).not.toContain(RAW_TOKEN);
  });

  it("returns invalid for an unknown token", async () => {
    findUnique.mockResolvedValue(null);

    expect(await acceptInvitation({ rawToken: RAW_TOKEN, user: USER }, fakeDb())).toEqual({
      status: "invalid",
    });
  });
});

describe("acceptInvitation — the hijack guard", () => {
  it("refuses when the signed-in inbox differs from the invited inbox", async () => {
    findUnique.mockResolvedValue(baseInvitation());

    const result = await acceptInvitation(
      { rawToken: RAW_TOKEN, user: { id: "user-2", email: "someone.else@example.com" } },
      fakeDb(),
    );

    expect(result).toEqual({ status: "email_mismatch", invitedEmail: "student@example.com" });
    // Nothing may be linked or marked accepted on a refusal.
    expect(resolveLinkedStudent).not.toHaveBeenCalled();
    expect(invitationUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses an identity with NO email — no email, no match", async () => {
    findUnique.mockResolvedValue(baseInvitation());

    const result = await acceptInvitation(
      { rawToken: RAW_TOKEN, user: { id: "user-3", email: null } },
      fakeDb(),
    );

    expect(result).toMatchObject({ status: "email_mismatch" });
    expect(invitationUpdateMany).not.toHaveBeenCalled();
  });

  it("matches case-insensitively and ignores surrounding whitespace", async () => {
    // The invited address is stored as typed by the teacher; the signed-in one
    // comes from the auth provider. Neither side's casing should decide whether
    // a legitimate student can get in.
    findUnique.mockResolvedValue(baseInvitation({ email: "Student@Example.com" }));

    const result = await acceptInvitation(
      { rawToken: RAW_TOKEN, user: { id: "user-1", email: "  sTuDeNt@example.COM  " } },
      fakeDb(),
    );

    expect(result).toMatchObject({ status: "accepted", alreadyAccepted: false });
  });
});

describe("acceptInvitation — non-acceptable states", () => {
  it("reports cancelled", async () => {
    findUnique.mockResolvedValue(baseInvitation({ status: "cancelled" }));

    expect(await acceptInvitation({ rawToken: RAW_TOKEN, user: USER }, fakeDb())).toEqual({
      status: "cancelled",
    });
  });

  it("reports expired for a still-pending row whose window has closed", async () => {
    // Expiry is derived at read time, never written — the row is still
    // `pending` in the DB. A regression that trusted the column alone would
    // happily accept this.
    findUnique.mockResolvedValue(
      baseInvitation({ status: "pending", expiresAt: new Date(Date.now() - HOUR) }),
    );

    expect(await acceptInvitation({ rawToken: RAW_TOKEN, user: USER }, fakeDb())).toEqual({
      status: "expired",
    });
  });

  it("checks cancelled/expired BEFORE the email guard", async () => {
    // Ordering matters for what the landing page can disclose: a wrong-inbox
    // visitor to a dead link should learn the link is dead, not the invited
    // address.
    findUnique.mockResolvedValue(baseInvitation({ status: "cancelled" }));

    const result = await acceptInvitation(
      { rawToken: RAW_TOKEN, user: { id: "x", email: "other@example.com" } },
      fakeDb(),
    );

    expect(result).toEqual({ status: "cancelled" });
  });
});

describe("acceptInvitation — idempotency and replay", () => {
  it("is idempotent for the SAME identity re-clicking a used link", async () => {
    findUnique.mockResolvedValue(baseInvitation({ status: "accepted", acceptedByUserId: USER.id }));

    const result = await acceptInvitation({ rawToken: RAW_TOKEN, user: USER }, fakeDb());

    expect(result).toMatchObject({
      status: "accepted",
      alreadyAccepted: true,
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
    });
    // A replay must not re-run the write path.
    expect(invitationUpdateMany).not.toHaveBeenCalled();
  });

  it("is a hard stop for a DIFFERENT identity on an already-accepted link", async () => {
    findUnique.mockResolvedValue(
      baseInvitation({ status: "accepted", acceptedByUserId: "someone-else" }),
    );

    expect(await acceptInvitation({ rawToken: RAW_TOKEN, user: USER }, fakeDb())).toEqual({
      status: "accepted_by_other",
    });
  });

  it("treats an accepted row with no recorded acceptor as accepted_by_other", async () => {
    // Legacy/partial data must fail CLOSED, not hand the invitation to whoever
    // clicks next.
    findUnique.mockResolvedValue(baseInvitation({ status: "accepted", acceptedByUserId: null }));

    expect(await acceptInvitation({ rawToken: RAW_TOKEN, user: USER }, fakeDb())).toEqual({
      status: "accepted_by_other",
    });
  });
});

describe("acceptInvitation — the happy path", () => {
  it("clears this teacher's onboarding hold and marks the invitation accepted", async () => {
    findUnique.mockResolvedValue(baseInvitation());

    const result = await acceptInvitation({ rawToken: RAW_TOKEN, user: USER }, fakeDb());

    expect(result).toEqual({
      status: "accepted",
      teacherId: TEACHER_ID,
      studentId: STUDENT_ID,
      linkedStudentId: STUDENT_ID,
      alreadyAccepted: false,
      existingAccount: false,
    });

    // The hold is cleared for THIS pairing only — not across the student's
    // other teachers, who never invited them.
    expect(teacherStudentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ teacherId: TEACHER_ID, studentId: STUDENT_ID }),
      }),
    );
  });

  it("guards the accept write on status='pending' so a concurrent double-accept lands once", async () => {
    findUnique.mockResolvedValue(baseInvitation());

    await acceptInvitation({ rawToken: RAW_TOKEN, user: USER }, fakeDb());

    // Without this predicate the second racer overwrites acceptedByUserId and
    // silently reassigns the invitation.
    expect(invitationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "inv-1", status: "pending" }),
        data: expect.objectContaining({ status: "accepted", acceptedByUserId: USER.id }),
      }),
    );
  });

  it("refuses when the identity owns a Teacher account", async () => {
    // Teacher and Student are mutually exclusive.
    resolveLinkedStudent.mockResolvedValue({ status: "conflict" });
    findUnique.mockResolvedValue(baseInvitation());

    const result = await acceptInvitation({ rawToken: RAW_TOKEN, user: USER }, fakeDb());

    expect(result).toEqual({ status: "is_teacher" });
    expect(invitationUpdateMany).not.toHaveBeenCalled();
  });

  it("reports existingAccount when the login was already linked to a student row", async () => {
    // Drives `invitation_existing_account_linked` instead of
    // `invitation_accepted` — an existing student picking up a second teacher.
    resolveLinkedStudent.mockResolvedValue({
      status: "linked",
      id: "student-oldest",
      alreadyLinked: true,
    });
    findUnique.mockResolvedValue(baseInvitation());

    const result = await acceptInvitation({ rawToken: RAW_TOKEN, user: USER }, fakeDb());

    expect(result).toMatchObject({ existingAccount: true, linkedStudentId: "student-oldest" });
  });

  it("returns this teacher's roster row even when a SIBLING row won the link", async () => {
    // The multi-teacher invariant: the login binds the oldest rostered row,
    // which may belong to another teacher. `studentId` must stay this
    // invitation's row so the right pairing gets its hold cleared, while
    // `linkedStudentId` reports what the login actually bound to.
    resolveLinkedStudent.mockResolvedValue({
      status: "linked",
      id: "student-from-other-teacher",
      alreadyLinked: true,
    });
    findUnique.mockResolvedValue(baseInvitation());

    const result = await acceptInvitation({ rawToken: RAW_TOKEN, user: USER }, fakeDb());

    expect(result).toMatchObject({
      studentId: STUDENT_ID,
      linkedStudentId: "student-from-other-teacher",
    });
    expect(teacherStudentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ studentId: STUDENT_ID }),
      }),
    );
  });

  it("falls back to the invitation's own row when nothing matched the link", async () => {
    resolveLinkedStudent.mockResolvedValue({ status: "none" });
    findUnique.mockResolvedValue(baseInvitation());

    const result = await acceptInvitation({ rawToken: RAW_TOKEN, user: USER }, fakeDb());

    expect(result).toMatchObject({ linkedStudentId: STUDENT_ID, existingAccount: false });
  });
});

describe("getInvitationLanding", () => {
  const landingFindUnique = vi.fn();
  const landingDb = () =>
    ({ studentInvitation: { findUnique: landingFindUnique } }) as unknown as Parameters<
      typeof getInvitationLanding
    >[1];

  afterEach(() => landingFindUnique.mockReset());

  it("returns null for a malformed token without a DB round trip", async () => {
    expect(await getInvitationLanding("!!!", landingDb())).toBeNull();
    expect(landingFindUnique).not.toHaveBeenCalled();
  });

  it("returns null for an unknown token", async () => {
    landingFindUnique.mockResolvedValue(null);

    expect(await getInvitationLanding(RAW_TOKEN, landingDb())).toBeNull();
  });

  it("derives expired state for a pending row past its window", async () => {
    landingFindUnique.mockResolvedValue({
      email: "student@example.com",
      name: "Mira",
      status: "pending",
      expiresAt: new Date(Date.now() - HOUR),
      teacher: { name: "Profe", photoPath: null, updatedAt: new Date(0) },
      student: { name: "Mira R" },
    });

    const info = await getInvitationLanding(RAW_TOKEN, landingDb());

    expect(info).toMatchObject({ state: "expired", invitedEmail: "student@example.com" });
  });

  it("prefers the invitation's own name over the roster row's", async () => {
    landingFindUnique.mockResolvedValue({
      email: "student@example.com",
      name: "Mira",
      status: "pending",
      expiresAt: new Date(Date.now() + HOUR),
      teacher: { name: "Profe", photoPath: "p.jpg", updatedAt: new Date(1234) },
      student: { name: "Mira R" },
    });

    const info = await getInvitationLanding(RAW_TOKEN, landingDb());

    expect(info).toMatchObject({
      state: "pending",
      studentName: "Mira",
      teacherName: "Profe",
      teacherPhotoPath: "p.jpg",
      teacherPhotoVersion: 1234,
    });
  });

  it("never leaks the token or its hash back to the landing page", async () => {
    landingFindUnique.mockResolvedValue({
      email: "student@example.com",
      name: null,
      status: "pending",
      expiresAt: new Date(Date.now() + HOUR),
      teacher: { name: "Profe", photoPath: null, updatedAt: new Date(0) },
      student: { name: "Mira R" },
    });

    const info = await getInvitationLanding(RAW_TOKEN, landingDb());

    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain(RAW_TOKEN);
    expect(serialized).not.toContain(hashInvitationToken(RAW_TOKEN));
  });
});
