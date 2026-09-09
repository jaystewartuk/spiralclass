/* eslint-disable @typescript-eslint/no-explicit-any */
// Minimal in-memory Prisma fake for the subscription lifecycle / sweep /
// billing-webhook unit tests. Supports only the methods those modules call.
// Mirrors the per-test fake style used in tests/payments/webhook.unit.test.ts.

export type FakeSub = {
  teacherId: string;
  plan: "free" | "monthly" | "annual" | "founding";
  status: "trialing" | "active" | "past_due" | "canceled" | "free";
  lockedPriceMinorUnits: number | null;
  currency: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  // Stripe's cancel_at_period_end: cancelled in the portal, still paid through
  // currentPeriodEnd. Distinct from canceledAt, which means it has ended.
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  comped: boolean;
  // VAT/GST readiness (global-launch item 7) — captured off the platform Customer.
  billingCountry?: string | null;
  billingAddressJson?: Record<string, string> | null;
};

export type FakeInvoice = {
  id: string;
  teacherId: string;
  stripeInvoiceId: string | null;
  amountMinorUnits: number;
  feeMinorUnits: number;
  netMinorUnits: number;
  status: "paid" | "open" | "failed" | "void";
  provider: string;
  manualPaymentRef: string | null;
  paidAt: Date | null;
  periodStart: Date;
  periodEnd: Date;
};

export type FakeNotification = {
  id: string;
  teacherId: string;
  templateName: string;
  recipientType: string;
  metadata: any;
};

function subDefaults(partial: Partial<FakeSub> & { teacherId: string }): FakeSub {
  return {
    plan: "free",
    status: "trialing",
    lockedPriceMinorUnits: null,
    currency: "MXN",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    comped: false,
    ...partial,
  };
}

export function makeFakePrisma(seed: {
  subs?: FakeSub[];
  teachers?: Array<{ id: string; name?: string; email?: string }>;
  cohort?: { headcount: number; cutoffAt?: Date | null; maxTeachers?: number | null };
  // For the enforcement gates: live counts of active students / templates.
  activeStudents?: number;
  activeTemplates?: number;
}) {
  const subs = new Map<string, FakeSub>((seed.subs ?? []).map((s) => [s.teacherId, s]));
  const teachers = new Map(
    (seed.teachers ?? []).map((t) => [t.id, { name: "T", email: "t@x.mx", ...t }]),
  );
  const invoices: FakeInvoice[] = [];
  const notifications: FakeNotification[] = [];
  let cohort = seed.cohort
    ? { id: "default", cutoffAt: null, maxTeachers: null, ...seed.cohort }
    : null;

  function applyIncrement(target: any, data: any) {
    const out = { ...target };
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in (v as any)) {
        out[k] = (out[k] ?? 0) + (v as any).increment;
      } else if (v !== undefined) {
        out[k] = v;
      }
    }
    return out;
  }

  const db: any = {
    teacherSubscription: {
      async findUnique({ where }: any) {
        const s = subs.get(where.teacherId);
        return s ? { ...s } : null;
      },
      async findFirst({ where }: any) {
        for (const s of subs.values()) {
          if (where.stripeCustomerId && s.stripeCustomerId === where.stripeCustomerId) {
            return { ...s };
          }
        }
        return null;
      },
      async findMany({ where }: any) {
        const out: FakeSub[] = [];
        for (const s of subs.values()) {
          if (where?.status && s.status !== where.status) continue;
          if (where?.comped !== undefined && s.comped !== where.comped) continue;
          if (where?.plan && s.plan !== where.plan) continue;
          if (where?.trialEndsAt?.lte && !(s.trialEndsAt && s.trialEndsAt <= where.trialEndsAt.lte))
            continue;
          if (where?.trialEndsAt?.gt && !(s.trialEndsAt && s.trialEndsAt > where.trialEndsAt.gt))
            continue;
          if (
            where?.currentPeriodEnd?.lte &&
            !(s.currentPeriodEnd && s.currentPeriodEnd <= where.currentPeriodEnd.lte)
          )
            continue;
          out.push({ ...s });
        }
        return out;
      },
      async count({ where }: any) {
        let n = 0;
        for (const s of subs.values()) {
          if (where?.plan && s.plan !== where.plan) continue;
          n += 1;
        }
        return n;
      },
      async upsert({ where, create, update }: any) {
        const existing = subs.get(where.teacherId);
        if (existing) {
          const next = applyIncrement(existing, update);
          subs.set(where.teacherId, next);
          return { ...next };
        }
        const next = subDefaults({ ...create });
        subs.set(where.teacherId, next);
        return { ...next };
      },
      async create({ data }: any) {
        if (subs.has(data.teacherId)) throw new Error("unique constraint (P2002)");
        const next = subDefaults({ ...data });
        subs.set(data.teacherId, next);
        return { ...next };
      },
      async update({ where, data }: any) {
        const existing = subs.get(where.teacherId);
        if (!existing) throw new Error("sub not found");
        const next = applyIncrement(existing, data);
        subs.set(where.teacherId, next);
        return { ...next };
      },
      // Field-guarded conditional update — honors the `NOT: { plan }` guard
      // the founding-transition detection uses, plus the `status` (equality or
      // `{ in: [...] }`) guard the markPastDue atomic flip uses.
      async updateMany({ where, data }: any) {
        const existing = subs.get(where.teacherId);
        if (!existing) return { count: 0 };
        if (where.NOT?.plan !== undefined && existing.plan === where.NOT.plan) {
          return { count: 0 };
        }
        if (where.status !== undefined) {
          const allowed = Array.isArray(where.status?.in) ? where.status.in : [where.status];
          if (!allowed.includes(existing.status)) return { count: 0 };
        }
        const next = applyIncrement(existing, data);
        subs.set(where.teacherId, next);
        return { count: 1 };
      },
    },
    foundingCohort: {
      async findUnique() {
        return cohort ? { ...cohort } : null;
      },
      async upsert({ create, update }: any) {
        if (cohort) {
          cohort = applyIncrement(cohort, update);
        } else {
          cohort = { id: "default", cutoffAt: null, maxTeachers: null, headcount: 0, ...create };
        }
        return { ...cohort };
      },
    },
    subscriptionInvoice: {
      async upsert({ where, create, update }: any) {
        const existing = invoices.find((i) => i.stripeInvoiceId === where.stripeInvoiceId);
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row: FakeInvoice = {
          id: `inv-${invoices.length + 1}`,
          manualPaymentRef: null,
          paidAt: null,
          ...create,
        };
        invoices.push(row);
        return { ...row };
      },
      async create({ data }: any) {
        const row: FakeInvoice = {
          id: `inv-${invoices.length + 1}`,
          stripeInvoiceId: null,
          manualPaymentRef: null,
          paidAt: null,
          ...data,
        };
        invoices.push(row);
        return { ...row };
      },
      async findMany() {
        return invoices.map((i) => ({ ...i }));
      },
    },
    notification: {
      async create({ data }: any) {
        const id = `n-${notifications.length + 1}`;
        notifications.push({
          id,
          teacherId: data.teacherId,
          templateName: data.templateName,
          recipientType: data.recipientType,
          metadata: data.metadata ?? null,
        });
        return { id };
      },
      async findFirst({ where }: any) {
        return (
          notifications.find(
            (n) => n.teacherId === where.teacherId && n.templateName === where.templateName,
          ) ?? null
        );
      },
      async findMany({ where }: any) {
        const ids: string[] | undefined = where?.teacherId?.in;
        return notifications
          .filter((n) => {
            if (where?.templateName && n.templateName !== where.templateName) return false;
            if (ids && !ids.includes(n.teacherId)) return false;
            return true;
          })
          .map((n) => ({ teacherId: n.teacherId }));
      },
    },
    teacher: {
      async findUnique({ where }: any) {
        const t = teachers.get(where.id);
        return t ? { id: t.id } : null;
      },
    },
    teacherStudent: {
      async count() {
        return seed.activeStudents ?? 0;
      },
    },
    packageTemplate: {
      async count() {
        return seed.activeTemplates ?? 0;
      },
    },
    async $transaction(fn: any) {
      return fn(db);
    },
  };

  return {
    db,
    get subs() {
      return subs;
    },
    get invoices() {
      return invoices;
    },
    get notifications() {
      return notifications;
    },
    get cohort() {
      return cohort;
    },
  };
}
