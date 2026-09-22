import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the network edges so the sync logic itself is exercised offline.
// `vi.hoisted` lets the mock factories (which are hoisted above imports) share
// these spies with the test body.
const { refreshAccessToken, queryFreeBusy } = vi.hoisted(() => ({
  refreshAccessToken: vi.fn(async () => ({
    accessToken: "fresh-token",
    expiresInSeconds: 3600,
  })),
  queryFreeBusy: vi.fn(async () => [] as { startsAt: Date; endsAt: Date }[]),
}));
vi.mock("@/lib/calendar/google/oauth", () => ({ refreshAccessToken }));
vi.mock("@/lib/calendar/google/freebusy", () => ({ queryFreeBusy }));

import { syncTeacherBusy, syncAllConnectedTeachers } from "@/lib/calendar/google/sync";

type Conn = {
  teacherId: string;
  syncEnabled: boolean;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenEnc: string;
  teacher: { maxAdvanceDays: number | null };
};

function makeDb(conns: Conn[]) {
  const teacherFindUnique = vi.fn(async () => {
    throw new Error("teacher.findUnique should not be called — fold into the connection query");
  });
  const db: any = {
    googleCalendarConnection: {
      findUnique: vi.fn(
        async ({ where }: any) => conns.find((c) => c.teacherId === where.teacherId) ?? null,
      ),
      findMany: vi.fn(async ({ where }: any) =>
        conns
          .filter((c) => (where?.syncEnabled ? c.syncEnabled : true))
          .map((c) => ({ teacherId: c.teacherId })),
      ),
      update: vi.fn(async () => ({})),
    },
    googleBusyInterval: {
      deleteMany: vi.fn(() => ({})),
      createMany: vi.fn(() => ({})),
    },
    teacher: { findUnique: teacherFindUnique },
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
  };
  return { db, teacherFindUnique };
}

function conn(teacherId: string, over: Partial<Conn> = {}): Conn {
  return {
    teacherId,
    syncEnabled: true,
    accessToken: "valid",
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    refreshTokenEnc: "enc",
    teacher: { maxAdvanceDays: 30 },
    ...over,
  };
}

describe("syncTeacherBusy", () => {
  beforeEach(() => {
    refreshAccessToken.mockClear();
    queryFreeBusy.mockClear();
  });

  it("reads maxAdvanceDays from the connection query without a separate teacher lookup", async () => {
    const { db, teacherFindUnique } = makeDb([conn("t1")]);
    const result = await syncTeacherBusy("t1", db);
    expect(result.status).toBe("synced");
    expect(teacherFindUnique).not.toHaveBeenCalled();
    expect(db.googleCalendarConnection.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ include: { teacher: { select: { maxAdvanceDays: true } } } }),
    );
  });

  it("skips a non-connected teacher", async () => {
    const { db } = makeDb([]);
    expect((await syncTeacherBusy("nope", db)).status).toBe("skipped");
  });
});

describe("syncAllConnectedTeachers", () => {
  it("syncs every connected teacher concurrently and tallies outcomes", async () => {
    const { db } = makeDb([conn("t1"), conn("t2"), conn("t3")]);
    const out = await syncAllConnectedTeachers(db);
    expect(out).toEqual({ total: 3, synced: 3, errors: 0, skipped: 0 });
  });
});
