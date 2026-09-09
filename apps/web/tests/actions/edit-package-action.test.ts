import { beforeEach, describe, expect, it, vi } from "vitest";

// Teacher edit of one of their own recorded packages. Pin: validation, teacher
// scoping, the active/paused status guard, the committed-booking floor on
// classesUsed (Model B — can't push the committed count below classes already
// booked or taken), expiry set/clear, and that the update + audit row are
// written together.

type PkgRow = {
  id: string;
  studentId: string;
  classesTotal: number;
  classesUsed: number;
  classDurationMin: number;
  pricePaidMinorUnits: number;
  expiresAt: Date | null;
  status: string;
  templateId: string | null;
};

const state: {
  pkg: PkgRow | null;
  committed: number;
  overrides: { action: string; before: unknown; after: unknown }[];
} = { pkg: null, committed: 0, overrides: [] };

const TEACHER_TZ = "America/Mexico_City";

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1", timezone: TEACHER_TZ })),
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

const packageUpdate = vi.fn(async ({ data }: { data: Partial<PkgRow> }) => {
  if (state.pkg) Object.assign(state.pkg, data);
  return state.pkg;
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    package: {
      findFirst: vi.fn(async () => (state.pkg ? { ...state.pkg } : null)),
    },
    booking: {
      count: vi.fn(async () => state.committed),
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ package: { update: packageUpdate } }),
  },
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const { editManualPackageAction } = await import("@/app/actions/teacher-packages");

const PKG_ID = "11111111-1111-4111-8111-111111111111";

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

function freshPkg(overrides: Partial<PkgRow> = {}) {
  state.pkg = {
    id: PKG_ID,
    studentId: "s1",
    classesTotal: 10,
    classesUsed: 4,
    classDurationMin: 50,
    pricePaidMinorUnits: 100000,
    expiresAt: null,
    status: "active",
    templateId: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  freshPkg();
  state.committed = 0;
  state.overrides = [];
});

describe("editManualPackageAction", () => {
  it("rejects a non-uuid package id", async () => {
    const res = await editManualPackageAction(
      undefined,
      fd({ packageId: "nope", classesTotal: "10", classesRemaining: "5" }),
    );
    expect(res).toHaveProperty("error");
    expect(packageUpdate).not.toHaveBeenCalled();
  });

  it("rejects classes left greater than the total", async () => {
    const res = await editManualPackageAction(
      undefined,
      fd({ packageId: PKG_ID, classesTotal: "10", classesRemaining: "11" }),
    );
    expect(res?.error).toMatch(/can't exceed/i);
    expect(packageUpdate).not.toHaveBeenCalled();
  });

  it("404s a package outside the teacher's roster", async () => {
    state.pkg = null;
    const res = await editManualPackageAction(
      undefined,
      fd({ packageId: PKG_ID, classesTotal: "10", classesRemaining: "5" }),
    );
    expect(res?.error).toMatch(/not found/i);
    expect(packageUpdate).not.toHaveBeenCalled();
  });

  it("refuses to edit a non-active/paused package", async () => {
    freshPkg({ status: "refunded" });
    const res = await editManualPackageAction(
      undefined,
      fd({ packageId: PKG_ID, classesTotal: "10", classesRemaining: "5" }),
    );
    expect(res?.error).toMatch(/active or paused/i);
    expect(packageUpdate).not.toHaveBeenCalled();
  });

  it("refuses to push the committed count below classes already booked", async () => {
    // 3 classes already count against this package, so classesUsed can't drop
    // below 3 — i.e. classes left can't exceed total - 3 = 7.
    state.committed = 3;
    const res = await editManualPackageAction(
      undefined,
      fd({ packageId: PKG_ID, classesTotal: "10", classesRemaining: "8" }),
    );
    expect(res).toHaveProperty("error");
    expect(packageUpdate).not.toHaveBeenCalled();
    expect(state.overrides).toHaveLength(0);
  });

  it("updates fields and writes an audit row", async () => {
    state.committed = 2;
    const res = await editManualPackageAction(
      undefined,
      fd({
        packageId: PKG_ID,
        classesTotal: "12",
        classesRemaining: "5",
        classDurationMin: "60",
        amountPaidPesos: "1500",
      }),
    );
    expect(res?.ok).toMatch(/5 of 12/);
    expect(state.pkg).toMatchObject({
      classesTotal: 12,
      classesUsed: 7, // 12 - 5
      classDurationMin: 60,
      pricePaidMinorUnits: 150000,
    });
    expect(state.overrides).toHaveLength(1);
    expect(state.overrides[0].action).toBe("edit_manual_package");
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/students/s1");
  });

  it("keeps the recorded price when the amount is left blank", async () => {
    const res = await editManualPackageAction(
      undefined,
      fd({ packageId: PKG_ID, classesTotal: "10", classesRemaining: "5", amountPaidPesos: "" }),
    );
    expect(res?.ok).toBeDefined();
    expect(state.pkg?.pricePaidMinorUnits).toBe(100000);
  });

  it("clears the expiry when the date is left blank", async () => {
    freshPkg({ expiresAt: new Date("2027-01-01T05:59:59Z") });
    const res = await editManualPackageAction(
      undefined,
      fd({ packageId: PKG_ID, classesTotal: "10", classesRemaining: "5", expiresOn: "" }),
    );
    expect(res?.ok).toBeDefined();
    expect(state.pkg?.expiresAt).toBeNull();
  });

  it("rejects a newly-set expiry in the past", async () => {
    const res = await editManualPackageAction(
      undefined,
      fd({
        packageId: PKG_ID,
        classesTotal: "10",
        classesRemaining: "5",
        expiresOn: "2020-01-01",
      }),
    );
    expect(res?.error).toMatch(/future/i);
    expect(packageUpdate).not.toHaveBeenCalled();
  });
});
