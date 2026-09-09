import { PostHogIdentify } from "@/components/posthog-identify";
import { getCurrentStudent } from "@/lib/auth";

// Group layout for the student portal. Identifies the signed-in student
// to posthog-js so client events / replay / flags resolve to the same
// Person the server pipeline identifies (distinctId = student.id). No
// teacher group: a student can belong to several teachers.
export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const student = await getCurrentStudent();
  return (
    <>
      {student && (
        <PostHogIdentify
          distinctId={student.id}
          email={student.email}
          name={student.name}
          role="student"
        />
      )}
      {children}
    </>
  );
}
