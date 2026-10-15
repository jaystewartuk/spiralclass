import { getReadingPreferences } from "@/lib/reading-server";
import { ReadingControls } from "@/components/reading-controls";

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
