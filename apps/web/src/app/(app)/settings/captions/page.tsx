import { parseCaptionTiming } from "@spiralclass/shared";
import { PageHeader } from "@/components/ui/page-header";
import { requireTeacher } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { CaptionTimingForm } from "./caption-timing-form";

// Teacher-facing subtitle timing: how live subtitles are cut into lines. Read
// for both screens of every class through the caption session
// (lib/captions/class-access.ts), so what is set here is what a student's
// subtitles do too.

export default async function CaptionTimingSettingsPage() {
  const teacher = await requireTeacher();
  const t = await getT();

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("web.settings.captionTiming.title")}
        description={t("web.settings.captionTiming.subtitle")}
      />
      <CaptionTimingForm initial={parseCaptionTiming(teacher.captionTiming)} />
    </div>
  );
}
