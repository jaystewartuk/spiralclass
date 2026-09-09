import { describe, expect, it } from "vitest";
import { NO_PAYOUT_RAIL_WHERE } from "@/lib/payments/payout-rail-where";
import {
  buildTeacherWhere,
  matchesAuditFilters,
  matchesDisputeFilters,
  matchesNotificationFilters,
  matchesPackageFilters,
  matchesPaymentFilters,
  matchesStudentFilters,
  matchesTeacherFilters,
} from "@/lib/admin-filters";

describe("buildTeacherWhere", () => {
  it("matches name or email case-insensitively for q", () => {
    const where = buildTeacherWhere({ q: "Mira" }, []);
    expect(where.OR).toEqual([
      { email: { contains: "Mira", mode: "insensitive" } },
      { name: { contains: "Mira", mode: "insensitive" } },
    ]);
  });

  it("excludes admin emails when provided", () => {
    const where = buildTeacherWhere({}, ["admin@spiralclass.com"]);
    expect(where.email).toEqual({ notIn: ["admin@spiralclass.com"] });
  });

  it("maps onboarded/disabled yes|no to presence filters", () => {
    expect(buildTeacherWhere({ onboarded: "yes" }, [])).toMatchObject({
      onboardingCompleteAt: { not: null },
    });
    expect(buildTeacherWhere({ onboarded: "no" }, [])).toMatchObject({
      onboardingCompleteAt: null,
    });
    expect(buildTeacherWhere({ disabled: "yes" }, [])).toMatchObject({ disabledAt: { not: null } });
    expect(buildTeacherWhere({ disabled: "no" }, [])).toMatchObject({ disabledAt: null });
  });

  // The re-engagement candidate
  // query, a DB-level translation of isMarketplaceReady() kept in sync by
  // hand (a plain JS predicate can't run inside a Prisma `where`).
  it("stalled=yes filters on onboardingCompleteAt older than the cutoff AND any missing marketplace-ready signal", () => {
    const where = buildTeacherWhere({ stalled: "yes" }, []);
    expect(where.onboardingCompleteAt).toMatchObject({ not: null });
    expect((where.onboardingCompleteAt as { lt: Date }).lt).toBeInstanceOf(Date);
    expect(where.OR).toEqual([
      { photoPath: null },
      { bio: null },
      { templatesTouchedAt: null },
      { availabilityTouchedAt: null },
      // D-113 made "no payout rail" the complement of a relation filter;
      // D-124 made its bank branch generated from the scheme registry.
      // Asserted by reference to the exported constant rather than copied:
      // the generated clause has one arm per pricing currency, and a literal
      // copy would have to be rewritten every time a country is added — which
      // is the coupling the generation exists to remove. The sitemap parity
      // test is what proves the constant still agrees with the JS predicate.
      NO_PAYOUT_RAIL_WHERE,
    ]);
  });
});

describe("matchesTeacherFilters", () => {
  const MARKETPLACE_READY_SUB_SIGNALS = {
    photoPath: "teachers/t1/photo.jpg",
    bio: "Profesora de inglés.",
    templatesTouchedAt: new Date("2020-01-01"),
    availabilityTouchedAt: new Date("2020-01-01"),
    stripeChargesEnabled: true,
    pricingCurrency: "MXN",
    payoutInstruments: [],
  };

  const teacher = {
    name: "Alicia Moreno",
    email: "mira@example.mx",
    onboardingCompleteAt: null as Date | string | null,
    disabledAt: null as Date | string | null,
    ...MARKETPLACE_READY_SUB_SIGNALS,
  };

  it("matches q against name or email, case-insensitively", () => {
    expect(matchesTeacherFilters(teacher, { q: "mira" })).toBe(true);
    expect(matchesTeacherFilters(teacher, { q: "EXAMPLE.MX" })).toBe(true);
    expect(matchesTeacherFilters(teacher, { q: "carlos" })).toBe(false);
  });

  it("filters on onboarded yes/no", () => {
    expect(matchesTeacherFilters(teacher, { onboarded: "no" })).toBe(true);
    expect(matchesTeacherFilters(teacher, { onboarded: "yes" })).toBe(false);
    expect(
      matchesTeacherFilters({ ...teacher, onboardingCompleteAt: new Date() }, { onboarded: "yes" }),
    ).toBe(true);
  });

  it("filters on disabled yes/no", () => {
    expect(matchesTeacherFilters(teacher, { disabled: "no" })).toBe(true);
    expect(matchesTeacherFilters(teacher, { disabled: "yes" })).toBe(false);
    expect(matchesTeacherFilters({ ...teacher, disabledAt: new Date() }, { disabled: "yes" })).toBe(
      true,
    );
  });

  it("with no filters set, everything matches", () => {
    expect(matchesTeacherFilters(teacher, {})).toBe(true);
  });

  describe("stalled=yes", () => {
    const oldEnough = new Date(Date.now() - 20 * 24 * 3600_000);
    const tooRecent = new Date(Date.now() - 1 * 24 * 3600_000);

    it("excludes a teacher who never finished onboarding", () => {
      expect(
        matchesTeacherFilters({ ...teacher, onboardingCompleteAt: null }, { stalled: "yes" }),
      ).toBe(false);
    });

    it("excludes a teacher onboarded too recently, even if not Marketplace Ready", () => {
      expect(
        matchesTeacherFilters(
          { ...teacher, onboardingCompleteAt: tooRecent, photoPath: null },
          { stalled: "yes" },
        ),
      ).toBe(false);
    });

    it("excludes an old-enough teacher who IS fully Marketplace Ready", () => {
      expect(
        matchesTeacherFilters({ ...teacher, onboardingCompleteAt: oldEnough }, { stalled: "yes" }),
      ).toBe(false);
    });

    it("includes an old-enough teacher missing any single marketplace-ready sub-signal", () => {
      for (const missing of [
        { photoPath: null },
        { bio: null },
        { templatesTouchedAt: null },
        { availabilityTouchedAt: null },
        { stripeChargesEnabled: false, wisePaymentsEnabled: false, wiseHandle: null },
      ]) {
        expect(
          matchesTeacherFilters(
            { ...teacher, onboardingCompleteAt: oldEnough, ...missing },
            { stalled: "yes" },
          ),
        ).toBe(true);
      }
    });

    it("a Wise-only teacher counts as payout-ready", () => {
      expect(
        matchesTeacherFilters(
          {
            ...teacher,
            onboardingCompleteAt: oldEnough,
            stripeChargesEnabled: false,
            pricingCurrency: "MXN",
            payoutInstruments: [{ kind: "wise", enabled: true, wiseHandle: "mira" }],
          },
          { stalled: "yes" },
        ),
      ).toBe(false);
    });
  });
});

describe("matchesStudentFilters", () => {
  const student = {
    name: "Beatriz",
    email: "beatriz@example.mx",
    teacherStudents: [{ teacher: { id: "t1" } }],
  };

  it("matches q against name or email", () => {
    expect(matchesStudentFilters(student, { q: "beatriz" })).toBe(true);
    expect(matchesStudentFilters(student, { q: "carlos" })).toBe(false);
  });

  it("filters by teacherId membership", () => {
    expect(matchesStudentFilters(student, { teacherId: "t1" })).toBe(true);
    expect(matchesStudentFilters(student, { teacherId: "t2" })).toBe(false);
  });
});

describe("matchesPaymentFilters", () => {
  const payment = {
    status: "paid",
    createdAt: new Date("2026-06-15T00:00:00Z"),
    package: {
      student: { name: "Beatriz", email: "beatriz@example.mx" },
      teacher: { name: "Alicia Moreno", email: "mira@example.mx" },
    },
  };

  it("filters by status", () => {
    expect(matchesPaymentFilters(payment, { status: "paid" })).toBe(true);
    expect(matchesPaymentFilters(payment, { status: "refunded" })).toBe(false);
  });

  it("filters by date range", () => {
    expect(matchesPaymentFilters(payment, { from: "2026-06-01" })).toBe(true);
    expect(matchesPaymentFilters(payment, { from: "2026-07-01" })).toBe(false);
    expect(matchesPaymentFilters(payment, { to: "2026-06-30" })).toBe(true);
    expect(matchesPaymentFilters(payment, { to: "2026-06-01" })).toBe(false);
  });

  it("matches q against teacher or student name/email", () => {
    expect(matchesPaymentFilters(payment, { q: "mira" })).toBe(true);
    expect(matchesPaymentFilters(payment, { q: "carlos" })).toBe(false);
  });
});

describe("matchesPackageFilters", () => {
  const pkg = {
    status: "active",
    teacher: { name: "Alicia Moreno" },
    student: { name: "Beatriz" },
    template: { name: "10-class pack" },
  };

  it("filters by status and q", () => {
    expect(matchesPackageFilters(pkg, { status: "active" })).toBe(true);
    expect(matchesPackageFilters(pkg, { status: "expired" })).toBe(false);
    expect(matchesPackageFilters(pkg, { q: "10-class" })).toBe(true);
    expect(matchesPackageFilters(pkg, { q: "nope" })).toBe(false);
  });
});

describe("matchesDisputeFilters", () => {
  it("filters by status", () => {
    expect(matchesDisputeFilters({ status: "needs_response" }, { status: "needs_response" })).toBe(
      true,
    );
    expect(matchesDisputeFilters({ status: "won" }, { status: "needs_response" })).toBe(false);
    expect(matchesDisputeFilters({ status: "won" }, {})).toBe(true);
  });
});

describe("matchesAuditFilters", () => {
  const row = {
    action: "teacher.disable",
    reason: "ToS violation",
    targetType: "teacher",
    teacherId: "t1",
  };

  it("matches q against action or reason", () => {
    expect(matchesAuditFilters(row, { q: "disable" })).toBe(true);
    expect(matchesAuditFilters(row, { q: "violation" })).toBe(true);
    expect(matchesAuditFilters(row, { q: "nope" })).toBe(false);
  });

  it("filters by targetType", () => {
    expect(matchesAuditFilters(row, { targetType: "teacher" })).toBe(true);
    expect(matchesAuditFilters(row, { targetType: "payment" })).toBe(false);
  });

  it("handles the platform (no-teacher) special value", () => {
    expect(matchesAuditFilters(row, { teacherId: "platform" })).toBe(false);
    expect(matchesAuditFilters({ ...row, teacherId: null }, { teacherId: "platform" })).toBe(true);
    expect(matchesAuditFilters(row, { teacherId: "t1" })).toBe(true);
    expect(matchesAuditFilters(row, { teacherId: "t2" })).toBe(false);
  });
});

describe("matchesNotificationFilters", () => {
  const row = { templateName: "booking-confirmed", status: "sent", channel: "email" };

  it("matches q against templateName", () => {
    expect(matchesNotificationFilters(row, { q: "booking" })).toBe(true);
    expect(matchesNotificationFilters(row, { q: "nope" })).toBe(false);
  });

  it("filters by status and channel", () => {
    expect(matchesNotificationFilters(row, { status: "sent" })).toBe(true);
    expect(matchesNotificationFilters(row, { status: "failed" })).toBe(false);
    expect(matchesNotificationFilters(row, { channel: "email" })).toBe(true);
    expect(matchesNotificationFilters(row, { channel: "push" })).toBe(false);
  });
});
