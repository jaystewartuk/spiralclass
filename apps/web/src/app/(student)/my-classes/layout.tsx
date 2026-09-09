import { StudentNav } from "./student-nav";
import { CaptureTimezone } from "./capture-timezone";
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
    <>
      <StudentNav
        localeToggle={<LanguagePicker variant="field" />}
        account={
          student
            ? { name: student.name, email: student.email, role: "student", photoUrl }
            : undefined
        }
      />
      {student && !student.timezone ? <CaptureTimezone /> : null}
      {children}
    </>
  );
}
