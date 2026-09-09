import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { activatePackage } from "@/lib/payments/activate-package";

// activatePackage is the single source of truth both the Stripe webhook and
// the Wise manual-confirm path call to settle a payment. It must be
// idempotent (both rails can race to call it) and must compute expiresAt in
// the TEACHER's timezone, not UTC or the student's.

type FakePackage = {
  id: string;
  status: string;
  purchasedAt: Date | null;
  expiresAt: Date | null;
  template: { expirationMonths: number | null } | null;
  teacher: { timezone: string };
};

function makeTx(pkg: FakePackage | null) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const tx = {
    package: {
      findUnique: async (args: { where: { id: string } }) => {
        if (!pkg || pkg.id !== args.where.id) return null;
        return pkg;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: args.where.id, data: args.data });
        if (pkg) Object.assign(pkg, args.data);
        return pkg;
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, updates };
}

const MEXICO_CITY = "America/Mexico_City";

function pendingPackage(overrides: Partial<FakePackage> = {}): FakePackage {
  return {
    id: "pkg_1",
    status: "pending",
    purchasedAt: null,
    expiresAt: null,
    template: { expirationMonths: 1 },
    teacher: { timezone: MEXICO_CITY },
    ...overrides,
  };
}

describe("activatePackage", () => {
  it("flips a pending package to active and locks purchasedAt to `now`", async () => {
    const now = new Date("2026-01-15T10:00:00Z");
    const pkg = pendingPackage({ template: { expirationMonths: null } });
    const { tx, updates } = makeTx(pkg);

    await activatePackage(tx, "pkg_1", now);

    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({ status: "active", purchasedAt: now });
  });

  it("computes expiresAt as end-of-day in the teacher's timezone, N calendar months out", async () => {
    // Mexico City is a fixed UTC-6 (no DST since 2022) — 23:59 local = 05:59Z next day.
    const now = new Date("2026-01-15T10:00:00Z"); // 04:00 local Jan 15
    const pkg = pendingPackage({ template: { expirationMonths: 1 } });
    const { tx, updates } = makeTx(pkg);

    await activatePackage(tx, "pkg_1", now);

    expect(updates[0].data.expiresAt).toEqual(new Date("2026-02-16T05:59:00.000Z"));
  });

  it("clamps to the last day of a shorter target month (Jan 31 + 1mo -> Feb 28)", async () => {
    const now = new Date("2026-01-31T10:00:00Z"); // 04:00 local Jan 31
    const pkg = pendingPackage({ template: { expirationMonths: 1 } });
    const { tx, updates } = makeTx(pkg);

    await activatePackage(tx, "pkg_1", now);

    // Feb 2026 has 28 days -> clamps there, then 23:59 local = 05:59Z Mar 1.
    expect(updates[0].data.expiresAt).toEqual(new Date("2026-03-01T05:59:00.000Z"));
  });

  it("leaves expiresAt null when the template has no expirationMonths", async () => {
    const now = new Date("2026-01-15T10:00:00Z");
    const pkg = pendingPackage({ template: { expirationMonths: null } });
    const { tx, updates } = makeTx(pkg);

    await activatePackage(tx, "pkg_1", now);

    expect(updates[0].data.expiresAt).toBeNull();
  });

  it("leaves expiresAt null for a single-class purchase with no template at all", async () => {
    const now = new Date("2026-01-15T10:00:00Z");
    const pkg = pendingPackage({ template: null });
    const { tx, updates } = makeTx(pkg);

    await activatePackage(tx, "pkg_1", now);

    expect(updates[0].data.expiresAt).toBeNull();
  });

  it("is idempotent — a package that's already active is left untouched", async () => {
    const now = new Date("2026-01-15T10:00:00Z");
    const pkg = pendingPackage({ status: "active", purchasedAt: new Date("2025-12-01T00:00:00Z") });
    const { tx, updates } = makeTx(pkg);

    await activatePackage(tx, "pkg_1", now);

    expect(updates).toHaveLength(0);
    expect(pkg.purchasedAt).toEqual(new Date("2025-12-01T00:00:00Z"));
  });

  it("no-ops on a refunded package (never re-activates)", async () => {
    const now = new Date("2026-01-15T10:00:00Z");
    const pkg = pendingPackage({ status: "refunded" });
    const { tx, updates } = makeTx(pkg);

    await activatePackage(tx, "pkg_1", now);

    expect(updates).toHaveLength(0);
  });

  it("no-ops when the package does not exist (deleted between check and activation)", async () => {
    const { tx, updates } = makeTx(null);

    await expect(
      activatePackage(tx, "missing", new Date("2026-01-15T10:00:00Z")),
    ).resolves.toBeUndefined();
    expect(updates).toHaveLength(0);
  });

  it("uses the teacher's timezone, not a hardcoded default (e.g. a UK teacher)", async () => {
    const now = new Date("2026-01-15T23:30:00Z"); // late UTC evening
    const pkg = pendingPackage({
      teacher: { timezone: "Europe/London" },
      template: { expirationMonths: 1 },
    });
    const { tx, updates } = makeTx(pkg);

    await activatePackage(tx, "pkg_1", now);

    // 23:30Z on Jan 15 is still Jan 15 23:30 local in London (UTC+0 in Jan) ->
    // +1 month -> Feb 15 23:59 local (still UTC+0 in Feb, before BST) = 23:59:00Z.
    expect(updates[0].data.expiresAt).toEqual(new Date("2026-02-15T23:59:00.000Z"));
  });
});
