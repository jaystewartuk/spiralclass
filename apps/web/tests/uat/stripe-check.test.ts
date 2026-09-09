import { beforeEach, describe, expect, it, vi } from "vitest";

// runStripeCheck (D-55, §B/§G automation) must refuse to run when the
// selected `env` doesn't match what this deployment actually is — otherwise
// it silently checks preview data while labeling the report "production" (or
// vice versa), since the Prisma/Stripe clients it uses always point at
// whatever's actually running, never at `env` itself.

let prodDeployment = false;
vi.mock("@/lib/env", () => ({ isProductionDeployment: () => prodDeployment }));

const paymentFindUnique = vi.fn();
const paymentFindFirst = vi.fn();
const studentFindFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      findUnique: (...args: unknown[]) => paymentFindUnique(...args),
      findFirst: (...args: unknown[]) => paymentFindFirst(...args),
    },
    student: { findFirst: (...args: unknown[]) => studentFindFirst(...args) },
  },
}));

const getSettledCharge = vi.fn();
const getCharge = vi.fn();
const getTransfer = vi.fn();
vi.mock("@/lib/stripe", () => ({
  getStripeClient: () => ({ getSettledCharge, getCharge, getTransfer }),
}));

const { runStripeCheck } = await import("@/lib/uat/stripe-check");

beforeEach(() => {
  prodDeployment = false;
  vi.clearAllMocks();
});

describe("runStripeCheck env-mismatch guard", () => {
  it("refuses when env='production' but this deployment is actually preview", async () => {
    prodDeployment = false;
    const report = await runStripeCheck("production", { paymentId: "p1" });
    expect(report.pass).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0].label).toBe("environment-match");
    expect(report.checks[0].detail).toContain("actually running on preview");
    expect(paymentFindUnique).not.toHaveBeenCalled();
  });

  it("refuses when env='preview' but this deployment is actually production", async () => {
    prodDeployment = true;
    const report = await runStripeCheck("preview", { paymentId: "p1" });
    expect(report.pass).toBe(false);
    expect(report.checks[0].label).toBe("environment-match");
    expect(report.checks[0].detail).toContain("actually running on production");
    expect(paymentFindUnique).not.toHaveBeenCalled();
  });

  it("proceeds normally when env='preview' matches an actual preview deployment", async () => {
    prodDeployment = false;
    paymentFindUnique.mockResolvedValue(null);
    const report = await runStripeCheck("preview", { paymentId: "p1" });
    expect(paymentFindUnique).toHaveBeenCalled();
    expect(report.checks[0].label).toBe("payment-exists");
  });

  it("proceeds normally when env='production' matches an actual production deployment", async () => {
    prodDeployment = true;
    paymentFindUnique.mockResolvedValue(null);
    const report = await runStripeCheck("production", { paymentId: "p1" });
    expect(paymentFindUnique).toHaveBeenCalled();
    expect(report.checks[0].label).toBe("payment-exists");
  });
});
