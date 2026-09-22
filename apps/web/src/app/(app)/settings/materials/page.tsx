import type { MaterialStyleSettings } from "@spiralclass/shared";
import { languageEntry, languageLabel } from "@spiralclass/shared";
import { PageHeader } from "@/components/ui/page-header";
import { requireTeacher } from "@/lib/auth";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { MaterialStyleForm } from "./material-style-form";

// Teacher-facing "AI material style" settings (D-78, D-80). A dedicated page
// reached from the Materials hub, where the teacher tunes how the AI writes
// every generated material: tone/register, learner age, vocabulary difficulty,
// target-language variety, and a free-text note. All account-level: read
// server-side by lib/materials/handlers.ts#resolveSubject and applied to every
// generation path, without changing generate calls.

export default async function MaterialStyleSettingsPage() {
  const teacher = await requireTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();

  const initial: MaterialStyleSettings = {
    tone: (teacher.materialTone as MaterialStyleSettings["tone"]) ?? null,
    learnerAge: (teacher.materialLearnerAge as MaterialStyleSettings["learnerAge"]) ?? null,
    languageVariety: teacher.materialLanguageVariety,
    customInstructions: teacher.materialCustomInstructions,
    // Vocabulary difficulty (D-80). It reached this page with the redesign;
    // before that it was a dial no teacher could actually reach.
    vocabulary: (teacher.materialVocabulary as MaterialStyleSettings["vocabulary"]) ?? null,
  };

  // "Which variety of Spanish?" beats "which variety of the language you
  // teach?", and the subject is already on the row. Null when she hasn't picked
  // one yet (or picked a code the registry no longer carries) — the form falls
  // back to the generic wording rather than naming a language she doesn't teach.
  const targetLanguageLabel =
    teacher.targetLanguage && languageEntry(teacher.targetLanguage)
      ? languageLabel(teacher.targetLanguage, locale)
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("web.settings.materialStyle.title")}
        description={t("web.settings.materialStyle.subtitle")}
      />

      <MaterialStyleForm initial={initial} targetLanguageLabel={targetLanguageLabel} />
    </div>
  );
}
