import { getLanguagePickerValue } from "@/lib/i18n";
import { LanguageSelect } from "@/components/language-select";

// Server wrapper: reads the stored language preference so the <select> opens on
// the user's current choice ("System Default", or a specific language) — or on
// the page's own language, where a public URL names one the preference does
// not (getLanguagePickerValue). The interactive part lives in the client
// LanguageSelect; this mirrors the old LocaleToggle's server-component shape so
// it drops into the same slots.
export async function LanguagePicker({ variant }: { variant?: "compact" | "field" }) {
  const current = await getLanguagePickerValue();
  return <LanguageSelect current={current} variant={variant} />;
}
