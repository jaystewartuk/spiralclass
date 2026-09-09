import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Teacher and Student are mutually exclusive roles per auth identity (see
// docs/architecture/multi-teacher-students.md "Mutual exclusivity"): a
// Teacher row is the payee identity, a Student row is the payer identity,
// and merging them under one login would tangle RLS/billing context. The
// `id` -> "linked" / "conflict" / "none" discriminant lets every caller
// branch explicitly instead of treating a blocked link as a plain miss.
export type ResolveLinkedStudentResult =
  // `alreadyLinked` is true when this auth identity already owned a linked
  // Student row before this call (an existing account picking up a new
  // teacher's roster row), false when this call performed the first-ever
  // link for the identity. Lets a caller like invitation acceptance tell
  // "existing account" from "fresh signup" apart — see posthog.ts's
  // `invitation_existing_account_linked` vs `invitation_accepted`.
  | { status: "linked"; id: string; alreadyLinked: boolean }
  | { status: "conflict" }
  | { status: "none" };

// Single resolver for "which Student row owns this auth user?" — shared by
// the web callback route, the post-setSession server action, and the mobile
// OTP exchange so all three link identically. (They previously diverged in
// ordering and roster filtering, which made the outcome of a first sign-in
// non-deterministic when an email matched more than one row.)
//
// Linking rules:
//   * an already-linked row always wins (`auth_user_id` is unique);
//   * otherwise link the OLDEST unlinked row with that email that sits on
//     some teacher's roster. Oldest = the row minted by the person's first
//     checkout, i.e. the one carrying their history, and it can't flip to a
//     different row on a later sign-in. Rosterless rows are orphans from
//     old seed runs and never win. Matching is case-insensitive: Supabase
//     lowercases auth emails; legacy student rows may predate the
//     write-boundary normalization.
//   * two concurrent first sign-ins can race the update into the unique
//     constraint; the loser re-reads and returns the winner's row.
//   * before linking, this auth identity must not already own a Teacher row
//     (Teacher.id === auth.users.id) — Teacher/Student are mutually
//     exclusive, so a match is refused rather than silently merging the
//     payee and payer identities. Defensive even though every current
//     caller already checks for a Teacher row first: this function is
//     shared, and a future caller skipping that pre-check must not be able
//     to link silently.
/**
 * Non-mutating "would resolveLinkedStudent() find a Student for this identity?"
 *
 * Exists because two read-only guards used to answer that question with
 * `student.findFirst({ where: { authUserId } })` — which is only true AFTER a
 * first sign-in has linked the row. For a student whose first-ever sign-in is
 * the magic link from her own purchase, the row still has `authUserId: null`,
 * so both guards concluded "not a student":
 *
 *   * app/page.tsx offered her the teacher dashboard CTA, and
 *   * requireTeacher() then lazily MINTED A TEACHER ROW for her and dropped
 *     her into teacher onboarding.
 *
 * The second one is not just a bad redirect: once that Teacher row exists,
 * resolveLinkedStudent() returns `conflict` forever (Teacher/Student are
 * mutually exclusive per identity), so a paying student's account is
 * permanently unable to become a student again until the row is deleted by
 * hand. Both guards now ask this instead.
 *
 * Deliberately read-only: a guard deciding where to send someone, or refusing
 * to provision, must not have the side effect of claiming a row. The actual
 * link is still performed only by resolveLinkedStudent() on a real sign-in
 * path. Mirrors its matching rules (case-insensitive email, unlinked, on some
 * teacher's roster) so the two can't disagree about who is a student.
 */
export async function hasClaimableStudentRow(
  user: { id: string; email?: string | null },
  db: PrismaClient = prisma,
): Promise<boolean> {
  const linked = await db.student.findFirst({
    where: { authUserId: user.id },
    select: { id: true },
  });
  if (linked) return true;
  if (!user.email) return false;

  const claimable = await db.student.findFirst({
    where: {
      email: { equals: user.email, mode: "insensitive" },
      authUserId: null,
      teacherStudents: { some: {} },
    },
    select: { id: true },
  });
  return claimable != null;
}

export async function resolveLinkedStudent(
  user: {
    id: string;
    email?: string | null;
  },
  db: PrismaClient = prisma,
): Promise<ResolveLinkedStudentResult> {
  const linked = await db.student.findFirst({
    where: { authUserId: user.id },
    select: { id: true },
  });
  if (linked) return { status: "linked", id: linked.id, alreadyLinked: true };
  if (!user.email) return { status: "none" };

  const match = await db.student.findFirst({
    where: {
      email: { equals: user.email, mode: "insensitive" },
      authUserId: null,
      teacherStudents: { some: {} },
    },
    // `id` is a deterministic tiebreaker so two concurrent first sign-ins pick
    // the *same* oldest row even when several share an identical createdAt —
    // keeping the "oldest unlinked row wins" invariant fully deterministic.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!match) return { status: "none" };

  const ownTeacherRow = await db.teacher.findUnique({
    where: { id: user.id },
    select: { id: true },
  });
  if (ownTeacherRow) return { status: "conflict" };

  try {
    await db.student.update({
      where: { id: match.id },
      data: { authUserId: user.id },
    });
    return { status: "linked", id: match.id, alreadyLinked: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await db.student.findFirst({
        where: { authUserId: user.id },
        select: { id: true },
      });
      // A concurrent request already won the link — from this call's
      // perspective the identity now has a pre-existing linked row.
      return winner ? { status: "linked", id: winner.id, alreadyLinked: true } : { status: "none" };
    }
    throw err;
  }
}
