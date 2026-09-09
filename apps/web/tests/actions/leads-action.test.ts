import { beforeEach, describe, expect, it, vi } from "vitest";

// Public booking-page lead capture (captureLead, anonymous /b/[slug]) plus the
// teacher-side lifecycle move (setLeadStatus). Pins: form validation, the
// teacher-availability gate (unknown / not-onboarded / disabled → refusal), the
// best-effort teacher alert never failing a committed lead, and the
// teacher-scoped status update (`where { id, teacherId }`, count==0 → not-found).

const state = {
  teacher: null as null | {
    id: string;
    name: string;
    email: string;
    locale: string;
    bookingSlug: string;
    onboardingCompleteAt: Date | null;
    disabledAt: Date | null;
    photoPath: string | null;
    bio: string | null;
    templatesTouchedAt: Date | null;
    availabilityTouchedAt: Date | null;
    stripeChargesEnabled: boolean;
    pricingCurrency: string;
    payoutInstruments: {
      kind: "wise" | "spei";
      enabled: boolean;
      wiseHandle: string | null;
      clabe: string | null;
    }[];
  },
  statusUpdateCount: 1,
};

const teacherFindUnique = vi.fn(async () => state.teacher);
const leadCreate = vi.fn(async (_a: { data: Record<string, unknown> }) => ({ id: "lead1" }));
const leadUpdateMany = vi.fn(
  async (_a: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
    count: state.statusUpdateCount,
  }),
);
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
    teacher: { findUnique: teacherFindUnique },
    lead: { create: leadCreate, updateMany: leadUpdateMany },
  },
}));

vi.mock("@/lib/auth", () => ({
  requireOnboardedTeacher: vi.fn(async () => ({ id: "t1" })),
}));

const notifyTeacherOfLead = vi.fn(async () => {});
vi.mock("@/lib/leads/notify-teacher", () => ({ notifyTeacherOfLead }));

const trackServerEvent = vi.fn();
const flushAnalytics = vi.fn(async () => {});
vi.mock("@/lib/analytics/posthog", () => ({ trackServerEvent, flushAnalytics }));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

// Mocked rather than exercised for real: the in-memory limiter backend keeps
// state across calls, so the real thing would let the 6th test in this file
// fail on a bucket the 5th filled.
const rateLimit = vi.fn(async () => ({ ok: true }) as { ok: boolean });
const clientIp = vi.fn(async () => "198.51.100.4");
vi.mock("@/lib/rate-limit", () => ({ rateLimit, clientIp }));

const { captureLead, setLeadStatus } = await import("@/app/actions/leads");

function leadForm(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// Real forms always send the optional fields as "" (the inputs are rendered),
// and the schema's optional() rejects a literal null — so set them explicitly,
// otherwise the gate tests below would pass on a schema error instead of the gate.
const validLead = {
  slug: "mira",
  name: "Sofía",
  email: "sofia@example.com",
  phone: "",
  message: "",
  posthogSessionId: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  state.teacher = {
    id: "t1",
    name: "Mira",
    email: "mira@example.com",
    locale: "es-MX",
    bookingSlug: "mira",
    onboardingCompleteAt: new Date("2026-01-01"),
    disabledAt: null,
    // isPubliclyListed also requires a
    // real profile, a reviewed offer/schedule, and a connected payout rail.
    photoPath: "teachers/t1/photo.jpg",
    bio: "Profesora de inglés.",
    templatesTouchedAt: new Date("2026-01-01"),
    availabilityTouchedAt: new Date("2026-01-01"),
    stripeChargesEnabled: true,
    pricingCurrency: "MXN",
    payoutInstruments: [],
  };
  state.statusUpdateCount = 1;
  rateLimit.mockResolvedValue({ ok: true });
});

// This action is anonymous, writes a row, and emails the teacher on every
// submission — so once the booking URL is posted publicly it is an
// email-amplification vector. Checkout has been throttled on both axes since
// launch; this one was not.
describe("captureLead — abuse protection", () => {
  it("throttles per IP and per sender, and writes nothing when throttled", async () => {
    rateLimit.mockResolvedValue({ ok: false });
    const res = await captureLead(undefined, leadForm(validLead));

    expect(res).toHaveProperty("error");
    expect(leadCreate).not.toHaveBeenCalled();
    // The teacher alert is the thing being amplified — it must not fire.
    expect(notifyTeacherOfLead).not.toHaveBeenCalled();
  });

  it("checks the limiter before touching the database", async () => {
    rateLimit.mockResolvedValue({ ok: false });
    await captureLead(undefined, leadForm(validLead));
    expect(teacherFindUnique).not.toHaveBeenCalled();
  });

  it("buckets the sender by teacher + lowercased email", async () => {
    await captureLead(undefined, leadForm({ ...validLead, email: "Sofia@Example.COM" }));

    // The numbers are deployment configuration (RATE_LIMIT_* — see
    // lib/rate-limit.ts), so assert the bucket key and the scope rather than
    // the values a given environment happens to enforce.
    expect(rateLimit).toHaveBeenCalledWith(
      "198.51.100.4",
      expect.objectContaining({ scope: "lead-capture" }),
    );
    // Lowercased so alternating capitalisation can't mint a fresh bucket.
    expect(rateLimit).toHaveBeenCalledWith(
      "mira:sofia@example.com",
      expect.objectContaining({ scope: "lead-capture-sender" }),
    );
  });

  it("silently discards a submission that fills the honeypot", async () => {
    const res = await captureLead(
      undefined,
      leadForm({ ...validLead, website: "http://spam.example" }),
    );

    // Reports success on purpose: a bot told it failed retries with the field
    // cleared; one told it succeeded moves on.
    expect(res).toEqual({ ok: true });
    expect(leadCreate).not.toHaveBeenCalled();
    expect(notifyTeacherOfLead).not.toHaveBeenCalled();
    // Checked before the limiter, so trivial bots don't burn a real
    // visitor's IP budget on a shared NAT.
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("lets a normal submission through with the honeypot left empty", async () => {
    const res = await captureLead(undefined, leadForm({ ...validLead, website: "" }));
    expect(res).toEqual({ ok: true });
    expect(leadCreate).toHaveBeenCalled();
  });
});

describe("captureLead", () => {
  it("rejects an invalid submission without writing a row", async () => {
    const res = await captureLead(undefined, leadForm({ slug: "mira", name: "", email: "x" }));
    expect(res).toHaveProperty("error");
    expect(leadCreate).not.toHaveBeenCalled();
  });

  it("refuses when the teacher isn't found", async () => {
    state.teacher = null;
    const res = await captureLead(undefined, leadForm(validLead));
    expect(res).toHaveProperty("error");
    expect(leadCreate).not.toHaveBeenCalled();
  });

  it("refuses when the teacher hasn't finished onboarding", async () => {
    state.teacher!.onboardingCompleteAt = null;
    expect(await captureLead(undefined, leadForm(validLead))).toHaveProperty("error");
    expect(leadCreate).not.toHaveBeenCalled();
  });

  it("refuses an onboarded-but-not-Marketplace-Ready teacher (no payout rail)", async () => {
    // same visibility rule as the
    // booking landing page this form lives on.
    state.teacher!.stripeChargesEnabled = false;
    expect(await captureLead(undefined, leadForm(validLead))).toHaveProperty("error");
    expect(leadCreate).not.toHaveBeenCalled();
  });

  it("refuses a disabled teacher", async () => {
    state.teacher!.disabledAt = new Date();
    expect(await captureLead(undefined, leadForm(validLead))).toHaveProperty("error");
    expect(leadCreate).not.toHaveBeenCalled();
  });

  it("creates a lead scoped to the resolved teacher and alerts them", async () => {
    const res = await captureLead(
      undefined,
      leadForm({ ...validLead, phone: "55 1234 5678", message: "Hola" }),
    );
    expect(res).toEqual({ ok: true });
    expect(leadCreate.mock.calls[0][0].data).toMatchObject({
      teacherId: "t1",
      name: "Sofía",
      email: "sofia@example.com",
      message: "Hola",
    });
    expect(notifyTeacherOfLead).toHaveBeenCalledTimes(1);
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "lead_captured" }),
    );
  });

  it("resolves the phone with the picked country instead of the MX default", async () => {
    const res = await captureLead(
      undefined,
      leadForm({ ...validLead, phone: "4155550123", phoneCountry: "US" }),
    );
    expect(res).toEqual({ ok: true });
    expect(leadCreate.mock.calls[0][0].data).toMatchObject({
      phoneE164: "+14155550123",
    });
  });

  it("falls back to the MX default when no phoneCountry is submitted", async () => {
    const res = await captureLead(undefined, leadForm({ ...validLead, phone: "5512345678" }));
    expect(res).toEqual({ ok: true });
    expect(leadCreate.mock.calls[0][0].data).toMatchObject({
      phoneE164: "+525512345678",
    });
  });

  it("still succeeds when the teacher alert throws (best-effort)", async () => {
    notifyTeacherOfLead.mockRejectedValueOnce(new Error("smtp down"));
    const res = await captureLead(undefined, leadForm(validLead));
    expect(res).toEqual({ ok: true });
    expect(leadCreate).toHaveBeenCalledTimes(1);
  });
});

describe("setLeadStatus", () => {
  it("rejects a bad status value", async () => {
    const res = await setLeadStatus(
      undefined,
      leadForm({ leadId: "11111111-1111-1111-1111-111111111111", status: "bogus" }),
    );
    expect(res).toHaveProperty("error");
    expect(leadUpdateMany).not.toHaveBeenCalled();
  });

  it("scopes the update by teacherId and reports not-found on count 0", async () => {
    state.statusUpdateCount = 0;
    const res = await setLeadStatus(
      undefined,
      leadForm({ leadId: "11111111-1111-1111-1111-111111111111", status: "contacted" }),
    );
    expect(res).toHaveProperty("error");
    expect(leadUpdateMany.mock.calls[0][0].where).toEqual({
      id: "11111111-1111-1111-1111-111111111111",
      teacherId: "t1",
    });
  });

  it("moves a lead forward and emits the matching transition event", async () => {
    const res = await setLeadStatus(
      undefined,
      leadForm({ leadId: "11111111-1111-1111-1111-111111111111", status: "converted" }),
    );
    expect(res).toEqual({ ok: true });
    expect(trackServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "lead_converted" }),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/leads");
  });

  it("does not emit a transition event when set back to 'new'", async () => {
    await setLeadStatus(
      undefined,
      leadForm({ leadId: "11111111-1111-1111-1111-111111111111", status: "new" }),
    );
    expect(trackServerEvent).not.toHaveBeenCalled();
  });
});
