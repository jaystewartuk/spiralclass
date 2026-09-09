import { getLocalePreference } from "@/lib/i18n";
import { LanguageSelect } from "@/components/language-select";

// Server wrapper: reads the stored language preference so the <select> opens on
// the user's current choice ("System Default", or a specific language). The
// interactive part lives in the client LanguageSelect; this mirrors the old
// LocaleToggle's server-component shape so it drops into the same slots.
export async function LanguagePicker({ variant }: { variant?: "compact" | "field" }) {
  const preference = await getLocalePreference();
  return <LanguageSelect current={preference} variant={variant} />;
}
