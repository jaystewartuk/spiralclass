// Unified "credit ledger" consumption rule (multi-package audit fix).
//
// A teacher's student can hold several active packages at once — top-ups and
// repurchases are normal. Each package is a batch of class credits, and
// Booking.packageId records which batch a booked class came off. Historically
// the *student* picked which package to draw from and the picker defaulted to
// the newest one, so a fresh top-up was drained while an older package quietly
// expired with classes still on it — real, paid-for classes silently forfeited.
//
// This module makes consumption a first-class server rule instead of an
// ambiguous UI default: a class is always drawn from the soonest-to-expire
// eligible credit across all of the student's active packages with that teacher
// (for the requested class length). Credits that never expire are consumed
// last; ties break by purchase date, then id, for determinism. The student just
// sees one combined balance per teacher+duration (see summarizeCreditPools).
//
// Race-safety lives where it always has: the per-package field-comparison guard
// (classes_used < classes_total) under the row lock, identical to the old
// single-package claim. Ordering only decides *preference* — if a concurrent
// booking drains the front-runner, the loser advances to the next eligible
// credit. No raw SQL, so the exact same path runs against the real DB and the
// in-memory test fakes.

// Credits are fungible only within one (teacher, student-identity-set, class
// length) pool — you can't spend a 50-minute credit on a 25-minute class.
export type CreditPool = {
  teacherId: string;
  // The student identity set (multi-teacher inbox — studentIdentityIds). Only
  // the one row that belongs to this teacher can match, but we scope by the set
  // so the pool resolves identically to how the caller looked the package up.
  studentIds: string[];
  classDurationMin: number;
};

// The package fields the ledger reasons over. A subset of the Package row.
type CreditRow = {
  id: string;
  studentId: string;
  classesUsed: number;
  classesTotal: number;
  expiresAt: Date | null;
  purchasedAt: Date;
};

export type ClaimedCredit = {
  packageId: string;
  studentId: string;
  expiresAt: Date | null;
};

// Minimal slice of the Prisma client the ledger needs — satisfied by the real
// client, a transaction client, and the unit-test fakes alike. Args are kept
// permissive so the real generic delegate methods remain assignable; loadPool
// owns the concrete shape we actually pass.
export type LedgerClient = {
  package: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args: any) => Promise<CreditRow[]>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany: (args: any) => Promise<{ count: number }>;
  };
};

// FIFO-by-expiry ordering: soonest expiry first, never-expire (null) last, then
// oldest purchase, then id. Typed on just the fields it reads so both CreditRow
// and the UI summary input satisfy it.
export function compareCreditFifo(
  a: { expiresAt: Date | null; purchasedAt: Date; id: string },
  b: { expiresAt: Date | null; purchasedAt: Date; id: string },
): number {
  const ax = a.expiresAt ? a.expiresAt.getTime() : Number.POSITIVE_INFINITY;
  const bx = b.expiresAt ? b.expiresAt.getTime() : Number.POSITIVE_INFINITY;
  if (ax !== bx) return ax - bx;
  const ap = a.purchasedAt.getTime();
  const bp = b.purchasedAt.getTime();
  if (ap !== bp) return ap - bp;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// A credit is eligible when it still has capacity AND is valid at `validAt` —
// the moment the credit must still be good for. For a read of the current
// balance that's `now`; for booking a specific slot it's the CLASS START, so a
// credit can't be spent on a class that falls after the package's validity
// window (matches the reschedule action's expiry guard — previously the initial
// booking path only checked `expiresAt > now`, letting a paid credit be spent on
// a class scheduled after expiry while reschedule refused the identical move).
function eligibleCredits(rows: CreditRow[], validAt: Date): CreditRow[] {
  return rows
    .filter(
      (r) => r.classesUsed < r.classesTotal && (r.expiresAt === null || r.expiresAt > validAt),
    )
    .sort(compareCreditFifo);
}

// Load every active package in the pool. Eligibility (capacity + expiry) is
// filtered in JS rather than the query so the path stays portable — no
// FieldRef-in-findMany the in-memory fakes would otherwise have to model.
async function loadPool(client: LedgerClient, pool: CreditPool): Promise<CreditRow[]> {
  return client.package.findMany({
    where: {
      teacherId: pool.teacherId,
      studentId: { in: pool.studentIds },
      classDurationMin: pool.classDurationMin,
      status: "active",
    },
    select: {
      id: true,
      studentId: true,
      classesUsed: true,
      classesTotal: true,
      expiresAt: true,
      purchasedAt: true,
    },
  });
}

export type CreditAvailability =
  | { code: "ok" }
  | { code: "exhausted" }
  // Capacity exists in the pool but every such credit has lapsed — surfaced as
  // a distinct, friendlier reason than a plain "no classes left".
  | { code: "expired" };

// Read-only reason check, run before the slot work so the caller can return a
// precise error. The authoritative gate is still claimNextCredit returning null.
// `validAt` is the moment the credit must still be valid for — defaults to
// `now` (balance read); the booking path passes the class start so a slot after
// the package's validity window is reported as `expired`, not booked.
export async function checkCreditAvailability(
  client: LedgerClient,
  pool: CreditPool,
  now: Date,
  validAt: Date = now,
): Promise<CreditAvailability> {
  const rows = await loadPool(client, pool);
  if (eligibleCredits(rows, validAt).length > 0) return { code: "ok" };
  const expiredWithCapacity = rows.some(
    (r) => r.classesUsed < r.classesTotal && r.expiresAt !== null && r.expiresAt <= validAt,
  );
  return { code: expiredWithCapacity ? "expired" : "exhausted" };
}

// Atomically claim one class from the soonest-to-expire eligible credit in the
// pool. Returns the package the booking must bind to, or null if the pool
// drained (caller maps null → exhausted). MUST run inside the booking
// transaction so the claim and the Booking insert commit together.
//
// `classesTotalField` is the Prisma FieldRef (prisma.package.fields.classesTotal)
// that makes the guard a row-local comparison; passed in so this module never
// imports the client singleton.
export async function claimNextCredit(
  tx: LedgerClient,
  pool: CreditPool,
  now: Date,
  classesTotalField: unknown,
  validAt: Date = now,
): Promise<ClaimedCredit | null> {
  const candidates = eligibleCredits(await loadPool(tx, pool), validAt);
  for (const c of candidates) {
    const claimed = await tx.package.updateMany({
      where: {
        id: c.id,
        status: "active",
        classesUsed: { lt: classesTotalField },
      },
      data: { classesUsed: { increment: 1 } },
    });
    if (claimed.count === 1) {
      return { packageId: c.id, studentId: c.studentId, expiresAt: c.expiresAt };
    }
    // Lost the race for c (a concurrent booking took its last slot) — fall
    // through to the next soonest-to-expire credit.
  }
  return null;
}

// --- Combined-balance view for the booking UI -----------------------------

export type BookablePackageLite = {
  id: string;
  teacherId: string;
  classDurationMin: number;
  classesTotal: number;
  classesUsed: number;
  expiresAt: Date | null;
  purchasedAt: Date;
};

// One spendable balance the student sees, collapsing every package of the same
// length with one teacher into a single bucket. `referencePackageId` is just a
// pool pointer for the form to submit — the server re-derives FIFO at claim
// time, so it never decides which credit is actually spent.
export type CreditPoolSummary = {
  teacherId: string;
  classDurationMin: number;
  classesLeft: number;
  // Soonest expiry among credits that still have capacity (null = some credit
  // in the pool never expires / nothing is expiring).
  nextExpiresAt: Date | null;
  referencePackageId: string;
};

export function summarizeCreditPools(packages: BookablePackageLite[]): CreditPoolSummary[] {
  const byKey = new Map<string, BookablePackageLite[]>();
  for (const p of packages) {
    const key = `${p.teacherId}:${p.classDurationMin}`;
    const arr = byKey.get(key);
    if (arr) arr.push(p);
    else byKey.set(key, [p]);
  }

  const out: CreditPoolSummary[] = [];
  for (const arr of byKey.values()) {
    const sorted = [...arr].sort(compareCreditFifo);
    const classesLeft = sorted.reduce((n, p) => n + Math.max(0, p.classesTotal - p.classesUsed), 0);
    const nextExpiresAt =
      sorted.find((p) => p.classesTotal - p.classesUsed > 0 && p.expiresAt !== null)?.expiresAt ??
      null;
    out.push({
      teacherId: sorted[0].teacherId,
      classDurationMin: sorted[0].classDurationMin,
      classesLeft,
      nextExpiresAt,
      // FIFO front-runner = soonest to expire = what a booking would spend next.
      referencePackageId: sorted[0].id,
    });
  }

  // Stable UI order: the pool whose credits expire soonest comes first.
  return out.sort((a, b) => {
    const ax = a.nextExpiresAt ? a.nextExpiresAt.getTime() : Number.POSITIVE_INFINITY;
    const bx = b.nextExpiresAt ? b.nextExpiresAt.getTime() : Number.POSITIVE_INFINITY;
    if (ax !== bx) return ax - bx;
    return a.classDurationMin - b.classDurationMin;
  });
}
