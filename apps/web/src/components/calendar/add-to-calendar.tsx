"use client";

import { CalendarPlus, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/locale-provider";

// Per-booking "Add to calendar" buttons. The Google link is a prebuilt
// template URL; the `.ics` is rendered server-side and downloaded here via a
// Blob (no unauthenticated per-booking route, so class details never leak to
// someone guessing an id).
export function AddToCalendar({
  googleUrl,
  icsContent,
  filename = "clase.ics",
}: {
  googleUrl: string;
  icsContent: string;
  filename?: string;
}) {
  const t = useT();

  const downloadIcs = () => {
    const blob = new Blob([icsContent], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-wrap gap-2">
      <Button asChild variant="outline" size="sm">
        <a href={googleUrl} target="_blank" rel="noopener noreferrer">
          <CalendarPlus className="h-4 w-4" />
          <span className="ml-1.5">{t("web.addToCalendar.googleCalendar")}</span>
        </a>
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={downloadIcs}>
        <Download className="h-4 w-4" />
        <span className="ml-1.5">{t("web.addToCalendar.icsOption")}</span>
      </Button>
    </div>
  );
}
