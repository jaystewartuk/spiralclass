import { requireOnboardedTeacher } from "@/lib/auth";
import { PageHeader } from "@/components/ui/page-header";
import { getT } from "@/lib/i18n";
import { listClassContentTemplates } from "@/lib/materials/templates";
import { ClassContentTemplatesForm } from "./class-content-templates-form";

// Standalone lesson-template manager. The inline "save as template" on
// the class-content panel only creates; this is where a teacher authors a
// lesson skeleton from scratch, edits its body, reorders, and deletes — the
// home a teacher's own module structure needs. Mirrors the
// teacher-editable focus-tags settings page. Authoring is Pro-gated server-side.
export default async function ClassContentTemplatesSettingsPage() {
  const teacher = await requireOnboardedTeacher();
  const t = await getT();
  const templates = await listClassContentTemplates(teacher.id);

  return (
    <div className="space-y-6">
      {/* The intro is the header's own description rather than a loose
          paragraph beneath it: PageHeader already sets the type scale and the
          gap for exactly this pairing, and a hand-rolled sibling drifted from
          every other settings screen's spacing. */}
      <PageHeader
        title={t("settings.classContentTemplates.title")}
        description={t("web.settings.classContentTemplates.intro")}
      />

      <ClassContentTemplatesForm
        initial={templates.map((row) => ({ id: row.id, label: row.label, body: row.body }))}
      />
    </div>
  );
}
