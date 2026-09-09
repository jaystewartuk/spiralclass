import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { writeOverride } from "@/lib/audit";
import { logger } from "@/lib/logger";

const log = logger({ surface: "merge-students" });

// Merge two roster rows that belong to the same person (almost always a
// checkout-email typo — the funnel keys identity on the typed address, so
// "mira@gmial.com" mints a second Student whose magic links go nowhere while
// the real row keeps the history). Everything attached to the duplicate —
// packages (payments ride along), bookings, library assignments, device
// tokens, notification history, and the login link if the keeper lacks one —
// moves to the keeper, then the duplicate row is deleted. The `packages` /
// `bookings` student FKs are ON DELETE RESTRICT, so a missed repoint aborts
// the whole transaction instead of losing data.
//
// Refused when the duplicate is linked to another teacher (its row is that
// teacher's tenant data), when both rows have signed in as different auth
// users (two real logins = two real people), when either row is under
// platform moderation, or when the duplicate has a pending deletion request.
// The server action maps each refusal code to localized copy.

export type MergeRefusal =
  "not_on_roster" | "disabled" | "two_logins" | "other_teacher" | "pending_deletion" | "failed";

export type MergeResult =
  | {
      ok: true;
      moved: {
        packages: number;
        bookings: number;
        libraryItems: number;
        notes: number;
        pushSubscriptions: number;
        notifications: number;
        authUserMoved: boolean;
      };
    }
  | { ok: false; code: MergeRefusal };

export async function mergeRosterStudents(
  input: { teacherId: string; keepStudentId: string; mergeStudentId: string },
  db: PrismaClient = prisma,
): Promise<MergeResult> {
  const { teacherId, keepStudentId, mergeStudentId } = input;

  const [keepLink, dupLink] = await Promise.all([
    db.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: keepStudentId } },
      include: { student: true },
    }),
    db.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: mergeStudentId } },
      include: { student: true },
    }),
  ]);
  if (!keepLink || !dupLink) return { ok: false, code: "not_on_roster" };
  const keep = keepLink.student;
  const dup = dupLink.student;

  if (keep.disabledAt || dup.disabledAt) return { ok: false, code: "disabled" };
  if (dup.authUserId && keep.authUserId) return { ok: false, code: "two_logins" };

  // The duplicate row may be another teacher's tenant data too — merging it
  // away would silently edit their roster. (The keeper staying multi-teacher
  // is fine; we only delete the duplicate.)
  const dupOtherTeacher = await db.teacherStudent.findFirst({
    where: { studentId: dup.id, teacherId: { not: teacherId } },
    select: { teacherId: true },
  });
  if (dupOtherTeacher) return { ok: false, code: "other_teacher" };

  // Refuse if EITHER row has a pending deletion request, not just the
  // duplicate. If the KEEPER is scheduled for anonymization, the merge would
  // move the duplicate's live packages and login link onto a row about to be
  // tombstoned — stranding paid classes and severing access at maturity.
  const pendingDeletion = await db.accountDeletionRequest.findFirst({
    where: {
      subjectType: "student",
      subjectId: { in: [dup.id, keep.id] },
      status: "pending",
    },
    select: { id: true },
  });
  if (pendingDeletion) return { ok: false, code: "pending_deletion" };

  try {
    return await db.$transaction(async (tx) => {
      // Library assignments collide on the (student, material) unique key —
      // drop the duplicate's copies of anything the keeper already has,
      // move the rest.
      const keeperItems = await tx.studentLibraryItem.findMany({
        where: { studentId: keep.id },
        select: { libraryMaterialId: true },
      });
      const keeperMaterialIds = keeperItems.map((i) => i.libraryMaterialId);
      if (keeperMaterialIds.length > 0) {
        await tx.studentLibraryItem.deleteMany({
          where: { studentId: dup.id, libraryMaterialId: { in: keeperMaterialIds } },
        });
      }
      const movedItems = await tx.studentLibraryItem.updateMany({
        where: { studentId: dup.id },
        data: { studentId: keep.id },
      });

      // Teacher-private notes are free-form (no per-(student) unique key), so
      // they all repoint to the keeper. Both rows are the same teacher's tenant
      // data (the duplicate is single-teacher, validated above).
      const movedNotes = await tx.studentNote.updateMany({
        where: { studentId: dup.id },
        data: { studentId: keep.id },
      });

      // teacherId filters are belt-and-braces: the duplicate is single-
      // teacher (validated above), so anything that DOESN'T match here is an
      // inconsistency — it stays put and the RESTRICT FK below aborts the
      // merge rather than repointing another tenant's rows.
      const movedPackages = await tx.package.updateMany({
        where: { studentId: dup.id, teacherId },
        data: { studentId: keep.id },
      });
      const movedBookings = await tx.booking.updateMany({
        where: { studentId: dup.id, teacherId },
        data: { studentId: keep.id },
      });
      // ⚠️ This moved a retired token table and never this one, so a
      // merge silently stranded the duplicate's browser subscriptions on a
      // Student row deleted three statements later — the student stopped
      // receiving push and nothing said why.
      const movedSubscriptions = await tx.webPushSubscription.updateMany({
        where: { recipientType: "student", recipientId: dup.id },
        data: { recipientId: keep.id },
      });
      const movedNotifications = await tx.notification.updateMany({
        where: { recipientType: "student", recipientId: dup.id },
        data: { recipientId: keep.id },
      });

      // Move the login link when only the duplicate has one (clear first —
      // auth_user_id is unique).
      const authUserMoved = Boolean(dup.authUserId && !keep.authUserId);
      if (authUserMoved) {
        await tx.student.update({ where: { id: dup.id }, data: { authUserId: null } });
      }

      // Union the contact fields the keeper is missing. Email opt-in stays the
      // keeper's — its address is the surviving identity.
      await tx.student.update({
        where: { id: keep.id },
        data: {
          ...(authUserMoved ? { authUserId: dup.authUserId } : {}),
          ...(keep.phoneE164 == null && dup.phoneE164 != null ? { phoneE164: dup.phoneE164 } : {}),
          ...(keep.timezone == null && dup.timezone != null ? { timezone: dup.timezone } : {}),
          ...(keep.notificationPrefs == null && dup.notificationPrefs != null
            ? { notificationPrefs: dup.notificationPrefs }
            : {}),
        },
      });

      // Same for the roster-link metadata; an archived keeper reactivates if
      // the duplicate side was the active one.
      await tx.teacherStudent.update({
        where: { teacherId_studentId: { teacherId, studentId: keep.id } },
        data: {
          ...(keepLink.levelId == null && dupLink.levelId != null
            ? { levelId: dupLink.levelId }
            : {}),
          ...(keepLink.customPriceNote == null && dupLink.customPriceNote != null
            ? { customPriceNote: dupLink.customPriceNote }
            : {}),
          ...(keepLink.archivedAt != null && dupLink.archivedAt == null
            ? { archivedAt: null, archivedReason: null }
            : {}),
        },
      });

      // Grandfathering: the duplicate's agreed prices move over for any
      // package the keeper has none for. Same union rule the flat column had,
      // now decided per package — the keeper's own agreed price always wins,
      // because it is the one attached to the surviving identity. `skipDuplicates`
      // does that in one statement: rows the keeper already has are left alone.
      const dupPrices = await tx.teacherStudentTemplatePrice.findMany({
        where: { teacherId, studentId: dup.id },
        select: { templateId: true, priceMinorUnits: true, currency: true },
      });
      if (dupPrices.length > 0) {
        await tx.teacherStudentTemplatePrice.createMany({
          data: dupPrices.map((r) => ({
            teacherId,
            studentId: keep.id,
            templateId: r.templateId,
            priceMinorUnits: r.priceMinorUnits,
            currency: r.currency,
          })),
          skipDuplicates: true,
        });
      }

      // Cascades the duplicate's teacher_students link — and with it the
      // duplicate's own agreed prices; throws (rolling everything back) if any
      // package/booking still points at it.
      await tx.student.delete({ where: { id: dup.id } });

      const moved = {
        packages: movedPackages.count,
        bookings: movedBookings.count,
        libraryItems: movedItems.count,
        notes: movedNotes.count,
        pushSubscriptions: movedSubscriptions.count,
        notifications: movedNotifications.count,
        authUserMoved,
      };

      await writeOverride({
        tx,
        teacherId,
        targetType: "student",
        targetId: keep.id,
        action: "merge_students",
        reason: `Merged duplicate ${dup.email ?? dup.id} into ${keep.email ?? keep.id}`,
        before: {
          mergedStudentId: dup.id,
          mergedEmail: dup.email,
          keptEmail: keep.email,
        },
        after: moved,
        actor: null,
      });

      return { ok: true as const, moved };
    });
  } catch (err) {
    log.error("transaction failed", err);
    return { ok: false, code: "failed" };
  }
}
