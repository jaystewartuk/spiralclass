import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// The teacher-facing discount-code management core (create/activate/delete/list),
// used by the web action. Mocks the prisma singleton to
// lock the value conversion (percent→bps, major→minor units), the duplicate + used
// -code rules, and the list projection.

const create = vi.fn();
const updateMany = vi.fn();
const findFirst = vi.fn();
const del = vi.fn();
const findMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    discountCode: {
      create: (...a: unknown[]) => create(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
      findFirst: (...a: unknown[]) => findFirst(...a),
      delete: (...a: unknown[]) => del(...a),
      findMany: (...a: unknown[]) => findMany(...a),
    },
    // createDiscountCode resolves the teacher's settlement currency from their
    // region. MX → MXN.
    teacher: {
      findUnique: async () => ({ platformRegion: "MX" }),
    },
  },
}));

import {
  createDiscountCode,
  deleteDiscountCode,
  listDiscountCodes,
  setDiscountCodeActive,
} from "@/lib/discounts/manage";

const TEACHER = "11111111-1111-4111-8111-111111111111";

afterEach(() => vi.clearAllMocks());

describe("createDiscountCode", () => {
  it("stores a percent code as basis points, normalizing the code", async () => {
    create.mockResolvedValue({});
    const res = await createDiscountCode(TEACHER, {
      code: " summer15 ",
      kind: "percent",
      percent: 15,
      perStudentLimit: 1,
    });
    expect(res).toEqual({ ok: true });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        teacherId: TEACHER,
        code: "SUMMER15",
        kind: "percent",
        percentBps: 1500,
        amountMinorUnits: null,
        currency: "MXN",
        origin: "promo",
        perStudentLimit: 1,
        expiresAt: null,
      }),
    });
  });

  it("stores a fixed code as minor units with an end-of-day expiry", async () => {
    create.mockResolvedValue({});
    await createDiscountCode(TEACHER, {
      code: "FLAT50",
      kind: "fixed",
      amountPesos: 50,
      perStudentLimit: 2,
      maxRedemptions: 10,
      expiresAt: "2026-12-31",
    });
    const data = create.mock.calls[0][0].data;
    expect(data.percentBps).toBeNull();
    expect(data.amountMinorUnits).toBe(5000);
    expect(data.maxRedemptions).toBe(10);
    expect((data.expiresAt as Date).toISOString()).toBe("2026-12-31T23:59:59.999Z");
  });

  it("returns a duplicate result on a unique-constraint collision", async () => {
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dupe", { code: "P2002", clientVersion: "6" }),
    );
    const res = await createDiscountCode(TEACHER, {
      code: "DUP",
      kind: "percent",
      percent: 10,
      perStudentLimit: 1,
    });
    expect(res).toEqual({ ok: false, reason: "duplicate" });
  });

  it("rethrows unexpected errors", async () => {
    create.mockRejectedValue(new Error("db down"));
    await expect(
      createDiscountCode(TEACHER, { code: "X", kind: "percent", percent: 10, perStudentLimit: 1 }),
    ).rejects.toThrow("db down");
  });
});

describe("setDiscountCodeActive", () => {
  it("reports ok when a row was updated", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    expect(await setDiscountCodeActive(TEACHER, "id", false)).toEqual({ ok: true });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "id", teacherId: TEACHER },
      data: { active: false },
    });
  });

  it("reports not-ok when nothing matched (wrong teacher/id)", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    expect(await setDiscountCodeActive(TEACHER, "id", true)).toEqual({ ok: false });
  });
});

describe("deleteDiscountCode", () => {
  it("deletes an unused code", async () => {
    findFirst.mockResolvedValue({ id: "id", _count: { redemptions: 0 } });
    del.mockResolvedValue({});
    expect(await deleteDiscountCode(TEACHER, "id")).toEqual({ ok: true });
    expect(del).toHaveBeenCalledWith({ where: { id: "id" } });
  });

  it("refuses to delete a used code (deactivate instead)", async () => {
    findFirst.mockResolvedValue({ id: "id", _count: { redemptions: 3 } });
    expect(await deleteDiscountCode(TEACHER, "id")).toEqual({
      ok: false,
      reason: "has-redemptions",
    });
    expect(del).not.toHaveBeenCalled();
  });

  it("returns not-found when the code isn't the teacher's", async () => {
    findFirst.mockResolvedValue(null);
    expect(await deleteDiscountCode(TEACHER, "id")).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("listDiscountCodes", () => {
  it("projects the rows, formatting expiry as YYYY-MM-DD and surfacing usedCount", async () => {
    findMany.mockResolvedValue([
      {
        id: "id",
        code: "SUMMER15",
        kind: "percent",
        percentBps: 1500,
        amountMinorUnits: null,
        currency: "MXN",
        active: true,
        maxRedemptions: null,
        perStudentLimit: 1,
        expiresAt: new Date("2026-12-31T23:59:59.999Z"),
        _count: { redemptions: 4 },
      },
    ]);
    const [view] = await listDiscountCodes(TEACHER);
    expect(view).toMatchObject({
      id: "id",
      code: "SUMMER15",
      currency: "MXN",
      expiresAt: "2026-12-31",
      usedCount: 4,
    });
  });
});
