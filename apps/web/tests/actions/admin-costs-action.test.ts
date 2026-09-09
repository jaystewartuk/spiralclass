import { beforeEach, describe, expect, it, vi } from "vitest";

// Platform expense CRUD (finance role). The security/correctness surface
// worth covering here: the "other" vendor requires a vendorLabel, amount is
// converted to minor units in the entry's own currency (not hardcoded /100),
// and update/delete 404 on an unknown id.

vi.mock("@/lib/admin", () => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", role: "finance" })),
}));

const expenseCreate = vi.fn(async (_arg: { data: Record<string, unknown> }) => ({ id: "new" }));
const expenseUpdate = vi.fn(async (_arg: { data: Record<string, unknown> }) => ({}));
const expenseDelete = vi.fn(async (_arg: unknown) => ({}));
const expenseFindUnique = vi.fn(async (_arg: unknown): Promise<{ id: string } | null> => ({
  id: "expense1",
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    platformExpense: {
      create: expenseCreate,
      update: expenseUpdate,
      delete: expenseDelete,
      findUnique: expenseFindUnique,
    },
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createExpenseAction, updateExpenseAction, deleteExpenseAction } =
  await import("@/app/actions/admin-costs");

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

function baseFields(over: Record<string, string> = {}): Record<string, string> {
  return {
    vendor: "vercel",
    category: "hosting",
    amount: "199.50",
    currency: "MXN",
    periodMonth: "2026-07",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  expenseFindUnique.mockResolvedValue({ id: "expense1" });
});

describe("createExpenseAction", () => {
  it("rejects an invalid vendor", async () => {
    const res = await createExpenseAction(undefined, form(baseFields({ vendor: "not-a-vendor" })));
    expect(res).toHaveProperty("error");
    expect(expenseCreate).not.toHaveBeenCalled();
  });

  it("rejects a non-positive amount", async () => {
    const res = await createExpenseAction(undefined, form(baseFields({ amount: "0" })));
    expect(res).toHaveProperty("error");
    expect(expenseCreate).not.toHaveBeenCalled();
  });

  it("rejects a malformed period month", async () => {
    const res = await createExpenseAction(
      undefined,
      form(baseFields({ periodMonth: "July 2026" })),
    );
    expect(res).toHaveProperty("error");
    expect(expenseCreate).not.toHaveBeenCalled();
  });

  it("rejects vendor 'other' with no vendorLabel", async () => {
    const res = await createExpenseAction(undefined, form(baseFields({ vendor: "other" })));
    expect(res).toHaveProperty("error");
    expect(expenseCreate).not.toHaveBeenCalled();
  });

  it("converts amount to minor units in the entry's currency", async () => {
    const res = await createExpenseAction(undefined, form(baseFields({ amount: "19.99" })));
    expect(res).toEqual({ ok: true });
    const data = expenseCreate.mock.calls[0][0].data as {
      amountMinorUnits: number;
      currency: string;
    };
    expect(data.amountMinorUnits).toBe(1_999);
    expect(data.currency).toBe("MXN");
  });

  it("stores vendorLabel for 'other' and null for a known vendor", async () => {
    await createExpenseAction(
      undefined,
      form(baseFields({ vendor: "other", vendorLabel: "Namecheap" })),
    );
    const otherData = expenseCreate.mock.calls[0][0].data as { vendorLabel: string | null };
    expect(otherData.vendorLabel).toBe("Namecheap");

    await createExpenseAction(undefined, form(baseFields()));
    const knownData = expenseCreate.mock.calls[1][0].data as { vendorLabel: string | null };
    expect(knownData.vendorLabel).toBeNull();
  });

  it("stores periodMonth as the first of the given month (UTC)", async () => {
    await createExpenseAction(undefined, form(baseFields({ periodMonth: "2026-07" })));
    const data = expenseCreate.mock.calls[0][0].data as { periodMonth: Date };
    expect(data.periodMonth.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("updateExpenseAction", () => {
  it("404s on an unknown id", async () => {
    expenseFindUnique.mockResolvedValueOnce(null);
    const res = await updateExpenseAction(undefined, form({ id: "missing", ...baseFields() }));
    expect(res).toHaveProperty("error");
    expect(expenseUpdate).not.toHaveBeenCalled();
  });

  it("updates an existing entry", async () => {
    const res = await updateExpenseAction(
      undefined,
      form({ id: "expense1", ...baseFields({ amount: "50" }) }),
    );
    expect(res).toEqual({ ok: true });
    expect(expenseUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "expense1" } }),
    );
  });
});

describe("deleteExpenseAction", () => {
  it("404s on an unknown id", async () => {
    expenseFindUnique.mockResolvedValueOnce(null);
    const res = await deleteExpenseAction(undefined, form({ id: "missing" }));
    expect(res).toHaveProperty("error");
    expect(expenseDelete).not.toHaveBeenCalled();
  });

  it("deletes an existing entry", async () => {
    const res = await deleteExpenseAction(undefined, form({ id: "expense1" }));
    expect(res).toEqual({ ok: true });
    expect(expenseDelete).toHaveBeenCalledWith({ where: { id: "expense1" } });
  });
});
