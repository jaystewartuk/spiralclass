import { beforeEach, describe, expect, it, vi } from "vitest";

// Teacher Wise-payment confirm/fail actions. The mutation core is
// confirmTransferPayment (covered separately); this verifies the action shells:
// validation redirect, the tenancy guard (only the owning teacher), the
// outcome→redirect mapping, and the fail-path provider/status guards.

class RedirectError extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/inngest/client", () => ({ inngest: { send: vi.fn() } }));
vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));

const state = {
  owns: { id: "pay1" } as { id: string } | null,
  outcome: { code: "paid" } as { code: string },
  failPayment: {
    id: "pay1",
    provider: "manual_transfer",
    status: "pending",
    package: { id: "pkg1", status: "pending" },
  } as Record<string, unknown> | null,
};

const confirmTransferPayment = vi.fn(async () => state.outcome);
vi.mock("@/lib/payments/transfer-confirm", () => ({ confirmTransferPayment }));

const paymentUpdate = vi.fn(async () => ({}));
const packageUpdate = vi.fn(async () => ({}));
const overrideCreate = vi.fn(async () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: { findFirst: vi.fn(async () => (callIsFail ? state.failPayment : state.owns)) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        payment: { update: paymentUpdate },
        package: { update: packageUpdate },
        override: { create: overrideCreate },
      }),
    ),
  },
}));

let callIsFail = false;
const { confirmTransferPaymentAction, failWisePaymentAction } =
  await import("@/app/actions/wise-confirm");

const PID = "11111111-1111-4111-8111-111111111111";
function fd(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("paymentId", PID);
  f.set("note", "Recibido");
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof RedirectError) return err.url;
    throw err;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  vi.clearAllMocks();
  callIsFail = false;
  state.owns = { id: "pay1" };
  state.outcome = { code: "paid" };
  state.failPayment = {
    id: "pay1",
    provider: "manual_transfer",
    status: "pending",
    package: { id: "pkg1", status: "pending" },
  };
});

describe("confirmTransferPaymentAction", () => {
  it("redirects with missing-fields on invalid input", async () => {
    expect(await redirectOf(() => confirmTransferPaymentAction(fd({ paymentId: "x" })))).toMatch(
      /missing-fields/,
    );
  });

  it("refuses a payment the teacher doesn't own", async () => {
    state.owns = null;
    expect(await redirectOf(() => confirmTransferPaymentAction(fd()))).toMatch(/missing-payment/);
    expect(confirmTransferPayment).not.toHaveBeenCalled();
  });

  it("redirects to not-wise for a wrong-provider outcome", async () => {
    state.outcome = { code: "wrong-provider" };
    expect(await redirectOf(() => confirmTransferPaymentAction(fd()))).toMatch(/error=not-wise/);
  });

  it("confirms and redirects with wise_confirmed=1", async () => {
    const url = await redirectOf(() => confirmTransferPaymentAction(fd()));
    expect(url).toMatch(/wise_confirmed=1/);
    expect(confirmTransferPayment).toHaveBeenCalledTimes(1);
  });
});

describe("failWisePaymentAction", () => {
  beforeEach(() => {
    callIsFail = true;
  });

  it("refuses a non-wise payment", async () => {
    state.failPayment = {
      id: "pay1",
      provider: "stripe",
      status: "pending",
      package: { id: "pkg1", status: "pending" },
    };
    expect(await redirectOf(() => failWisePaymentAction(fd()))).toMatch(/not-wise/);
    expect(paymentUpdate).not.toHaveBeenCalled();
  });

  it("refuses a non-pending payment", async () => {
    state.failPayment = {
      id: "pay1",
      provider: "manual_transfer",
      status: "paid",
      package: { id: "pkg1", status: "active" },
    };
    expect(await redirectOf(() => failWisePaymentAction(fd()))).toMatch(/not-pending/);
  });

  it("fails the payment and expires the pending package", async () => {
    await redirectOf(() => failWisePaymentAction(fd()));
    expect(paymentUpdate).toHaveBeenCalledWith({
      where: { id: "pay1" },
      data: { status: "failed" },
    });
    expect(packageUpdate).toHaveBeenCalledWith({
      where: { id: "pkg1" },
      data: { status: "expired" },
    });
    expect(overrideCreate).toHaveBeenCalled();
  });
});
