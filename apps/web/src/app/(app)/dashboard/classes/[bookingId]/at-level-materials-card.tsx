"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { attachLibraryMaterialToBookingQuickAction } from "@/app/actions/booking-library-materials";
import { useT } from "@/components/locale-provider";

// Gap G4 (docs/features/library-materials.md) — read-only surface of library
// items at this student's level, opt-in per teacher (settings → account).
// Browsing is passive; attaching one to the class stays an explicit action
// (the same "never auto-exceed, teacher always acts" rule the notebook's
// browse ceiling already follows) — a one-click "Attach" button, not an
// automatic add. Attaching defaults to sending at confirmation (i.e. now),
// since a teacher opening this shelf is doing so with the class in mind.
export function AtLevelMaterialsCard({
  bookingId,
  materials,
}: {
  bookingId: string;
  materials: { id: string; label: string | null }[];
}) {
  const t = useT();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("web.dashboard.classes.atLevel.title")}</CardTitle>
        <CardDescription>{t("web.dashboard.classes.atLevel.help")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {materials.map((m) => (
          <form
            key={m.id}
            action={attachLibraryMaterialToBookingQuickAction}
            className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
          >
            <input type="hidden" name="bookingId" value={bookingId} />
            <input type="hidden" name="libraryMaterialId" value={m.id} />
            <input type="hidden" name="sendTiming" value="confirmation" />
            <span className="truncate font-medium">
              {m.label ?? t("web.materials.materialFallback")}
            </span>
            <Button type="submit" variant="ghost" size="sm">
              {t("web.dashboard.classes.atLevel.attach")}
            </Button>
          </form>
        ))}
      </CardContent>
    </Card>
  );
}
