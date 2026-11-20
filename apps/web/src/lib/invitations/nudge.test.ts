import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

// The pending-invite nudge (nudge.ts). The candidate read is a cron sweep
// across every teacher on purpose; the stamp after each teacher's digest is
// the write this pins (#62, D-175). It used to stamp by invitation id alone,
// so nothing in the write said it could only touch the teacher whose digest
// was just sent. The fake honours `teacherId` the way Prisma does.

const send = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
vi.mock("@/lib/email", () => ({ getEmailClient: () => ({ send }) }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ APP_URL: "https://app.test/" }) }));
vi.mock("@/lib/email/html-shell", () => ({ renderBrandedEmailHtml: () => "<p>html</p>" }));
vi.mock("@/lib/logger", () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { sendPendingInviteNudges } = await import("./nudge");

const NOW = new Date("2026-11-20T12:00:00Z");
const T1 = "teacher-1";
const T2 = "teacher-2";

type Row = { id: string; teacherId: string; reminderSentAt: Date | null };
type Where = {
  id?: { in: string[] };
  teacherId?: string;
  status?: string;
  reminderSentAt?: null;
};

function makeDb(opts: { readAs?: string } = {}) {
  const rows: Row[] = [
    { id: "i1", teacherId: T1, reminderSentAt: null },
    { id: "i2", teacherId: T2, reminderSentAt: null },
  ];
  const matches = (r: Row, where: Where) =>
    (where.id === undefined || where.id.in.includes(r.id)) &&
    (where.teacherId === undefined || r.teacherId === where.teacherId) &&
    (!("reminderSentAt" in where) || r.reminderSentAt === where.reminderSentAt);

  const studentInvitation = {
    // `readAs` reports every candidate as that teacher's: the one way an
    // id-only stamp could reach a row of another teacher is a row whose
    // teacher is not the one it was read as.
    findMany: vi.fn(async () =>
      rows
        .filter((r) => (opts.readAs ? r.teacherId !== opts.readAs : true))
        .map((r) => ({ id: r.id, teacherId: opts.readAs ?? r.teacherId })),
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    }),
  };
  const teacher = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
      name: where.id,
      email: `${where.id}@example.com`,
      locale: "en",
      disabledAt: null,
    })),
  };
  return {
    prisma: { studentInvitation, teacher } as unknown as PrismaClient,
    rows,
    studentInvitation,
  };
}

beforeEach(() => send.mockClear());

describe("sendPendingInviteNudges stamps only the nudged teacher's invitations", () => {
  it("stamps with a where scoped to the teacher whose digest was sent", async () => {
    const { prisma, rows, studentInvitation } = makeDb();
    const res = await sendPendingInviteNudges({ prisma, now: NOW });
    expect(res).toEqual({ teachersNudged: 2, invitationsCovered: 2 });
    expect(studentInvitation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["i1"] }, teacherId: T1, status: "pending", reminderSentAt: null },
      data: { reminderSentAt: NOW },
    });
    expect(studentInvitation.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["i2"] }, teacherId: T2, status: "pending", reminderSentAt: null },
      data: { reminderSentAt: NOW },
    });
    expect(rows.every((r) => r.reminderSentAt?.getTime() === NOW.getTime())).toBe(true);
  });

  it("does not stamp a row whose teacher is not the one it was read as", async () => {
    const { prisma, rows } = makeDb({ readAs: T1 });
    await sendPendingInviteNudges({ prisma, now: NOW });
    expect(rows[1]!.reminderSentAt).toBeNull();
  });
});
