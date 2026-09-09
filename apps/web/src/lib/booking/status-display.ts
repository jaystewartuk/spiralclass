import type { BadgeProps } from "@/components/ui/badge";
import type { TFunction } from "@/lib/i18n-translate";

/**
 * The vocabulary for a booking's status — the word and the colour, decided
 * once.
 *
 * Extracted from `components/booking-status-badge.tsx`, which was an `async`
 * component because it reached for `getT()` itself. That is fine where a
 * caller is also async, and impossible where one is not: a Server Component
 * that renders synchronously (and every unit test that renders one through
 * `renderToStaticMarkup`) cannot await a child. The teacher's student-detail
 * page was printing the raw enum — `scheduled`, `canceled_by_student` —
 * because the badge was out of reach from a synchronous render.
 *
 * So the decision lives here as a plain function of `(status, viewer, t)`, and
 * the async component is a thin wrapper that fetches `t` for callers who have
 * none. Nothing about the labels or the colours changed.
 */
export type BookingStatusViewer = "teacher" | "student";

export type BookingStatusMeta = {
  variant: NonNullable<BadgeProps["variant"]>;
  label: string;
};

const STATUS_META: Record<
  string,
  {
    variant: NonNullable<BadgeProps["variant"]>;
    label: (t: TFunction, viewer: BookingStatusViewer) => string;
  }
> = {
  scheduled: {
    variant: "clay",
    label: (t) => t("booking.status.scheduled"),
  },
  completed: {
    variant: "success",
    label: (t) => t("booking.status.completed"),
  },
  canceled_by_student: {
    variant: "destructive",
    label: (t, viewer) =>
      viewer === "teacher"
        ? t("web.bookingStatusBadge.canceledByStudent.teacher")
        : t("web.bookingStatusBadge.canceledByStudent.student"),
  },
  canceled_by_teacher: {
    variant: "destructive",
    label: (t, viewer) =>
      viewer === "teacher"
        ? t("web.bookingStatusBadge.canceledByTeacher.teacher")
        : t("web.bookingStatusBadge.canceledByTeacher.student"),
  },
  rescheduled: {
    variant: "warning",
    label: (t) => t("booking.status.rescheduled"),
  },
  no_show: {
    variant: "destructive",
    label: (t, viewer) =>
      viewer === "teacher"
        ? t("booking.status.no_show")
        : t("web.bookingStatusBadge.noShow.student"),
  },
};

/**
 * An unknown status falls back to the raw value in a neutral badge rather than
 * throwing: a status this table has not learned yet is a copy gap, not a
 * reason for a teacher's page to 500.
 */
export function bookingStatusMeta(
  status: string,
  viewer: BookingStatusViewer,
  t: TFunction,
): BookingStatusMeta {
  const meta = STATUS_META[status];
  return {
    variant: meta?.variant ?? "secondary",
    label: meta ? meta.label(t, viewer) : status,
  };
}
