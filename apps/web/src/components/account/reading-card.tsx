import { getT } from "@/lib/i18n";
import { getReadingPreferences } from "@/lib/reading-server";
import { ReadingControls } from "@/components/reading-controls";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Reading preferences, on both the teacher and student account pages (D-140).
 *
 * On the student side deliberately, and arguably more importantly: a teacher
 * configures the product, but a student READS in it — materials, homework,
 * vocabulary, class notes. That is where the setting earns its keep.
 */

/** The controls alone, for a page that supplies its own heading and chrome. */
export async function ReadingPreferences() {
  const reading = await getReadingPreferences();
  return <ReadingControls initial={reading} />;
}

/** The controls in a titled card, for a page laid out as a stack of cards. */
export async function ReadingCard() {
  const t = await getT();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("web.reading.title")}</CardTitle>
        <CardDescription>{t("web.reading.intro")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ReadingPreferences />
      </CardContent>
    </Card>
  );
}
