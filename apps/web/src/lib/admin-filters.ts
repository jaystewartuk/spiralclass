// Shared `where`-clause builders for admin list pages that each have a CSV
// export sibling (e.g. /admin/teachers + /api/admin/export/teachers). Before
// this existed, the filter logic was hand-copied between the two, which drifts
// silently (a filter added to the page doesn't reach the export, or vice
// versa). Pure — no Prisma calls — so both a server component and a route
// handler can build the identical `where` from their own raw search params.
import type { PaymentStatus, Prisma } from "@prisma/client";
import {
  hasOfferableInstrument,
  isMarketplaceReady,
  type InstrumentReadiness,
} from "@spiralclass/shared";
import { NO_PAYOUT_RAIL_WHERE } from "@/lib/payments/payout-rail-where";

export const PAYMENT_STATUSES: PaymentStatus[] = ["pending", "paid", "failed", "refunded"];

// A teacher who finished the wizard
// this long ago and still isn't Marketplace Ready is the re-engagement
// candidate — the query underneath the "stalled" admin filter below. Deliberately
// just the query for now (an admin-visible list), not an automated nudge —
// the audit's own recommendation was to validate the query against real data
// before building the email/push send.
export const STALLED_TEACHER_DAYS = 14;

export type TeacherFilterParams = {
  q?: string | null;
  onboarded?: string | null;
  disabled?: string | null;
  stalled?: string | null;
};

export type TeacherFilterableRow = {
  name: string;
  email: string;
  onboardingCompleteAt: Date | string | null;
  disabledAt: Date | string | null;
  photoPath: string | null;
  bio: string | null;
  templatesTouchedAt: Date | string | null;
  availabilityTouchedAt: Date | string | null;
  stripeChargesEnabled: boolean;
  pricingCurrency: string;
  // D-113: the payout rail is a relation now, not two teacher columns.
  payoutInstruments: readonly InstrumentReadiness[];
};

function isStalled(row: TeacherFilterableRow, cutoff: Date): boolean {
  if (!row.onboardingCompleteAt) return false;
  if (new Date(row.onboardingCompleteAt) >= cutoff) return false;
  return !isMarketplaceReady({
    onboardingComplete: true,
    hasPhoto: Boolean(row.photoPath),
    hasBio: Boolean(row.bio),
    templatesTouched: Boolean(row.templatesTouchedAt),
    availabilityTouched: Boolean(row.availabilityTouchedAt),
    hasPayoutMethod:
      row.stripeChargesEnabled ||
      hasOfferableInstrument(row.payoutInstruments, row.pricingCurrency),
  });
}

/**
 * Client-side mirror of `buildTeacherWhere`, applied to rows already loaded
 * in the browser for the instant (zero-network) filtering pass on the
 * teachers grid — see admin/teachers/teachers-table.tsx. Kept in this file,
 * next to the Prisma `where` it mirrors, so the two definitions of "matches
 * this filter" don't drift apart.
 */
export function matchesTeacherFilters(
  row: TeacherFilterableRow,
  params: TeacherFilterParams,
): boolean {
  const query = (params.q ?? "").trim().toLowerCase();
  if (
    query &&
    !row.name.toLowerCase().includes(query) &&
    !row.email.toLowerCase().includes(query)
  ) {
    return false;
  }
  if (params.onboarded === "yes" && !row.onboardingCompleteAt) return false;
  if (params.onboarded === "no" && row.onboardingCompleteAt) return false;
  if (params.disabled === "yes" && !row.disabledAt) return false;
  if (params.disabled === "no" && row.disabledAt) return false;
  if (params.stalled === "yes") {
    const cutoff = new Date(Date.now() - STALLED_TEACHER_DAYS * 24 * 3600_000);
    if (!isStalled(row, cutoff)) return false;
  }
  return true;
}

// `excludeEmails` is the admin_users email list (getAdminEmails()) — passed in
// rather than fetched here so this stays a pure, DB-call-free function.
export function buildTeacherWhere(
  params: TeacherFilterParams,
  excludeEmails: string[],
): Prisma.TeacherWhereInput {
  const query = (params.q ?? "").trim();
  return {
    ...(excludeEmails.length ? { email: { notIn: excludeEmails } } : {}),
    ...(query
      ? {
          OR: [
            { email: { contains: query, mode: "insensitive" } },
            { name: { contains: query, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(params.onboarded === "yes" ? { onboardingCompleteAt: { not: null } } : {}),
    ...(params.onboarded === "no" ? { onboardingCompleteAt: null } : {}),
    ...(params.disabled === "yes" ? { disabledAt: { not: null } } : {}),
    ...(params.disabled === "no" ? { disabledAt: null } : {}),
    // DB-level translation of isStalled()/isMarketplaceReady() — kept in sync
    // by hand since a plain JS predicate can't run inside a Prisma `where`
    // (same posture as sitemap.ts's isPubliclyListed translation).
    ...(params.stalled === "yes"
      ? {
          onboardingCompleteAt: {
            not: null,
            lt: new Date(Date.now() - STALLED_TEACHER_DAYS * 24 * 3600_000),
          },
          OR: [
            { photoPath: null },
            { bio: null },
            { templatesTouchedAt: null },
            { availabilityTouchedAt: null },
            NO_PAYOUT_RAIL_WHERE,
          ],
        }
      : {}),
  };
}

export type PaymentFilterParams = {
  q?: string | null;
  status?: string | null;
  from?: string | null;
  to?: string | null;
};

function parseDateParam(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function buildPaymentWhere(params: PaymentFilterParams): Prisma.PaymentWhereInput {
  const query = (params.q ?? "").trim();
  const statusFilter = PAYMENT_STATUSES.includes(params.status as PaymentStatus)
    ? (params.status as PaymentStatus)
    : undefined;
  const fromDate = parseDateParam(params.from);
  const toDate = parseDateParam(params.to);

  return {
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(fromDate || toDate
      ? {
          createdAt: {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          },
        }
      : {}),
    ...(query
      ? {
          package: {
            is: {
              OR: [
                { student: { is: { email: { contains: query, mode: "insensitive" } } } },
                { student: { is: { name: { contains: query, mode: "insensitive" } } } },
                { teacher: { is: { email: { contains: query, mode: "insensitive" } } } },
                { teacher: { is: { name: { contains: query, mode: "insensitive" } } } },
              ],
            },
          },
        }
      : {}),
  };
}

export type PaymentFilterableRow = {
  status: string;
  createdAt: Date | string;
  package: {
    student: { name: string; email: string | null };
    teacher: { name: string; email: string };
  };
};

export function matchesPaymentFilters(
  row: PaymentFilterableRow,
  params: PaymentFilterParams,
): boolean {
  if (params.status && row.status !== params.status) return false;
  const fromDate = parseDateParam(params.from);
  const toDate = parseDateParam(params.to);
  const created = new Date(row.createdAt);
  if (fromDate && created < fromDate) return false;
  if (toDate && created > toDate) return false;
  const query = (params.q ?? "").trim().toLowerCase();
  if (query) {
    const haystack = [
      row.package.student.name,
      row.package.student.email ?? "",
      row.package.teacher.name,
      row.package.teacher.email,
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

export type StudentFilterParams = { q?: string | null; teacherId?: string | null };

export type StudentFilterableRow = {
  name: string;
  email: string | null;
  teacherStudents: { teacher: { id: string } }[];
};

export function matchesStudentFilters(
  row: StudentFilterableRow,
  params: StudentFilterParams,
): boolean {
  const query = (params.q ?? "").trim().toLowerCase();
  if (
    query &&
    !row.name.toLowerCase().includes(query) &&
    !(row.email ?? "").toLowerCase().includes(query)
  ) {
    return false;
  }
  if (params.teacherId && !row.teacherStudents.some((ts) => ts.teacher.id === params.teacherId)) {
    return false;
  }
  return true;
}

export type PackageFilterParams = { q?: string | null; status?: string | null };

export type PackageFilterableRow = {
  status: string;
  teacher: { name: string };
  student: { name: string };
  template: { name: string } | null;
};

export function matchesPackageFilters(
  row: PackageFilterableRow,
  params: PackageFilterParams,
): boolean {
  if (params.status && row.status !== params.status) return false;
  const query = (params.q ?? "").trim().toLowerCase();
  if (query) {
    const haystack =
      `${row.teacher.name} ${row.student.name} ${row.template?.name ?? ""}`.toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

export type DisputeFilterParams = { status?: string | null };

export function matchesDisputeFilters(
  row: { status: string },
  params: DisputeFilterParams,
): boolean {
  if (params.status && row.status !== params.status) return false;
  return true;
}

export type AuditFilterParams = {
  q?: string | null;
  targetType?: string | null;
  teacherId?: string | null;
};

export type AuditFilterableRow = {
  action: string;
  reason: string | null;
  targetType: string;
  teacherId: string | null;
};

export function matchesAuditFilters(row: AuditFilterableRow, params: AuditFilterParams): boolean {
  const query = (params.q ?? "").trim().toLowerCase();
  if (
    query &&
    !row.action.toLowerCase().includes(query) &&
    !(row.reason ?? "").toLowerCase().includes(query)
  ) {
    return false;
  }
  if (params.targetType && row.targetType !== params.targetType) return false;
  if (params.teacherId === "platform" && row.teacherId !== null) return false;
  if (params.teacherId && params.teacherId !== "platform" && row.teacherId !== params.teacherId)
    return false;
  return true;
}

export type NotificationFilterParams = {
  q?: string | null;
  status?: string | null;
  channel?: string | null;
};

export type NotificationFilterableRow = { templateName: string; status: string; channel: string };

export function matchesNotificationFilters(
  row: NotificationFilterableRow,
  params: NotificationFilterParams,
): boolean {
  const query = (params.q ?? "").trim().toLowerCase();
  if (query && !row.templateName.toLowerCase().includes(query)) return false;
  if (params.status && row.status !== params.status) return false;
  if (params.channel && row.channel !== params.channel) return false;
  return true;
}
