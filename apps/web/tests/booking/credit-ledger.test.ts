import { describe, expect, it } from "vitest";
import {
  checkCreditAvailability,
  claimNextCredit,
  compareCreditFifo,
  summarizeCreditPools,
  type CreditPool,
} from "@/lib/booking/credit-ledger";

// Multi-package audit fix: a student can hold several active packages with one
// teacher. These cover the new first-class consumption rule — the soonest-to-
// expire credit is always spent first, never-expire credits last — plus the
// combined-balance view the booking UI renders.

const TEACHER = "11111111-1111-4111-8111-111111111111";
const STUDENT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-06-12T00:00:00.000Z");

type Row = {
  id: string;
  teacherId: string;
  studentId: string;
  classesUsed: number;
  classesTotal: number;
  classDurationMin: number;
  expiresAt: Date | null;
  purchasedAt: Date;
  status: string;
};

function row(over: Partial<Row> & { id: string }): Row {
  return {
    teacherId: TEACHER,
    studentId: STUDENT,
    classesUsed: 0,
    classesTotal: 10,
    classDurationMin: 50,
    expiresAt: null,
    purchasedAt: new Date("2026-06-01T00:00:00.000Z"),
    status: "active",
    ...over,
  };
}

// Tiny in-memory LedgerClient over an array of rows. updateMany applies the
// same field-comparison guard the real DB enforces under a row lock.
function fakeClient(rows: Row[]) {
  return {
    package: {
      findMany: async ({ where }: any) => {
        return rows.filter((r) => {
          if (where?.teacherId && r.teacherId !== where.teacherId) return false;
          if (where?.studentId?.in && !where.studentId.in.includes(r.studentId)) return false;
          if (
            where?.classDurationMin !== undefined &&
            r.classDurationMin !== where.classDurationMin
          )
            return false;
          if (where?.status && r.status !== where.status) return false;
          return true;
        });
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const r of rows) {
          if (where.id && r.id !== where.id) continue;
          if (where.status && r.status !== where.status) continue;
          if (where.classesUsed?.lt && !(r.classesUsed < r.classesTotal)) continue;
          if (data.classesUsed?.increment) r.classesUsed += data.classesUsed.increment;
          count += 1;
        }
        return { count };
      },
    },
  };
}

const pool: CreditPool = {
  teacherId: TEACHER,
  studentIds: [STUDENT],
  classDurationMin: 50,
};

describe("compareCreditFifo", () => {
  it("orders soonest-expiry first, never-expire last, then oldest purchase", () => {
    const a = row({ id: "a", expiresAt: new Date("2026-07-01T00:00:00Z") });
    const b = row({ id: "b", expiresAt: new Date("2026-06-20T00:00:00Z") });
    const c = row({ id: "c", expiresAt: null });
    const sorted = [a, b, c].sort(compareCreditFifo).map((r) => r.id);
    expect(sorted).toEqual(["b", "a", "c"]);
  });
});

describe("claimNextCredit", () => {
  it("spends the soonest-to-expire credit, not the newest", async () => {
    const soon = row({
      id: "soon",
      expiresAt: new Date("2026-06-20T00:00:00Z"),
      purchasedAt: new Date("2026-05-01T00:00:00Z"),
    });
    const later = row({
      id: "later",
      expiresAt: new Date("2026-09-01T00:00:00Z"),
      purchasedAt: new Date("2026-06-10T00:00:00Z"), // newer — old default would pick this
    });
    const rows = [later, soon];
    const claimed = await claimNextCredit(fakeClient(rows), pool, NOW, "classesTotal");
    expect(claimed?.packageId).toBe("soon");
    expect(soon.classesUsed).toBe(1);
    expect(later.classesUsed).toBe(0);
  });

  it("skips expired and exhausted credits", async () => {
    const expired = row({ id: "expired", expiresAt: new Date("2026-06-01T00:00:00Z") });
    const full = row({ id: "full", classesUsed: 10, classesTotal: 10 });
    const good = row({ id: "good", expiresAt: new Date("2026-08-01T00:00:00Z") });
    const claimed = await claimNextCredit(
      fakeClient([expired, full, good]),
      pool,
      NOW,
      "classesTotal",
    );
    expect(claimed?.packageId).toBe("good");
  });

  it("advances to the next credit when the front-runner is drained (race)", async () => {
    // front-runner has exactly one slot left; pre-fill it so the guard rejects.
    const front = row({
      id: "front",
      classesUsed: 9,
      classesTotal: 10,
      expiresAt: new Date("2026-06-20T00:00:00Z"),
    });
    const next = row({ id: "next", expiresAt: new Date("2026-07-20T00:00:00Z") });
    const rows = [front, next];
    // Simulate the concurrent winner taking front's last slot first.
    front.classesUsed = 10;
    const claimed = await claimNextCredit(fakeClient(rows), pool, NOW, "classesTotal");
    expect(claimed?.packageId).toBe("next");
  });

  it("returns null when nothing is claimable", async () => {
    const full = row({ id: "full", classesUsed: 10, classesTotal: 10 });
    const claimed = await claimNextCredit(fakeClient([full]), pool, NOW, "classesTotal");
    expect(claimed).toBeNull();
  });
});

describe("checkCreditAvailability", () => {
  it("ok when a soonest-to-expire credit is bookable", async () => {
    const rows = [row({ id: "a" })];
    expect((await checkCreditAvailability(fakeClient(rows), pool, NOW)).code).toBe("ok");
  });

  it("expired when capacity exists but every such credit has lapsed", async () => {
    const rows = [row({ id: "a", expiresAt: new Date("2026-06-01T00:00:00Z") })];
    expect((await checkCreditAvailability(fakeClient(rows), pool, NOW)).code).toBe("expired");
  });

  it("exhausted when no capacity remains", async () => {
    const rows = [row({ id: "a", classesUsed: 10, classesTotal: 10 })];
    expect((await checkCreditAvailability(fakeClient(rows), pool, NOW)).code).toBe("exhausted");
  });
});

describe("summarizeCreditPools", () => {
  it("collapses same-duration packages into one balance with the soonest expiry", () => {
    const pools = summarizeCreditPools([
      row({
        id: "p1",
        classesUsed: 7,
        classesTotal: 10,
        expiresAt: new Date("2026-09-01T00:00:00Z"),
      }),
      row({
        id: "p2",
        classesUsed: 2,
        classesTotal: 5,
        expiresAt: new Date("2026-06-30T00:00:00Z"),
      }),
    ]);
    expect(pools).toHaveLength(1);
    expect(pools[0].classesLeft).toBe(3 + 3); // (10-7) + (5-2)
    expect(pools[0].nextExpiresAt?.toISOString()).toBe("2026-06-30T00:00:00.000Z");
    expect(pools[0].referencePackageId).toBe("p2"); // FIFO front-runner
  });

  it("keeps different class lengths as separate balances", () => {
    const pools = summarizeCreditPools([
      row({ id: "a", classDurationMin: 50 }),
      row({ id: "b", classDurationMin: 25 }),
    ]);
    expect(pools).toHaveLength(2);
    expect(new Set(pools.map((p) => p.classDurationMin))).toEqual(new Set([25, 50]));
  });
});

// Regression: the booking path only checked `expiresAt > now` (credit not yet
// lapsed), so a paid credit could be spent on a class scheduled AFTER the
// package's validity window — while the reschedule action refused the identical
// move. Eligibility now takes a `validAt` (the class start) so the two agree.
describe("class-time validity (validAt)", () => {
  const CLASS_AFTER_EXPIRY = new Date("2026-06-25T00:00:00.000Z");
  const CLASS_BEFORE_EXPIRY = new Date("2026-06-15T00:00:00.000Z");

  it("checkCreditAvailability: a credit that expires before the class is not bookable", async () => {
    const rows = [row({ id: "a", expiresAt: new Date("2026-06-20T00:00:00Z") })];
    // Not yet lapsed as of NOW → the old check said "ok".
    expect((await checkCreditAvailability(fakeClient(rows), pool, NOW)).code).toBe("ok");
    // But the class falls after the credit expires → not bookable (expired).
    expect(
      (await checkCreditAvailability(fakeClient(rows), pool, NOW, CLASS_AFTER_EXPIRY)).code,
    ).toBe("expired");
    // A class before expiry stays bookable.
    expect(
      (await checkCreditAvailability(fakeClient(rows), pool, NOW, CLASS_BEFORE_EXPIRY)).code,
    ).toBe("ok");
  });

  it("claimNextCredit: won't spend a credit on a class after its expiry", async () => {
    const rows = [row({ id: "a", classesUsed: 0, expiresAt: new Date("2026-06-20T00:00:00Z") })];
    const client = fakeClient(rows);
    const claimed = await claimNextCredit(client, pool, NOW, "classesTotal", CLASS_AFTER_EXPIRY);
    expect(claimed).toBeNull();
    expect(rows[0].classesUsed).toBe(0); // untouched

    // Same credit, a class within the window → claimed.
    const ok = await claimNextCredit(client, pool, NOW, "classesTotal", CLASS_BEFORE_EXPIRY);
    expect(ok?.packageId).toBe("a");
    expect(rows[0].classesUsed).toBe(1);
  });
});
