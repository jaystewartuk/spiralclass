import { beforeEach, describe, expect, it, vi } from "vitest";

// Server-action shell for the public checkout funnel. The money math lives in
// startCheckout (covered separately); this verifies the action's own job:
//   * reject malformed form input before any DB work,
//   * refuse unavailable/un-onboarded teachers and the unready rail,
//   * block platform-disabled students (moderation can't be bypassed by
//     paying through a second teacher),
//   * upsert the roster student then hand off to startCheckout and redirect
//     to whatever target it returns.
//
// tests/setup.ts pins the locale cookie to es-MX, so getPreferredLocale()
// resolves Spanish here without extra mocking.

const TEMPLATE_ID = "11111111-1111-4111-8111-111111111111";

const state = {
  teacher: null as Record<string, unknown> | null,
  template: null as Record<string, unknown> | null,
  disabledStudent: null as { id: string } | null,
  railError: null as string | null,
  startResult: { mode: "redirect", redirectTo: "https://checkout.stripe.com/c/cs_1" } as
    | { mode: "redirect"; redirectTo: string; externalReference?: string }
    | { mode: "embedded"; clientSecret: string; externalReference?: string }
    | { error: string },
};

// redirect() throws NEXT_REDIRECT in Next; mirror that so the action stops and
// we can read the target off the thrown sentinel.
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

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // D-113: the payout-instrument delegate. Empty by default — a test that
    // cares about a specific instrument overrides it.
    teacherPayoutInstrument: {
      findMany: async () => [],
      findFirst: async () => null,
      findUnique: async () => null,
      count: async () => 0,
      upsert: async () => ({
        kind: "wise",
        enabled: false,
        wiseHandle: null,
        schemeId: null,
        details: null,
      }),
      updateMany: async () => ({ count: 0 }),
    },
    teacher: { findUnique: vi.fn(async () => state.teacher) },
    packageTemplate: { findFirst: vi.fn(async () => state.template) },
    student: { findFirst: vi.fn(async () => state.disabledStudent) },
  },
}));

const startCheckout = vi.fn(async () => state.startResult);
vi.mock("@/lib/payments/start-checkout", () => ({
  railReadinessError: () => state.railError,
  startCheckout,
}));

const findOrCreateRosterStudent = vi.fn(async () => ({
  id: "s1",
  email: "mira@example.com",
  name: "Mira",
}));
class TeacherEmailConflictError extends Error {}
vi.mock("@/lib/students/find-or-create", () => ({
  findOrCreateRosterStudent,
  TeacherEmailConflictError,
}));

const { createCheckoutIntent } = await import("@/app/actions/checkout");

function formData(over: Record<string, string> = {}): FormData {
  const fd = new FormData();
  const base: Record<string, string> = {
    slug: "mira",
    templateId: TEMPLATE_ID,
    studentName: "Mira",
    studentEmail: "mira@example.com",
    paymentMethod: "stripe",
    // The checkout form no longer collects a phone, so it submits no
    // studentPhone field at all — the action coerces the resulting null to
    // undefined before the schema runs. posthogSessionId is still sent empty.
    posthogSessionId: "",
  };
  for (const [k, v] of Object.entries({ ...base, ...over })) fd.set(k, v);
  return fd;
}

const onboardedTeacher = {
  id: "t1",
  name: "Mira",
  bookingSlug: "mira",
  onboardingCompleteAt: new Date(),
  disabledAt: null,
  stripeAccountId: "acct_1",
  stripeChargesEnabled: true,
  pricingCurrency: "MXN",
  payoutInstruments: [
    { kind: "wise", enabled: true, wiseHandle: "@mira", schemeId: null, details: null },
  ],
  // isPubliclyListed also requires a
  // real profile and a reviewed offer/schedule.
  photoPath: "teachers/t1/photo.jpg",
  bio: "Profesora de inglés.",
  templatesTouchedAt: new Date(),
  availabilityTouchedAt: new Date(),
};

async function run(
  fd: FormData,
): Promise<
  { error?: string } | { redirectTo: string } | { clientSecret: string; externalReference: string }
> {
  try {
    const res = await createCheckoutIntent(undefined, fd);
    return res ?? {};
  } catch (err) {
    if (err instanceof RedirectError) return { redirectTo: err.url };
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.teacher = { ...onboardedTeacher };
  state.template = { id: TEMPLATE_ID, teacherId: "t1", name: "10 clases" };
  state.disabledStudent = null;
  state.railError = null;
  state.startResult = { mode: "redirect", redirectTo: "https://checkout.stripe.com/c/cs_1" };
});

describe("createCheckoutIntent", () => {
  it("rejects malformed input before any DB lookup", async () => {
    const res = await run(formData({ studentEmail: "not-an-email" }));
    expect(res).toHaveProperty("error");
    expect(findOrCreateRosterStudent).not.toHaveBeenCalled();
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it("rejects a missing or un-onboarded teacher", async () => {
    state.teacher = null;
    expect(await run(formData())).toHaveProperty("error");

    state.teacher = { ...onboardedTeacher, onboardingCompleteAt: null };
    expect(await run(formData())).toHaveProperty("error");
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it("rejects an onboarded-but-not-Marketplace-Ready teacher (no profile photo)", async () => {
    // finishing the wizard alone is no
    // longer enough for the public/anonymous checkout funnel — same gate as
    // the booking landing page.
    state.teacher = { ...onboardedTeacher, photoPath: null };
    expect(await run(formData())).toHaveProperty("error");
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it("surfaces the rail-readiness error", async () => {
    state.railError = "Esta maestra no acepta pagos con tarjeta.";
    const res = await run(formData());
    expect(res).toEqual({
      error: "Esta maestra no acepta pagos con tarjeta.",
      // Echoed back so React 19's post-action form reset restores the fields
      // rather than blanking them — see CheckoutFormValues in actions/checkout.ts.
      values: { studentName: "Mira", studentEmail: "mira@example.com" },
    });
  });

  it("rejects a non-existent template", async () => {
    state.template = null;
    expect(await run(formData())).toHaveProperty("error");
  });

  it("blocks a platform-disabled student", async () => {
    state.disabledStudent = { id: "blocked" };
    const res = await run(formData());
    expect(res).toHaveProperty("error");
    expect(startCheckout).not.toHaveBeenCalled();
  });

  it("upserts the student and redirects to startCheckout's target", async () => {
    const res = await run(formData());
    expect(findOrCreateRosterStudent).toHaveBeenCalledTimes(1);
    expect(startCheckout).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ redirectTo: "https://checkout.stripe.com/c/cs_1" });
  });

  it("succeeds with no phone field (the form no longer collects one)", async () => {
    // Regression: FormData.get returns null for the absent field; the action
    // must coerce it to undefined so the optional-phone schema doesn't reject.
    const res = await run(formData());
    expect(res).toEqual({ redirectTo: "https://checkout.stripe.com/c/cs_1" });
    expect(findOrCreateRosterStudent).toHaveBeenCalledWith(
      expect.objectContaining({ phoneE164: null }),
    );
  });

  it("returns startCheckout's error instead of redirecting", async () => {
    state.startResult = { error: "Stripe no devolvió un enlace de pago." };
    const res = await run(formData());
    expect(res).toEqual({
      error: "Stripe no devolvió un enlace de pago.",
      values: { studentName: "Mira", studentEmail: "mira@example.com" },
    });
  });

  it("returns the client secret (no redirect) when startCheckout resolves in embedded mode", async () => {
    state.startResult = {
      mode: "embedded",
      clientSecret: "cs_1_secret_abc",
      externalReference: "ref-1",
    };
    const res = await run(formData());
    expect(res).toEqual({ clientSecret: "cs_1_secret_abc", externalReference: "ref-1" });
  });

  it("rejects checkout when the email belongs to a Teacher account (D-38)", async () => {
    findOrCreateRosterStudent.mockRejectedValueOnce(new TeacherEmailConflictError("conflict"));
    const res = await run(formData());
    expect(res).toHaveProperty("error");
    expect(startCheckout).not.toHaveBeenCalled();
  });
});
