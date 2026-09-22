import { describe, expect, it } from "vitest";
import {
  anonymizeMaturedDeletions,
  DELETION_DEFER_MS,
  type AnonymizeDeps,
} from "@/lib/account-deletion/anonymize";
import { StripeApiError } from "@/lib/stripe";

// docs/security.md. Pure-logic test for the anonymizer.

type FakeTeacher = {
  id: string;
  email: string;
  name: string;
  phoneE164: string | null;
  stripeAccountId: string | null;
  wiseHandle: string | null;
  disabledAt: Date | null;
  disabledReason: string | null;
};

type FakeStudent = {
  id: string;
  email: string | null;
  name: string;
  phoneE164: string | null;
  authUserId: string | null;
  emailOptIn: boolean;
  disabledAt: Date | null;
  disabledReason: string | null;
};

type FakeRequest = {
  id: string;
  subjectType: "teacher" | "student";
  subjectId: string;
  status: "pending" | "anonymizing" | "cancelled" | "anonymized";
  scheduledFor: Date;
  anonymizedAt: Date | null;
};

type FakeSub = {
  teacherId: string;
  stripeSubscriptionId: string | null;
  comped: boolean;
  status: "active" | "trialing" | "past_due" | "canceled" | "free";
};

function makeDeps(now: Date): {
  deps: AnonymizeDeps;
  teachers: FakeTeacher[];
  students: FakeStudent[];
  requests: FakeRequest[];
  subscriptions: FakeSub[];
  deletedPushSubscriptions: string[];
  deletedNotifications: string[];
  deletedContactChanges: string[];
  deletedNotes: string[];
} {
  const teachers: FakeTeacher[] = [];
  const students: FakeStudent[] = [];
  const requests: FakeRequest[] = [];
  const subscriptions: FakeSub[] = [];
  const deletedPushSubscriptions: string[] = [];
  const deletedNotifications: string[] = [];
  const deletedContactChanges: string[] = [];
  const deletedNotes: string[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fake: any = {
    accountDeletionRequest: {
      findMany: async (args: { where: { status: string; scheduledFor: { lte: Date } } }) =>
        requests.filter(
          (r) =>
            r.status === args.where.status &&
            r.scheduledFor.getTime() <= args.where.scheduledFor.lte.getTime(),
        ),
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeRequest> }) => {
        const r = requests.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      },
      // Guarded claim/release: only matches when the row is in the expected
      // status (mirrors the atomic pending -> anonymizing claim).
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: Partial<FakeRequest>;
      }) => {
        const r = requests.find((x) => x.id === where.id);
        if (!r || r.status !== where.status) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
    },
    teacher: {
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeTeacher> }) => {
        const t = teachers.find((x) => x.id === where.id)!;
        Object.assign(t, data);
        return t;
      },
    },
    teacherSubscription: {
      findUnique: async ({ where }: { where: { teacherId: string } }) =>
        subscriptions.find((s) => s.teacherId === where.teacherId) ?? null,
    },
    student: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        students.find((x) => x.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeStudent> }) => {
        const s = students.find((x) => x.id === where.id)!;
        Object.assign(s, data);
        return s;
      },
    },
    webPushSubscription: {
      deleteMany: async ({ where }: { where: { recipientId: string } }) => {
        deletedPushSubscriptions.push(where.recipientId);
        return { count: 1 };
      },
    },
    notification: {
      deleteMany: async ({ where }: { where: { recipientId: string } }) => {
        deletedNotifications.push(where.recipientId);
        return { count: 1 };
      },
    },
    studentContactChange: {
      deleteMany: async ({ where }: { where: { studentId: string } }) => {
        deletedContactChanges.push(where.studentId);
        return { count: 1 };
      },
    },
    studentNote: {
      deleteMany: async ({ where }: { where: { studentId: string } }) => {
        deletedNotes.push(where.studentId);
        return { count: 1 };
      },
    },
    // D-136: closing a teacher's account destroys her recordings. Empty here —
    // the purge itself is covered in purge-recordings.test.ts; what this stub
    // buys is that anonymizeTeacher still completes (and still revokes sessions)
    // with the purge wired in.
    callRecording: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    lessonAudio: { findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    lessonTranscript: { deleteMany: async () => ({ count: 0 }) },
    lessonSummary: { deleteMany: async () => ({ count: 0 }) },
    $transaction: async <T>(fn: (tx: typeof fake) => Promise<T>): Promise<T> => fn(fake),
  };

  return {
    deps: { prisma: fake as unknown as AnonymizeDeps["prisma"], now },
    teachers,
    students,
    requests,
    subscriptions,
    deletedPushSubscriptions,
    deletedNotifications,
    deletedContactChanges,
    deletedNotes,
  };
}

describe("anonymizeMaturedDeletions", () => {
  it("anonymizes a matured teacher request", async () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const env = makeDeps(now);
    env.teachers.push({
      id: "t1",
      email: "real@example.com",
      name: "Alicia Moreno",
      phoneE164: "+521234567890",
      stripeAccountId: "acct_123",
      wiseHandle: "@aliciamoreno",
      disabledAt: null,
      disabledReason: null,
    });
    env.requests.push({
      id: "r1",
      subjectType: "teacher",
      subjectId: "t1",
      status: "pending",
      scheduledFor: new Date("2026-05-15T00:00:00Z"),
      anonymizedAt: null,
    });

    const result = await anonymizeMaturedDeletions(env.deps);

    expect(result.processed).toBe(1);
    expect(result.teachersAnonymized).toBe(1);
    expect(env.teachers[0].email).toBe("deleted+t1@spiralclass.invalid");
    expect(env.teachers[0].phoneE164).toBeNull();
    expect(env.teachers[0].stripeAccountId).toBeNull();
    expect(env.teachers[0].disabledAt).toEqual(now);
    expect(env.teachers[0].disabledReason).toBe("account_deleted");
    expect(env.requests[0].status).toBe("anonymized");
    expect(env.requests[0].anonymizedAt).toEqual(now);
    expect(env.deletedPushSubscriptions).toEqual(["t1"]);
    expect(env.deletedNotifications).toEqual(["t1"]);
  });

  it("does not touch requests whose scheduled_for is in the future", async () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const env = makeDeps(now);
    env.requests.push({
      id: "r1",
      subjectType: "teacher",
      subjectId: "t1",
      status: "pending",
      scheduledFor: new Date("2026-06-15T00:00:00Z"),
      anonymizedAt: null,
    });

    const result = await anonymizeMaturedDeletions(env.deps);

    expect(result.processed).toBe(0);
    expect(env.requests[0].status).toBe("pending");
  });

  it("hard-revokes sessions for a teacher (id is the auth user id) and a student", async () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const env = makeDeps(now);
    const revoked: string[] = [];
    env.deps.revokeAuthSessions = async (authUserId: string) => {
      revoked.push(authUserId);
    };

    env.teachers.push({
      id: "t1",
      email: "real@example.com",
      name: "Alicia Moreno",
      phoneE164: null,
      stripeAccountId: null,
      wiseHandle: null,
      disabledAt: null,
      disabledReason: null,
    });
    env.students.push({
      id: "s1",
      email: "student@example.com",
      name: "Carolina",
      phoneE164: null,
      authUserId: "supabase-student-uid",
      emailOptIn: true,
      disabledAt: null,
      disabledReason: null,
    });
    env.requests.push(
      {
        id: "r1",
        subjectType: "teacher",
        subjectId: "t1",
        status: "pending",
        scheduledFor: new Date("2026-05-15T00:00:00Z"),
        anonymizedAt: null,
      },
      {
        id: "r2",
        subjectType: "student",
        subjectId: "s1",
        status: "pending",
        scheduledFor: new Date("2026-05-15T00:00:00Z"),
        anonymizedAt: null,
      },
    );

    await anonymizeMaturedDeletions(env.deps);

    // Teacher uses the row id; student uses the captured authUserId read
    // before the transaction nulled it.
    expect(revoked).toEqual(["t1", "supabase-student-uid"]);
  });

  it("purges a deleted teacher's recordings, and a purge failure can't block the deletion", async () => {
    // D-136. The privacy policy has promised since D-131 that a class recording
    // lives only "while the teacher's account is open"; nothing enforced it.
    const now = new Date("2026-06-01T00:00:00Z");
    const env = makeDeps(now);
    const purged: string[] = [];
    const revoked: string[] = [];
    env.deps.purgeRecordings = async (teacherId: string) => {
      purged.push(teacherId);
      throw new Error("r2 unreachable");
    };
    env.deps.revokeAuthSessions = async (id: string) => {
      revoked.push(id);
    };

    env.teachers.push({
      id: "t1",
      email: "real@example.com",
      name: "Alicia Moreno",
      phoneE164: null,
      stripeAccountId: null,
      wiseHandle: null,
      disabledAt: null,
      disabledReason: null,
    });
    env.requests.push({
      id: "r1",
      subjectType: "teacher",
      subjectId: "t1",
      status: "pending",
      scheduledFor: new Date("2026-05-15T00:00:00Z"),
      anonymizedAt: null,
    });

    const result = await anonymizeMaturedDeletions(env.deps);

    expect(purged).toEqual(["t1"]);
    // Best-effort: a storage outage must not abort the rest of the deletion the
    // user has already waited out a 30-day grace window for.
    expect(result.errors).toEqual([]);
    expect(result.teachersAnonymized).toBe(1);
    expect(revoked).toEqual(["t1"]);
    expect(env.teachers[0].disabledReason).toBe("account_deleted");
  });

  it("does not call Stripe for an ex-Pro teacher whose stale sub id points at a canceled sub", async () => {
    // Regression: dropToFree leaves stripeSubscriptionId set on a status='free'
    // row. Calling cancel on it returns 400 and used to abort anonymization
    // forever. With the status guard, we skip the call entirely and anonymize.
    const now = new Date("2026-06-01T00:00:00Z");
    const env = makeDeps(now);
    let cancelCalls = 0;
    env.deps.cancelStripeSubscription = async () => {
      cancelCalls += 1;
    };
    env.teachers.push({
      id: "t1",
      email: "ex-pro@example.com",
      name: "Ex Pro",
      phoneE164: null,
      stripeAccountId: null,
      wiseHandle: null,
      disabledAt: null,
      disabledReason: null,
    });
    env.subscriptions.push({
      teacherId: "t1",
      stripeSubscriptionId: "sub_stale",
      comped: false,
      status: "free",
    });
    env.requests.push({
      id: "r1",
      subjectType: "teacher",
      subjectId: "t1",
      status: "pending",
      scheduledFor: new Date("2026-05-15T00:00:00Z"),
      anonymizedAt: null,
    });

    const result = await anonymizeMaturedDeletions(env.deps);

    expect(cancelCalls).toBe(0);
    expect(result.teachersAnonymized).toBe(1);
    expect(env.requests[0].status).toBe("anonymized");
  });

  it("treats a Stripe 400 (already-canceled) as success and still anonymizes", async () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const env = makeDeps(now);
    env.deps.cancelStripeSubscription = async () => {
      throw new StripeApiError(
        400,
        "You cannot update a canceled subscription",
        "/v1/subscriptions/sub_x",
      );
    };
    env.teachers.push({
      id: "t1",
      email: "pro@example.com",
      name: "Pro",
      phoneE164: null,
      stripeAccountId: null,
      wiseHandle: null,
      disabledAt: null,
      disabledReason: null,
    });
    // Local status still 'active' (race: canceled at Stripe first), so the
    // cancel IS attempted — and its 400 must not block deletion.
    env.subscriptions.push({
      teacherId: "t1",
      stripeSubscriptionId: "sub_x",
      comped: false,
      status: "active",
    });
    env.requests.push({
      id: "r1",
      subjectType: "teacher",
      subjectId: "t1",
      status: "pending",
      scheduledFor: new Date("2026-05-15T00:00:00Z"),
      anonymizedAt: null,
    });

    const result = await anonymizeMaturedDeletions(env.deps);

    expect(result.teachersAnonymized).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(env.requests[0].status).toBe("anonymized");
  });

  it("propagates a retryable Stripe error (5xx) so the sweep retries, not tombstones", async () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const env = makeDeps(now);
    env.deps.cancelStripeSubscription = async () => {
      throw new StripeApiError(503, "service unavailable", "/v1/subscriptions/sub_x");
    };
    env.teachers.push({
      id: "t1",
      email: "pro@example.com",
      name: "Pro",
      phoneE164: null,
      stripeAccountId: null,
      wiseHandle: null,
      disabledAt: null,
      disabledReason: null,
    });
    env.subscriptions.push({
      teacherId: "t1",
      stripeSubscriptionId: "sub_x",
      comped: false,
      status: "active",
    });
    env.requests.push({
      id: "r1",
      subjectType: "teacher",
      subjectId: "t1",
      status: "pending",
      scheduledFor: new Date("2026-05-15T00:00:00Z"),
      anonymizedAt: null,
    });

    const result = await anonymizeMaturedDeletions(env.deps);

    // Not anonymized — surfaced as an error so the daily cron retries.
    expect(result.teachersAnonymized).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(env.requests[0].status).toBe("pending");
    expect(env.teachers[0].email).toBe("pro@example.com");
  });

  it("defers (does not tombstone) a subject that still holds unused paid classes", async () => {
    // Regression: a package sold DURING the grace window would be tombstoned
    // with unused paid classes. Re-check at maturity and defer instead.
    const now = new Date("2026-06-01T00:00:00Z");
    const env = makeDeps(now);
    env.deps.hasUnusedActivePackages = async (subjectType, subjectId) =>
      subjectType === "teacher" && subjectId === "t1";
    env.teachers.push({
      id: "t1",
      email: "real@example.com",
      name: "Mira",
      phoneE164: null,
      stripeAccountId: "acct_1",
      wiseHandle: null,
      disabledAt: null,
      disabledReason: null,
    });
    env.requests.push({
      id: "r1",
      subjectType: "teacher",
      subjectId: "t1",
      status: "pending",
      scheduledFor: new Date("2026-05-15T00:00:00Z"),
      anonymizedAt: null,
    });

    const result = await anonymizeMaturedDeletions(env.deps);

    expect(result.deferred).toBe(1);
    expect(result.teachersAnonymized).toBe(0);
    // The row is left pending, its payout details intact, and its schedule
    // pushed forward so the sweep revisits.
    expect(env.requests[0].status).toBe("pending");
    expect(env.requests[0].scheduledFor).toEqual(new Date(now.getTime() + DELETION_DEFER_MS));
    expect(env.teachers[0].email).toBe("real@example.com");
    expect(env.teachers[0].stripeAccountId).toBe("acct_1");
  });

  it("skips a request the user cancelled after it was scanned (claim refused)", async () => {
    // Regression: the sweep scans pending rows, then processes them over
    // minutes. A "cancel deletion" landing in that window flips the row to
    // 'cancelled'; the atomic pending -> anonymizing claim must then refuse so
    // the sweep doesn't anonymize it and clobber the cancel.
    const now = new Date("2026-06-01T00:00:00Z");
    const env = makeDeps(now);
    env.teachers.push({
      id: "t1",
      email: "real@example.com",
      name: "Mira",
      phoneE164: null,
      stripeAccountId: "acct_1",
      wiseHandle: null,
      disabledAt: null,
      disabledReason: null,
    });
    const req: (typeof env.requests)[number] = {
      id: "r1",
      subjectType: "teacher",
      subjectId: "t1",
      status: "pending",
      scheduledFor: new Date("2026-05-15T00:00:00Z"),
      anonymizedAt: null,
    };
    env.requests.push(req);
    // The user cancels between the scan (findMany) and the claim (updateMany).
    const origFindMany = env.deps.prisma.accountDeletionRequest.findMany;
    (env.deps.prisma.accountDeletionRequest as any).findMany = async (args: any) => {
      const rows = await origFindMany(args);
      req.status = "cancelled";
      return rows;
    };

    const result = await anonymizeMaturedDeletions(env.deps);

    expect(result.skipped).toBe(1);
    expect(result.teachersAnonymized).toBe(0);
    // The cancel stands; the teacher's PII is untouched.
    expect(req.status).toBe("cancelled");
    expect(env.teachers[0].email).toBe("real@example.com");
  });

  it("anonymizes a matured student request and severs the authUserId link", async () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const env = makeDeps(now);
    env.students.push({
      id: "s1",
      email: "student@example.com",
      name: "Carolina",
      phoneE164: "+521234567890",
      authUserId: "supabase-user-id",
      emailOptIn: true,
      disabledAt: null,
      disabledReason: null,
    });
    env.requests.push({
      id: "r1",
      subjectType: "student",
      subjectId: "s1",
      status: "pending",
      scheduledFor: new Date("2026-05-15T00:00:00Z"),
      anonymizedAt: null,
    });

    const result = await anonymizeMaturedDeletions(env.deps);

    expect(result.studentsAnonymized).toBe(1);
    expect(env.students[0].email).toBe("deleted+s1@spiralclass.invalid");
    expect(env.students[0].authUserId).toBeNull();
    expect(env.students[0].emailOptIn).toBe(false);
    expect(env.students[0].disabledAt).toEqual(now);
    // Contact-change audit rows hold pre-edit emails/numbers — they must
    // be purged, not just orphaned, when the student is anonymized.
    expect(env.deletedContactChanges).toEqual(["s1"]);
    // Teacher-private notes are free text that may name the student — erasure
    // removes them too.
    expect(env.deletedNotes).toEqual(["s1"]);
  });
});
