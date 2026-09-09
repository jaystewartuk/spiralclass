import { materialImageOwner } from "@spiralclass/shared";
import { prisma } from "@/lib/prisma";
import { studentIdentityIds } from "@/lib/students/identity";

// Who may load an image embedded in a material body, and the URL those images
// are served from.
//
// THE AUTHORIZATION RULE is "the image's owning teacher, or a student on that
// teacher's roster." It is deliberately coarser than per-material: an image's
// storage key names a teacher (`<teacherId>/library/images/...`) but not the
// material it appears in, and one image can legitimately appear in several
// materials at once, so there is no single material to check against. Checking
// the teacher instead is one indexed lookup and matches how the content is
// actually shared — every material a student can reach belongs to a teacher
// they are already linked to.
//
// WHAT THAT TRADES AWAY: a student on teacher X's roster who somehow learns
// the key of an image inside a material they were never given could load it.
// Keys are unguessable (timestamp + random suffix, never listed to a student),
// the content is that same teacher's teaching material, and the alternative —
// threading a material id through every embedded image URL — would break the
// moment a teacher reused one picture across two materials. Recorded here
// rather than left implicit so a future reader can revisit it deliberately.
//
// WHY A ROUTE AND NOT A SIGNED URL IN THE BODY. Bodies are stored, cached and
// re-rendered for months; a signed URL expires in days. The body stores the
// stable storage key, and this route turns it into a fresh signed URL on every
// request, so a material's pictures never rot.

export type ImageViewer =
  | { kind: "teacher"; teacherId: string }
  | { kind: "student"; studentId: string; email: string | null };

/** May this viewer load the image at `key`?
 *
 * Returns false for any key that isn't shaped like a material image path at
 * all, so a malformed or traversing key is rejected before it reaches storage
 * rather than being run through an ownership check against a null teacher. */
export async function canViewMaterialImage(key: string, viewer: ImageViewer): Promise<boolean> {
  const ownerTeacherId = materialImageOwner(key);
  if (!ownerTeacherId) return false;

  if (viewer.kind === "teacher") return viewer.teacherId === ownerTeacherId;

  // A person can hold several Student rows — one per teacher, keyed by the
  // same normalized email (see the Student model's own comment). The link
  // check therefore runs over the whole identity set, exactly like every other
  // student-portal read, or a student signed in under one teacher's row would
  // be denied images from another teacher they genuinely study with.
  const identityIds = await studentIdentityIds({ id: viewer.studentId, email: viewer.email });
  const link = await prisma.teacherStudent.findFirst({
    where: { teacherId: ownerTeacherId, studentId: { in: identityIds } },
    select: { studentId: true },
  });
  return link !== null;
}
