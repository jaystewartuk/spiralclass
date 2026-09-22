import { Badge } from "@/components/ui/badge";
import { getT } from "@/lib/i18n";
import { bookingStatusMeta, type BookingStatusViewer } from "@/lib/booking/status-display";

// Shared status vocabulary for the teacher and student classes list pages —
// consolidates what used to be three near-identical hand-rolled `<span>`
// implementations (dashboard/classes, dashboard/classes/[bookingId],
// calendar-month) onto the cva-based Badge component. Labels differ by
// viewer: a teacher sees who cancelled ("Cancelled (student)"), a student
// sees it framed from their side ("Cancelled by your teacher").
//
// The table itself is `lib/booking/status-display.ts`, so a synchronous
// caller can reach the same words without awaiting a component.

export async function BookingStatusBadge({
  status,
  viewer,
}: {
  status: string;
  viewer: BookingStatusViewer;
}) {
  const t = await getT();
  const meta = bookingStatusMeta(status, viewer, t);
  return (
    <Badge variant={meta.variant} className="shrink-0">
      {meta.label}
    </Badge>
  );
}

// Lets a teacher spot at a glance which upcoming classes still need
// materials attached, and lets a student see whether materials have been
// sent for a class. Only warns for scheduled classes — there's nothing
// actionable about a past class missing materials.
export async function MaterialsBadge({
  hasMaterials,
  status,
}: {
  hasMaterials: boolean;
  status: string;
}) {
  const t = await getT();
  if (hasMaterials) {
    return (
      <Badge variant="sage" className="shrink-0" title={t("web.bookingStatusBadge.hasMaterials")}>
        {t("web.bookingStatusBadge.materials")}
      </Badge>
    );
  }
  if (status !== "scheduled") return null;
  return (
    <Badge
      variant="warning"
      className="shrink-0"
      title={t("web.bookingStatusBadge.noMaterialsYet")}
    >
      {t("web.bookingStatusBadge.noMaterials")}
    </Badge>
  );
}
