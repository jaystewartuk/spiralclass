import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// Financial Intelligence estimate layer (D-86, S4) — the /admin/economics
// write side. Pins: pricing-model JSON is validated in two stages (syntax,
// then the shared discriminated-union schema) before ever reaching Prisma;
// a duplicate `key` surfaces as a friendly error, not a 500; the usage-input
// upsert keys off (metric, periodMonth) rather than an id; and every
// mutation writes an audit row via writeOverride.

vi.mock("@/lib/admin", () => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", role: "finance" })),
}));
vi.mock("@/lib/i18n", () => ({ getPreferredLocale: vi.fn(async () => "en") }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const writeOverride = vi.fn(async () => "override1");
vi.mock("@/lib/audit", () => ({ writeOverride }));

const state = {
  integrationCreateError: null as unknown,
  integrationUpdateError: null as unknown,
};

const integrationCreate = vi.fn(async (arg: { data: Record<string, unknown> }) => {
  if (state.integrationCreateError) throw state.integrationCreateError;
  return { id: "new-integration", ...arg.data };
});
const integrationUpdate = vi.fn(async (arg: { data: Record<string, unknown> }) => {
  if (state.integrationUpdateError) throw state.integrationUpdateError;
  return { id: "integration1", ...arg.data };
});
const integrationDelete = vi.fn(async (_arg: unknown) => ({}));
const integrationFindUnique = vi.fn(
  async (
    _arg: unknown,
  ): Promise<{
    id: string;
    key: string;
    name: string;
    category: string;
    active: boolean;
  } | null> => ({
    id: "integration1",
    key: "vercel",
    name: "Vercel",
    category: "hosting",
    active: true,
  }),
);
const integrationAggregate = vi.fn(async (_arg: unknown) => ({ _max: { sortOrder: 3 } }));

const usageInputUpsert = vi.fn(async (_arg: unknown) => ({ id: "usage1" }));
const usageInputDelete = vi.fn(async (_arg: unknown) => ({}));
const usageInputFindUnique = vi.fn(
  async (
    _arg: unknown,
  ): Promise<{ id: string; metric: string; periodMonth: Date; value: number } | null> => ({
    id: "usage1",
    metric: "lessons",
    periodMonth: new Date("2026-07-01T00:00:00.000Z"),
    value: 120,
  }),
);

const assumptionsFindUnique = vi.fn(async (_arg: unknown) => null);
const assumptionsUpsert = vi.fn(async (_arg: unknown) => ({ id: "default" }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integration: {
      create: integrationCreate,
      update: integrationUpdate,
      delete: integrationDelete,
      findUnique: integrationFindUnique,
      aggregate: integrationAggregate,
    },
    usageInput: {
      upsert: usageInputUpsert,
      delete: usageInputDelete,
      findUnique: usageInputFindUnique,
    },
    economicsAssumptions: {
      findUnique: assumptionsFindUnique,
      upsert: assumptionsUpsert,
    },
  },
}));

const {
  createIntegrationAction,
  updateIntegrationAction,
  toggleIntegrationActiveAction,
  deleteIntegrationAction,
  upsertUsageInputAction,
  deleteUsageInputAction,
  updateAssumptionsAction,
} = await import("@/app/actions/admin-economics");

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

function baseIntegrationFields(over: Record<string, string> = {}): Record<string, string> {
  return {
    key: "vercel",
    name: "Vercel",
    category: "hosting",
    currency: "USD",
    pricingModelJson: JSON.stringify({ kind: "free" }),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.integrationCreateError = null;
  state.integrationUpdateError = null;
  integrationFindUnique.mockResolvedValue({
    id: "integration1",
    key: "vercel",
    name: "Vercel",
    category: "hosting",
    active: true,
  });
  usageInputFindUnique.mockResolvedValue({
    id: "usage1",
    metric: "lessons",
    periodMonth: new Date("2026-07-01T00:00:00.000Z"),
    value: 120,
  });
  assumptionsFindUnique.mockResolvedValue(null);
});

describe("createIntegrationAction", () => {
  it("rejects an invalid category", async () => {
    const res = await createIntegrationAction(
      undefined,
      form(baseIntegrationFields({ category: "not-a-category" })),
    );
    expect(res).toHaveProperty("error");
    expect(integrationCreate).not.toHaveBeenCalled();
  });

  it("rejects malformed pricing-model JSON", async () => {
    const res = await createIntegrationAction(
      undefined,
      form(baseIntegrationFields({ pricingModelJson: "{not json" })),
    );
    expect(res).toHaveProperty("error");
    expect(integrationCreate).not.toHaveBeenCalled();
  });

  it("rejects pricing-model JSON that doesn't match the shared schema", async () => {
    const res = await createIntegrationAction(
      undefined,
      form(baseIntegrationFields({ pricingModelJson: JSON.stringify({ kind: "monthly" }) })),
    );
    expect(res).toHaveProperty("error");
    expect(integrationCreate).not.toHaveBeenCalled();
  });

  it("creates with a valid pricing model, appended after the current max sortOrder", async () => {
    const res = await createIntegrationAction(undefined, form(baseIntegrationFields()));
    expect(res).toEqual({ ok: true });
    const data = integrationCreate.mock.calls[0][0].data as {
      sortOrder: number;
      pricingModel: unknown;
    };
    expect(data.sortOrder).toBe(4);
    expect(data.pricingModel).toEqual({ kind: "free" });
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create_integration" }),
    );
  });

  it("surfaces a duplicate key as a friendly error, not a throw", async () => {
    state.integrationCreateError = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "6",
    });
    const res = await createIntegrationAction(undefined, form(baseIntegrationFields()));
    expect(res).toEqual({ error: "That key is already in use" });
  });
});

describe("updateIntegrationAction", () => {
  it("404s on an unknown id", async () => {
    integrationFindUnique.mockResolvedValueOnce(null);
    const res = await updateIntegrationAction(
      undefined,
      form({ id: "missing", ...baseIntegrationFields() }),
    );
    expect(res).toHaveProperty("error");
    expect(integrationUpdate).not.toHaveBeenCalled();
  });

  it("updates an existing integration and audits the change", async () => {
    const res = await updateIntegrationAction(
      undefined,
      form({ id: "integration1", ...baseIntegrationFields({ name: "Vercel (updated)" }) }),
    );
    expect(res).toEqual({ ok: true });
    expect(integrationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "integration1" } }),
    );
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ action: "update_integration" }),
    );
  });
});

describe("toggleIntegrationActiveAction", () => {
  it("404s on an unknown id", async () => {
    integrationFindUnique.mockResolvedValueOnce(null);
    const res = await toggleIntegrationActiveAction(
      undefined,
      form({ id: "missing", active: "false" }),
    );
    expect(res).toHaveProperty("error");
    expect(integrationUpdate).not.toHaveBeenCalled();
  });

  it("flips active and audits activate vs deactivate distinctly", async () => {
    const res = await toggleIntegrationActiveAction(
      undefined,
      form({ id: "integration1", active: "false" }),
    );
    expect(res).toEqual({ ok: true });
    expect(integrationUpdate).toHaveBeenCalledWith({
      where: { id: "integration1" },
      data: { active: false },
    });
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ action: "deactivate_integration" }),
    );
  });
});

describe("deleteIntegrationAction", () => {
  it("404s on an unknown id", async () => {
    integrationFindUnique.mockResolvedValueOnce(null);
    const res = await deleteIntegrationAction(undefined, form({ id: "missing" }));
    expect(res).toHaveProperty("error");
    expect(integrationDelete).not.toHaveBeenCalled();
  });

  it("deletes an existing integration and audits it", async () => {
    const res = await deleteIntegrationAction(undefined, form({ id: "integration1" }));
    expect(res).toEqual({ ok: true });
    expect(integrationDelete).toHaveBeenCalledWith({ where: { id: "integration1" } });
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete_integration" }),
    );
  });
});

describe("upsertUsageInputAction", () => {
  it("rejects an unknown metric", async () => {
    const res = await upsertUsageInputAction(
      undefined,
      form({ metric: "not-a-metric", periodMonth: "2026-07", value: "10" }),
    );
    expect(res).toHaveProperty("error");
    expect(usageInputUpsert).not.toHaveBeenCalled();
  });

  it("rejects a negative value", async () => {
    const res = await upsertUsageInputAction(
      undefined,
      form({ metric: "lessons", periodMonth: "2026-07", value: "-5" }),
    );
    expect(res).toHaveProperty("error");
    expect(usageInputUpsert).not.toHaveBeenCalled();
  });

  it("upserts keyed on the compound (metric, periodMonth) unique, first-of-month UTC", async () => {
    const res = await upsertUsageInputAction(
      undefined,
      form({
        metric: "lessons",
        periodMonth: "2026-07",
        value: "120",
        notes: "from Stripe dashboard",
      }),
    );
    expect(res).toEqual({ ok: true });
    const arg = usageInputUpsert.mock.calls[0][0] as {
      where: { metric_periodMonth: { metric: string; periodMonth: Date } };
      create: { value: number };
    };
    expect(arg.where.metric_periodMonth.metric).toBe("lessons");
    expect(arg.where.metric_periodMonth.periodMonth.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(arg.create.value).toBe(120);
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ action: "upsert_usage_input" }),
    );
  });
});

describe("deleteUsageInputAction", () => {
  it("404s on an unknown id", async () => {
    usageInputFindUnique.mockResolvedValueOnce(null);
    const res = await deleteUsageInputAction(undefined, form({ id: "missing" }));
    expect(res).toHaveProperty("error");
    expect(usageInputDelete).not.toHaveBeenCalled();
  });

  it("deletes an existing usage entry", async () => {
    const res = await deleteUsageInputAction(undefined, form({ id: "usage1" }));
    expect(res).toEqual({ ok: true });
    expect(usageInputDelete).toHaveBeenCalledWith({ where: { id: "usage1" } });
  });
});

describe("updateAssumptionsAction", () => {
  function baseAssumptionsFields(over: Record<string, string> = {}): Record<string, string> {
    return {
      fxUsdToGbp: "0.79",
      fxMxnToGbp: "0.046",
      fxEurToGbp: "0.86",
      allocationBasis: "active_teachers",
      fxAsOf: "2026-07-01",
      ...over,
    };
  }

  it("rejects a non-positive FX rate", async () => {
    const res = await updateAssumptionsAction(
      undefined,
      form(baseAssumptionsFields({ fxUsdToGbp: "0" })),
    );
    expect(res).toHaveProperty("error");
    expect(assumptionsUpsert).not.toHaveBeenCalled();
  });

  it("rejects an invalid allocation basis", async () => {
    const res = await updateAssumptionsAction(
      undefined,
      form(baseAssumptionsFields({ allocationBasis: "random" })),
    );
    expect(res).toHaveProperty("error");
    expect(assumptionsUpsert).not.toHaveBeenCalled();
  });

  it("upserts the singleton row and audits it", async () => {
    const res = await updateAssumptionsAction(undefined, form(baseAssumptionsFields()));
    expect(res).toEqual({ ok: true });
    expect(assumptionsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "default" } }),
    );
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ action: "update_economics_assumptions" }),
    );
  });
});
