import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// The id set a signed-in student's portal operates over.
//
// Multi-teacher tenancy keeps one Student row per (teacher, email) — see
// schema.prisma — so a person studying with two teachers has two rows, and
// only the oldest carries the auth link (resolveLinkedStudent). Their
// sign-in proved ownership of the INBOX, and the inbox is the account: it
// receives every sibling row's magic links and notifications already. So
// the portal reads/acts across every non-moderated row sharing the linked
// row's email — that's exactly what the inbox owner legitimately controls,
// and nothing more.
//
// Deliberately read-side: rows are NOT consolidated and row fields are NOT
// propagated, because same inbox ≠ same person (a parent can enroll two
// kids with different teachers under one email — the merge tooling refuses
// cross-tenant merges for the same reason). Each row keeps its own name and
// roster metadata; the inbox owner just sees and manages all of it.
//
// Sanctioned exception to "no propagation", inbox-scoped:
//   * email opt-out + push opt-out + lifecycle notification prefs apply
//     across the set — they describe the MAILBOX, and the portal manages
//     them from one screen (see saveNotificationPrefsAction / applyEmailOptOut).
//
// The linked row is always first and always included (callers gate its
// moderation state themselves); moderated siblings are excluded so a
// disabled row's packages can't be drawn against through the linked login.
export async function studentIdentityIds(
  linked: {
    id: string;
    email: string | null;
  },
  db: PrismaClient = prisma,
): Promise<string[]> {
  if (!linked.email) return [linked.id];
  const siblings = await db.student.findMany({
    where: {
      email: { equals: linked.email, mode: "insensitive" },
      id: { not: linked.id },
      disabledAt: null,
    },
    select: { id: true },
  });
  return [linked.id, ...siblings.map((s) => s.id)];
}

// The ONE pairing row a purchase by this identity lands on for this teacher.
//
// Every surface that DISPLAYS a price and every surface that CHARGES one has
// to agree on this row, because an agreed price (teacher overrides) is stored per
// (teacher, student row, template): resolve it against a different row of the
// same identity and the portal shows one number while checkout charges
// another. That was a real production bug — a teacher set an agreed price, the
// buy page rendered it and labelled it "tu precio acordado", and the student
// was charged the catalog price, because the page resolved agreed prices
// across the whole identity set while checkout resolved them for the pairing
// row alone. `grandfatheredPricesForAny` (identity-wide) existed for that read
// and is gone; there is one resolver now, and it starts here.
//
// Note what the identity-wide read could never actually buy: a price row is
// FK'd to `teacher_students`, so a row holding a price for THIS teacher is by
// construction paired with THIS teacher. Spanning the identity therefore only
// ever picked up a SECOND pairing with the same teacher on a sibling student
// row — which is the divergence, not a feature.
//
// Oldest non-archived pairing. Archived ("dar de baja") means the teacher
// parked the relationship, so the portal stops offering her packages
// proactively — such a row can neither be sold through nor price a sale.
// Oldest, because the portal's own teacher list is ordered that way, so a
// duplicate pairing across sibling rows resolves identically on both sides.
// ("One row per (teacher, email)" is an app-level invariant, not a DB
// constraint — see schema.prisma — so duplicates are possible and must
// resolve deterministically rather than be assumed away.)
export async function purchasingLinkFor(
  teacherId: string,
  identityIds: readonly string[],
  db: PrismaClient = prisma,
): Promise<{ studentId: string } | null> {
  if (identityIds.length === 0) return null;
  return db.teacherStudent.findFirst({
    where: { teacherId, studentId: { in: [...identityIds] }, archivedAt: null },
    orderBy: { createdAt: "asc" },
    select: { studentId: true },
  });
}

// Compliance variant for deletion + data export: ARCO/GDPR rights reach
// EVERY row holding the person's data, including moderated ones — a
// disabled row still stores their name/email/phone. Never use this for
// portal reads or booking (that's what the moderation exclusion above is
// for).
export async function studentComplianceIds(
  linked: {
    id: string;
    email: string | null;
  },
  db: PrismaClient = prisma,
): Promise<string[]> {
  if (!linked.email) return [linked.id];
  const siblings = await db.student.findMany({
    where: {
      email: { equals: linked.email, mode: "insensitive" },
      id: { not: linked.id },
    },
    select: { id: true },
  });
  return [linked.id, ...siblings.map((s) => s.id)];
}
