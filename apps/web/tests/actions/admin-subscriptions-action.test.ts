import { beforeEach, describe, expect, it, vi } from "vitest";

// Admin subscription actions (finance role). Comp activates a never-billed
// Pro subscription; manual-paid records a Wise invoice (fee 0, net = amount)
// then activates with a 30-day period. The lifecycle core is covered
// separately; this pins the action wiring + validation.

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/lib/prisma", () => ({
  prisma: { teacherSubscription: { findUnique: vi.fn(async () => null) } },
}));
vi.mock("@/lib/admin", () => ({
  requireAdmin: vi.fn(async () => ({ id: "admin1", email: "admin1@example.com", role: "finance" })),
}));
vi.mock("@/lib/audit", () => ({ writeOverride: vi.fn(async () => "override1") }));
vi.mock("@/lib/subscriptions/service", () => ({ lockedPriceForPlan: () => 14_900 }));

const activateSubscription = vi.fn(async (_deps: unknown, _args: Record<string, unknown>) => {});
const recordSubscriptionInvoice = vi.fn(
  async (_deps: unknown, _args: Record<string, unknown>) => {},
);
vi.mock("@/lib/subscriptions/lifecycle", () => ({
  activateSubscription,
  recordSubscriptionInvoice,
}));

const { markSubscriptionComped, markSubscriptionPaidManually } =
  await import("@/app/actions/admin-subscriptions");
const { writeOverride } = await import("@/lib/audit");

const TEACHER = "11111111-1111-4111-8111-111111111111";
function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

beforeEach(() => vi.clearAllMocks());

describe("markSubscriptionComped", () => {
  it("rejects a non-uuid teacher id", async () => {
    expect(await markSubscriptionComped(undefined, fd({ teacherId: "x" }))).toHaveProperty("error");
    expect(activateSubscription).not.toHaveBeenCalled();
  });

  it("activates a comped subscription (defaults to founding)", async () => {
    const res = await markSubscriptionComped(undefined, fd({ teacherId: TEACHER }));
    expect(res).toEqual({ ok: true });
    const arg = activateSubscription.mock.calls[0][1] as { comped: boolean; plan: string };
    expect(arg.comped).toBe(true);
    expect(arg.plan).toBe("founding");
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: TEACHER, action: "comp_subscription" }),
    );
  });
});

describe("markSubscriptionPaidManually", () => {
  it("rejects invalid input", async () => {
    expect(
      await markSubscriptionPaidManually(
        undefined,
        fd({ teacherId: TEACHER, plan: "free", amountMinorUnits: "100" }),
      ),
    ).toHaveProperty("error");
  });

  it("records a Wise invoice (fee 0) then activates the subscription", async () => {
    const res = await markSubscriptionPaidManually(
      undefined,
      fd({
        teacherId: TEACHER,
        plan: "monthly",
        amountMinorUnits: "19900",
        manualPaymentRef: "REF-9",
      }),
    );
    expect(res).toEqual({ ok: true });
    const inv = recordSubscriptionInvoice.mock.calls[0][1] as {
      feeMinorUnits: number;
      provider: string;
      amountMinorUnits: number;
      status: string;
    };
    expect(inv).toMatchObject({
      feeMinorUnits: 0,
      provider: "manual",
      amountMinorUnits: 19900,
      status: "paid",
    });
    expect(activateSubscription).toHaveBeenCalledTimes(1);
    expect(writeOverride).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId: TEACHER, action: "mark_subscription_paid_manually" }),
    );
  });
});
