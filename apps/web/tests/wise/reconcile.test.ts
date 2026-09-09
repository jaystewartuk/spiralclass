import { describe, expect, it, vi } from "vitest";
import {
  extractReference,
  matchCredits,
  reconcileWiseStatements,
  type ReconcilePayment,
} from "@/lib/payments/wise-reconcile";
import type { WiseClient, WiseCredit } from "@/lib/wise/api";

// Unit tests for automated Wise reconciliation. The matcher is pure; the
// orchestrator is driven with an in-memory Prisma fake (same style as
// tests/wise/confirm.test.ts) plus a stub Wise client.

const NOW = new Date("2026-06-03T12:00:00Z");

function credit(over: Partial<WiseCredit> = {}): WiseCredit {
  return {
    externalId: "BAL-1",
    reference: "AGP-1A2B3C4D",
    amountMinorUnits: 232_000,
    currency: "MXN",
    occurredAt: new Date("2026-06-02T09:00:00Z"),
    ...over,
  };
}

describe("extractReference", () => {
  it("pulls the AGP token out of surrounding text", () => {
    expect(extractReference("Pago clases AGP-1A2B3C4D gracias")).toBe("AGP-1A2B3C4D");
  });
  it("uppercases a lowercased token", () => {
    expect(extractReference("agp-1a2b3c4d")).toBe("AGP-1A2B3C4D");
  });
  it("returns null when no token is present", () => {
    expect(extractReference("transferencia sin referencia")).toBeNull();
    expect(extractReference(null)).toBeNull();
  });
});

describe("matchCredits", () => {
  const payments: ReconcilePayment[] = [
    { id: "p1", paymentReference: "AGP-1A2B3C4D", amountMinorUnits: 232_000, currency: "MXN" },
    { id: "p2", paymentReference: "AGP-99887766", amountMinorUnits: 150_000, currency: "MXN" },
  ];

  it("matches on reference + exact amount + MXN", () => {
    const { matches, mismatches } = matchCredits([credit()], payments);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.paymentId).toBe("p1");
    expect(mismatches).toHaveLength(0);
  });

  it("flags an amount mismatch instead of confirming", () => {
    const { matches, mismatches } = matchCredits([credit({ amountMinorUnits: 100_000 })], payments);
    expect(matches).toHaveLength(0);
    expect(mismatches).toEqual([expect.objectContaining({ paymentId: "p1", reason: "amount" })]);
  });

  it("flags a currency mismatch instead of confirming", () => {
    const { matches, mismatches } = matchCredits([credit({ currency: "USD" })], payments);
    expect(matches).toHaveLength(0);
    expect(mismatches[0]?.reason).toBe("currency");
  });

  it("ignores credits whose reference matches no pending payment", () => {
    const { matches, mismatches } = matchCredits([credit({ reference: "AGP-DEADBEEF" })], payments);
    expect(matches).toHaveLength(0);
    expect(mismatches).toHaveLength(0);
  });

  it("consumes each payment at most once when duplicate credits arrive", () => {
    const { matches } = matchCredits([credit(), credit({ externalId: "BAL-2" })], payments);
    expect(matches).toHaveLength(1);
  });
});

// --- orchestrator ---

type FakePaymentRow = {
  id: string;
  status: "pending" | "paid" | "failed" | "refunded";
  amountMinorUnits: number;
  currency: string;
  rail: "card" | "wise" | "unknown";
  provider: "stripe" | "manual_transfer";
  // Which payout instrument the student was shown (D-113). The reconciler
  // scopes its scan to this, so a fixture that omitted it would let a dropped
  // filter pass unnoticed.
  instrumentId: string | null;
  providerPaymentId: string | null;
  paymentReference: string | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  autoMatchedAt: Date | null;
  paidAt: Date | null;
  refundedAt: Date | null;
  createdAt: Date;
  posthogSessionId: string | null;
  package: {
    id: string;
    teacherId: string;
    studentId: string;
    templateId: string | null;
    status: "pending" | "active" | "expired" | "refunded";
  };
};

function freshPayment(): FakePaymentRow {
  return {
    id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
    status: "pending",
    amountMinorUnits: 232_000,
    currency: "MXN",
    rail: "unknown",
    provider: "manual_transfer",
    instrumentId: "11111111-1111-1111-1111-111111111111",
    providerPaymentId: null,
    paymentReference: "AGP-1A2B3C4D",
    confirmedBy: null,
    confirmedAt: null,
    autoMatchedAt: null,
    paidAt: null,
    refundedAt: null,
    createdAt: new Date("2026-06-02T08:00:00Z"),
    posthogSessionId: null,
    package: {
      id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      teacherId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      studentId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      templateId: null,
      status: "pending",
    },
  };
}

const TEACHER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// The reconciler reads Wise INSTRUMENTS now, not teachers (D-113): auto-
// reconcile is a capability of the instrument, which is what makes it
// structural that SPEI has none.
const INSTRUMENT_A = "11111111-1111-1111-1111-111111111111";

type FakeTeacher = {
  id: string;
  instrumentId: string;
  enabled: boolean;
  wiseApiProfileId: string | null;
  wiseApiTokenEnc: string | null;
  wiseApiKeyEnc: string | null;
};

function connectedTeacher(over: Partial<FakeTeacher> = {}): FakeTeacher {
  return {
    id: TEACHER_A,
    instrumentId: INSTRUMENT_A,
    enabled: true,
    wiseApiProfileId: "12345",
    wiseApiTokenEnc: "tok",
    wiseApiKeyEnc: "key",
    ...over,
  };
}

function makeFakePrisma(rows: FakePaymentRow[], teachers: FakeTeacher[]) {
  const overrides: { action: string }[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const fake: any = {
    teacherPayoutInstrument: {
      // Mirrors the reconciler's own `where`: kind=wise, enabled, and all
      // three credential columns present.
      findMany: async () =>
        teachers
          .filter(
            (t) =>
              t.enabled &&
              t.wiseApiProfileId !== null &&
              t.wiseApiTokenEnc !== null &&
              t.wiseApiKeyEnc !== null,
          )
          .map((t) => ({
            id: t.instrumentId,
            teacherId: t.id,
            wiseApiProfileId: t.wiseApiProfileId,
            wiseApiTokenEnc: t.wiseApiTokenEnc,
            wiseApiKeyEnc: t.wiseApiKeyEnc,
            teacher: { pricingCurrency: "MXN" },
          })),
    },
    payment: {
      // Honors the per-teacher relation filter the reconciler passes.
      findMany: async (args: any) => {
        const teacherId = args?.where?.package?.is?.teacherId;
        // D-113 scopes the scan to the instrument whose statement was just
        // read, so a teacher's SPEI payments can never be matched against her
        // Wise statement. Honor it here or the test would pass a reconciler
        // that had dropped the filter.
        const instrumentId = args?.where?.instrumentId;
        return rows
          .filter(
            (r) =>
              r.provider === "manual_transfer" &&
              r.status === "pending" &&
              r.paymentReference !== null &&
              (teacherId === undefined || r.package.teacherId === teacherId) &&
              (instrumentId === undefined || r.instrumentId === instrumentId),
          )
          .map((r) => ({
            id: r.id,
            paymentReference: r.paymentReference,
            amountMinorUnits: r.amountMinorUnits,
            currency: r.currency,
          }));
      },
      findUnique: async (args: any) => byId.get(args.where.id) ?? null,
      // Backs maybeEmitFirstPayment's post-confirm check (onboarding
      // activation audit) — this suite isn't about that signal.
      count: async () => 1,
      update: async (args: any) => {
        const r = byId.get(args.where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, args.data);
        return r;
      },
      // Field-guarded flip used by confirmTransferPayment's race guard.
      updateMany: async (args: any) => {
        const r = byId.get(args.where.id);
        if (!r || r.status !== args.where.status) return { count: 0 };
        Object.assign(r, args.data);
        return { count: 1 };
      },
    },
    package: {
      findUnique: async (args: any) => {
        const r = rows.find((x) => x.package.id === args.where.id);
        if (!r) return null;
        return {
          ...r.package,
          template: { expirationMonths: 1 },
          teacher: { timezone: "America/Mexico_City" },
        };
      },
      update: async (args: any) => {
        const r = rows.find((x) => x.package.id === args.where.id);
        if (!r) throw new Error("not found");
        Object.assign(r.package, args.data);
        return r.package;
      },
      updateMany: async (args: any) => {
        const r = rows.find((x) => x.package.id === args.where.id);
        if (!r || r.package.status !== args.where.status) return { count: 0 };
        Object.assign(r.package, args.data);
        return { count: 1 };
      },
    },
    notification: { create: async () => ({ id: "n-1" }) },
    override: {
      create: async ({ data }: any) => {
        overrides.push({ action: data.action });
        return data;
      },
    },
    $transaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => fn(fake),
  };
  return { prisma: fake, overrides };
}

function stubClient(credits: WiseCredit[]): WiseClient {
  return { fetchIncomingCredits: vi.fn(async () => credits) };
}

// Default factory: every connected teacher gets the same stub client.
function clientFactory(client: WiseClient | null) {
  return () => client;
}

describe("reconcileWiseStatements", () => {
  it("skips cleanly when no teacher is connected", async () => {
    const { prisma } = makeFakePrisma([freshPayment()], []);
    const out = await reconcileWiseStatements({
      prisma,
      clientForTeacher: clientFactory(stubClient([credit()])),
      now: () => NOW,
    });
    expect(out.skipped).toBe(true);
    expect(out.teachersScanned).toBe(0);
    expect(out.confirmed).toBe(0);
  });

  it("skips a teacher whose client cannot be built (incomplete creds)", async () => {
    const { prisma } = makeFakePrisma([freshPayment()], [connectedTeacher()]);
    const client = stubClient([credit()]);
    const out = await reconcileWiseStatements({
      prisma,
      clientForTeacher: clientFactory(null),
      now: () => NOW,
    });
    expect(out.skipped).toBe(false);
    expect(out.teachersScanned).toBe(1);
    expect(client.fetchIncomingCredits).not.toHaveBeenCalled();
    expect(out.confirmed).toBe(0);
  });

  it("does not call the statement API when the teacher has nothing pending", async () => {
    const { prisma } = makeFakePrisma([], [connectedTeacher()]);
    const client = stubClient([credit()]);
    const out = await reconcileWiseStatements({
      prisma,
      clientForTeacher: clientFactory(client),
      now: () => NOW,
    });
    expect(out.skipped).toBe(false);
    expect(client.fetchIncomingCredits).not.toHaveBeenCalled();
    expect(out.confirmed).toBe(0);
  });

  it("auto-confirms a matching pending payment via the null-teacher path", async () => {
    const payment = freshPayment();
    const { prisma, overrides } = makeFakePrisma([payment], [connectedTeacher()]);
    const emit = vi.fn();
    const out = await reconcileWiseStatements({
      prisma,
      clientForTeacher: clientFactory(stubClient([credit()])),
      emit,
      now: () => NOW,
    });

    expect(out.confirmed).toBe(1);
    expect(payment.status).toBe("paid");
    expect(payment.confirmedBy).toBeNull();
    expect(payment.autoMatchedAt).toEqual(NOW);
    expect(payment.package.status).toBe("active");
    expect(overrides[0]?.action).toBe("wise_auto_confirm");
    expect(emit).toHaveBeenCalled();
  });

  it("only reconciles a teacher against their own statement (no cross-teacher confirm)", async () => {
    // Payment belongs to teacher A; the only connected teacher is B, whose
    // statement carries A's reference. B's run must not touch A's payment.
    const payment = freshPayment(); // package.teacherId === TEACHER_A
    const teacherB = connectedTeacher({
      id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    });
    const { prisma } = makeFakePrisma([payment], [teacherB]);
    const out = await reconcileWiseStatements({
      prisma,
      clientForTeacher: clientFactory(stubClient([credit()])),
      now: () => NOW,
    });
    expect(out.confirmed).toBe(0);
    expect(out.scannedPayments).toBe(0);
    expect(payment.status).toBe("pending");
  });

  it("leaves an amount-mismatched credit for manual review", async () => {
    const payment = freshPayment();
    const { prisma } = makeFakePrisma([payment], [connectedTeacher()]);
    const out = await reconcileWiseStatements({
      prisma,
      clientForTeacher: clientFactory(stubClient([credit({ amountMinorUnits: 999_999 })])),
      now: () => NOW,
    });
    expect(out.confirmed).toBe(0);
    expect(out.mismatches).toBe(1);
    expect(payment.status).toBe("pending");
  });

  it("classifies a statement-fetch failure as a fetchError (not a confirmError)", async () => {
    const payment = freshPayment();
    const { prisma } = makeFakePrisma([payment], [connectedTeacher()]);
    const failingClient: WiseClient = {
      fetchIncomingCredits: vi.fn(async () => {
        throw new Error("wise 503");
      }),
    };
    const out = await reconcileWiseStatements({
      prisma,
      clientForTeacher: clientFactory(failingClient),
      now: () => NOW,
    });
    expect(out.errors).toBe(1);
    expect(out.fetchErrors).toBe(1);
    expect(out.confirmErrors).toBe(0);
    expect(out.teacherErrors).toBe(0);
    expect(payment.status).toBe("pending");
  });

  it("is idempotent — a second run over an already-paid row confirms nothing new", async () => {
    const payment = freshPayment();
    const { prisma } = makeFakePrisma([payment], [connectedTeacher()]);
    const factory = clientFactory(stubClient([credit()]));
    await reconcileWiseStatements({ prisma, clientForTeacher: factory, now: () => NOW });
    const second = await reconcileWiseStatements({
      prisma,
      clientForTeacher: factory,
      now: () => NOW,
    });
    // Row is paid now, so findMany returns nothing → second run is a no-op.
    expect(second.confirmed).toBe(0);
    expect(payment.status).toBe("paid");
  });
});
