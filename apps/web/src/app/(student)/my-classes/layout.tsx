import { StudentNav } from "./student-nav";
import { CaptureTimezone } from "./capture-timezone";
import { TimezoneMismatchNotice } from "./timezone-mismatch-notice";
import { LanguagePicker } from "@/components/language-picker";
import { getCurrentStudent } from "@/lib/auth";
import { studentPhotoUrl } from "@/lib/storage/student-photo";

// Persistent shell for every /my-classes page: the same sticky header
// (logo + Clases / Materiales / Cuenta + sign out) the portal home used to
// hand-roll, so sub-pages like Cuenta no longer render bare. Pages keep
// their own <main> containers because content widths differ.
export default async function MisClasesLayout({ children }: { children: React.ReactNode }) {
  // Shares the same cached lookup the (student) group layout already runs.
  const student = await getCurrentStudent();
  const photoUrl = student ? await studentPhotoUrl(student.photoPath) : null;
  return (
    // At least a screen tall, so the site footer the root layout renders after
    // this shell always starts below the fold. Without it, every in-portal
    // navigation swapped the page for its loading.tsx skeleton — shorter than
    // the page — and the footer rose into view, then dropped back down when the
    // content arrived: a layout shift of 0.3+ on the class page alone, beside
    // "Join video call" (#90). The skeletons cannot match every page's height;
    // the footer staying below the fold makes their height irrelevant.
    <div className="min-h-dvh">
      <StudentNav
        localeToggle={<LanguagePicker variant="field" />}
        account={
          student
            ? { name: student.name, email: student.email, role: "student", photoUrl }
            : undefined
        }
      />
      {/* Exactly one of the two: no saved zone → fill it silently from the
          device; a saved one → offer the device's when it is a different
          clock, never overwrite it (D-53). */}
      {student && !student.timezone ? <CaptureTimezone /> : null}
      {student?.timezone ? <TimezoneMismatchNotice savedTimezone={student.timezone} /> : null}
      {children}
    </div>
  );
}
