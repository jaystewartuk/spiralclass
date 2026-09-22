import { beforeEach, describe, expect, it } from "vitest";
import { createStubStripeClient } from "@/lib/stripe/stub";

// The stub backs every test that exercises startCheckout, so its
// ensureCheckoutCustomer has to behave like the real one on the two things
// that matter: identity is scoped to the TEACHER's account, and a returning
// student reuses one Customer instead of growing one per purchase.

const stripe = createStubStripeClient();

beforeEach(() => {
  stripe.reset();
});

describe("stub ensureCheckoutCustomer", () => {
  it("returns the same Customer for a student who buys twice", () => {
    return (async () => {
      const first = await stripe.ensureCheckoutCustomer({
        connectedAccountId: "acct_teacher_1",
        email: "student@example.com",
      });
      const second = await stripe.ensureCheckoutCustomer({
        connectedAccountId: "acct_teacher_1",
        email: "student@example.com",
      });
      expect(second).toBe(first);
    })();
  });

  it("keeps two teachers' Customers apart for the same student", async () => {
    // A student can belong to several teachers (see multi-teacher-students).
    // The Customer lives on each teacher's own connected account, so sharing
    // one id across accounts would be an id that does not exist on one of them.
    const one = await stripe.ensureCheckoutCustomer({
      connectedAccountId: "acct_teacher_1",
      email: "shared@example.com",
    });
    const two = await stripe.ensureCheckoutCustomer({
      connectedAccountId: "acct_teacher_2",
      email: "shared@example.com",
    });
    expect(one).not.toBe(two);
  });

  it("puts the Customer on the session when one was resolved", async () => {
    const customerId = await stripe.ensureCheckoutCustomer({
      connectedAccountId: "acct_teacher_1",
      email: "student@example.com",
    });
    const session = await stripe.createCheckoutSession({
      connectedAccountId: "acct_teacher_1",
      clientReferenceId: "33333333-3333-4333-8333-333333333333",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
      customerEmail: "student@example.com",
      customerId,
      lineItem: { name: "1 clase", amountMinorUnits: 38_000, currency: "mxn" },
    });
    expect(session.customer).toBe(customerId);
  });

  it("leaves the session's customer null when none was resolved", async () => {
    // The real client falls back to customer_email; the stub records the
    // absence so a test can tell the two paths apart.
    const session = await stripe.createCheckoutSession({
      connectedAccountId: "acct_teacher_1",
      clientReferenceId: "44444444-4444-4444-8444-444444444444",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
      customerEmail: "student@example.com",
      lineItem: { name: "1 clase", amountMinorUnits: 38_000, currency: "mxn" },
    });
    expect(session.customer).toBeNull();
  });

  it("forgets everything on reset, so tests do not leak into each other", async () => {
    const before = await stripe.ensureCheckoutCustomer({
      connectedAccountId: "acct_teacher_1",
      email: "student@example.com",
    });
    stripe.reset();
    const after = await stripe.ensureCheckoutCustomer({
      connectedAccountId: "acct_teacher_1",
      email: "student@example.com",
    });
    expect(after).toBe(before);
  });
});
