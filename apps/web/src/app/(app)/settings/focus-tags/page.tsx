import { requireOnboardedTeacher } from "@/lib/auth";
import { PageHeader } from "@/components/ui/page-header";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { getTeacherFocusCategories, getTeacherFocusTags } from "@/lib/focus-tags";
import { TagsManager } from "./tags-manager";

// Teacher-editable focus tags + categories (D-20's deferred follow-up;
// category later became its own manageable taxonomy rather than free text). The
// seed packs in lib/focus-packs.ts give every teacher a usable "what to work
// on" picker with zero setup, but they were never meant to be the ceiling —
// this is where a teacher renames, adds, reorders, or archives her own tags
// AND categories. TagsManager groups tags under their category (shown once,
// not repeated per tag) and saves every edit immediately.
//
// The intro copy goes through PageHeader's own `description` rather than a
// paragraph stacked under it: the primitive already pairs the two at the right
// size and gap, and hand-stacking them was how this page ended up with a
// title/description gap that matched no other settings screen.
export default async function FocusTagsSettingsPage() {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();
  const [categories, tags] = await Promise.all([
    getTeacherFocusCategories(teacher.id, locale),
    getTeacherFocusTags(teacher.id, teacher.targetLanguage, locale),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("settings.focusTags.title")}
        description={t("web.settings.focusTags.intro")}
      />

      <TagsManager
        initialCategories={categories.map((c) => ({ id: c.id, label: c.label }))}
        initialTags={tags.map((tag) => ({
          id: tag.id,
          label: tag.label,
          categoryId: tag.categoryId,
        }))}
      />
    </div>
  );
}
