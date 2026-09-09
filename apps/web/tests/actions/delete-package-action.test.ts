import { beforeEach, describe, expect, it, vi } from "vitest";

// Teacher hard-delete of a package created by accident — the counterpart to
// pause and edit. Pin: validation, teacher scoping, the no-history guards (a
// package with any booking or any payment can't be deleted), and that a clean
// delete writes the audit row, removes the package, and revalidates.

type PkgRow = {
  id: string;
  studentId: string;
  templateId: string | null;
  classesTotal: number;
  classesUsed: number;
  classDurationMin: number;
  pricePaidMinorUnits: number;
  purchasedAt: Date;
  expiresAt: Date | null;
  status: string;
};

const state: {
  pkg: PkgRow | null;
  bookings: number;
  payments: number;
  overrides: { action: string; before: unknown; after: unknown }[];
} = { pkg: null, bookings: 0, payments: 0, overrides: [] };

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1", timezone: "America/Mexico_City" })),
}));

vi.mock("@/lib/i18n", () => ({
  getPreferredLocale: vi.fn(async () => "en"),
}));

const writeOverride = vi.fn(
  async ({ action, before, after }: { action: string; before: unknown; after: unknown }) => {
    state.overrides.push({ action, before, after });
    return "o1";
  },
);
vi.mock("@/lib/audit", () => ({ writeOverride }));

vi.mock("@/lib/analytics/posthog", () => ({
  trackServerEvent: vi.fn(),
  flushAnalytics: vi.fn(async () => {}),
}));

const packageDelete = vi.fn(async () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    package: {
      findFirst: vi.fn(async () => (state.pkg ? { ...state.pkg } : null)),
    },
    booking: { count: vi.fn(async () => state.bookings) },
    payment: { count: vi.fn(async () => state.payments) },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ package: { delete: packageDelete } }),
  },
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const { deleteManualPackageAction } = await import("@/app/actions/teacher-packages");

const PKG_ID = "11111111-1111-4111-8111-111111111111";

function fd(packageId = PKG_ID): FormData {
  const f = new FormData();
  f.set("packageId", packageId);
  return f;
}

function freshPkg(overrides: Partial<PkgRow> = {}) {
  state.pkg = {
    id: PKG_ID,
    studentId: "s1",
    templateId: null,
    classesTotal: 10,
    classesUsed: 0,
    classDurationMin: 50,
    pricePaidMinorUnits: 0,
    purchasedAt: new Date("2026-06-01T00:00:00Z"),
    expiresAt: null,
    status: "active",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  freshPkg();
  state.bookings = 0;
  state.payments = 0;
  state.overrides = [];
});

describe("deleteManualPackageAction", () => {
  it("rejects a non-uuid package id", async () => {
    const res = await deleteManualPackageAction(undefined, fd("nope"));
    expect(res).toHaveProperty("error");
    expect(packageDelete).not.toHaveBeenCalled();
  });

  it("404s a package outside the teacher's roster", async () => {
    state.pkg = null;
    const res = await deleteManualPackageAction(undefined, fd());
    expect(res?.error).toMatch(/not found/i);
    expect(packageDelete).not.toHaveBeenCalled();
  });

  it("refuses to delete a package with booked or taken classes", async () => {
    state.bookings = 1;
    const res = await deleteManualPackageAction(undefined, fd());
    expect(res?.error).toMatch(/classes/i);
    expect(packageDelete).not.toHaveBeenCalled();
    expect(state.overrides).toHaveLength(0);
  });

  it("refuses to delete a package with a payment on record", async () => {
    state.payments = 1;
    const res = await deleteManualPackageAction(undefined, fd());
    expect(res?.error).toMatch(/payment|refund/i);
    expect(packageDelete).not.toHaveBeenCalled();
    expect(state.overrides).toHaveLength(0);
  });

  it("deletes a clean package and writes an audit row", async () => {
    const res = await deleteManualPackageAction(undefined, fd());
    expect(res?.ok).toBeDefined();
    expect(packageDelete).toHaveBeenCalledWith({ where: { id: PKG_ID } });
    expect(state.overrides).toHaveLength(1);
    expect(state.overrides[0].action).toBe("delete_manual_package");
    expect(state.overrides[0].after).toBeNull();
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/students/s1");
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/students");
  });
});
