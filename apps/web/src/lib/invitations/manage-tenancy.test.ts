import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  cancelInvitation,
  discardUnsentInvitation,
  markInvitationSent,
  rotateInvitationForResend,
} from "./manage";

// Tenant scoping of the StudentInvitation writes in manage.ts (#62, D-175).
// Mark-sent, discard, resend and cancel each used to write the row by id
// alone: the resend and cancel writes were correct only because the read just
// before them was scoped to the teacher, and mark-sent and discard trusted
// whatever id their caller handed them. The fake below honours `teacherId`
// the way Prisma does: `update` throws P2025 when its `where` matches nothing,
// and `deleteMany` only deletes what its `where` matches, so a write that
// names the wrong tenant cannot quietly succeed here either.

const T1 = "teacher-1";
const T2 = "teacher-2";

type Row = {
  id: string;
  teacherId: string;
  status: "pending" | "accepted" | "cancelled";
  sentAt: Date | null;
  lastSentAt: Date | null;
  resendCount: number;
  tokenHash: string;
  cancelledAt: Date | null;
  student: { locale: string | null };
};
type Where = { id?: string; teacherId?: string; status?: string; sentAt?: null };

function makeDb(opts: { readAs?: string } = {}) {
  const row = (id: string, teacherId: string): Row => ({
    id,
    teacherId,
    status: "pending",
    sentAt: null,
    lastSentAt: null,
    resendCount: 0,
    tokenHash: `hash-${id}`,
    cancelledAt: null,
    student: { locale: "en" },
  });
  const rows: Row[] = [row("i1", T1), row("i2", T2)];
  const matches = (r: Row, where: Where) =>
    (where.id === undefined || r.id === where.id) &&
    (where.teacherId === undefined || r.teacherId === where.teacherId) &&
    (where.status === undefined || r.status === where.status) &&
    (!("sentAt" in where) || r.sentAt === where.sentAt);

  const studentInvitation = {
    // `readAs` makes the ownership read return the row as if it belonged to
    // that teacher: the one way an id-only write could reach a row the teacher
    // does not own is a row whose teacher is not the one it was read as, so
    // that is what the mismatch tests construct.
    findFirst: vi.fn(async ({ where }: { where: Where }) => {
      const r = rows.find((x) => (opts.readAs ? x.id === where.id : matches(x, where)));
      return r ? { ...r } : null;
    }),
    update: vi.fn(async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
      const r = rows.find((x) => matches(x, where));
      if (!r) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
      for (const [k, v] of Object.entries(data)) {
        if (k === "resendCount" && typeof v === "object" && v !== null) {
          r.resendCount += (v as { increment: number }).increment;
        } else {
          (r as Record<string, unknown>)[k] = v;
        }
      }
      return { ...r };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Where }) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i]!, where)) rows.splice(i, 1);
      return { count: before - rows.length };
    }),
  };
  const db = {
    studentInvitation,
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };
  return { prisma: db as unknown as PrismaClient, rows, studentInvitation };
}

describe("markInvitationSent writes only the calling teacher's invitation", () => {
  it("writes with a where scoped to the teacher", async () => {
    const { prisma, rows, studentInvitation } = makeDb();
    await markInvitationSent(T1, "i1", { resend: false }, prisma);
    expect(studentInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "i1", teacherId: T1 } }),
    );
    expect(rows[0]!.sentAt).toBeInstanceOf(Date);
  });

  it("does not stamp another teacher's invitation", async () => {
    const { prisma, rows } = makeDb();
    await expect(markInvitationSent(T1, "i2", { resend: true }, prisma)).rejects.toMatchObject({
      code: "P2025",
    });
    expect(rows[1]!.lastSentAt).toBeNull();
    expect(rows[1]!.resendCount).toBe(0);
  });
});

describe("discardUnsentInvitation deletes only the calling teacher's invitation", () => {
  it("deletes with a where scoped to the teacher", async () => {
    const { prisma, rows, studentInvitation } = makeDb();
    await discardUnsentInvitation(T1, "i1", prisma);
    expect(studentInvitation.deleteMany).toHaveBeenCalledWith({
      where: { id: "i1", teacherId: T1, status: "pending", sentAt: null },
    });
    expect(rows.map((r) => r.id)).toEqual(["i2"]);
  });

  it("leaves another teacher's unsent invitation in place", async () => {
    const { prisma, rows } = makeDb();
    await discardUnsentInvitation(T1, "i2", prisma);
    expect(rows.map((r) => r.id)).toEqual(["i1", "i2"]);
  });
});

describe("rotateInvitationForResend writes only the calling teacher's invitation", () => {
  it("writes with a where scoped to the teacher", async () => {
    const { prisma, studentInvitation } = makeDb();
    const res = await rotateInvitationForResend(T1, "i1", prisma);
    expect(res.status).toBe("ok");
    expect(studentInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "i1", teacherId: T1 } }),
    );
  });

  it("another teacher's invitation id is not found, and nothing is written", async () => {
    const { prisma, rows, studentInvitation } = makeDb();
    expect(await rotateInvitationForResend(T1, "i2", prisma)).toEqual({ status: "not_found" });
    expect(studentInvitation.update).not.toHaveBeenCalled();
    expect(rows[1]!.tokenHash).toBe("hash-i2");
  });

  it("does not re-mint the token of a row whose teacher is not the one it was read as", async () => {
    const { prisma, rows } = makeDb({ readAs: T1 });
    await expect(rotateInvitationForResend(T1, "i2", prisma)).rejects.toMatchObject({
      code: "P2025",
    });
    expect(rows[1]!.tokenHash).toBe("hash-i2");
  });
});

describe("cancelInvitation writes only the calling teacher's invitation", () => {
  it("writes with a where scoped to the teacher", async () => {
    const { prisma, rows, studentInvitation } = makeDb();
    expect(await cancelInvitation(T1, "i1", prisma)).toEqual({ status: "ok" });
    expect(studentInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "i1", teacherId: T1 } }),
    );
    expect(rows[0]!.status).toBe("cancelled");
  });

  it("another teacher's invitation id is not found, and nothing is written", async () => {
    const { prisma, rows, studentInvitation } = makeDb();
    expect(await cancelInvitation(T1, "i2", prisma)).toEqual({ status: "not_found" });
    expect(studentInvitation.update).not.toHaveBeenCalled();
    expect(rows[1]!.status).toBe("pending");
  });

  it("does not cancel a row whose teacher is not the one it was read as", async () => {
    const { prisma, rows } = makeDb({ readAs: T1 });
    await expect(cancelInvitation(T1, "i2", prisma)).rejects.toMatchObject({ code: "P2025" });
    expect(rows[1]!.status).toBe("pending");
    expect(rows[1]!.cancelledAt).toBeNull();
  });
});
