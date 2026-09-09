// Alicia Moreno reads the roster as "how many classes are left to teach," and
// expects that number to tick down when she marks a class GIVEN — not when it's
// booked. Under Model B the package counts a class as used at *reservation*, so
// `classesTotal - classesUsed` ("available to book") never moves on completion,
// and the earlier taught/scheduled/available breakdown both confused her and
// showed wrong counts for her imported roster (taught was derived from booking
// rows that imported history doesn't have).
//
// So we show classes LEFT TO TEACH:
//
//   left = classesTotal - taught,  where taught = classesUsed - scheduled
//        = (classesTotal - classesUsed) + scheduled
//
// Keeping still-upcoming scheduled classes in the "left" bucket means the count
// is unchanged when a class is booked and drops by exactly one when it's marked
// complete (scheduled → completed) — matching how she tracks her notebook. It's
// also correct at the edges: a ≥24h cancel refunds the slot (no change to
// left-to-teach), while a no-show or <24h penalty cancel burns it (left drops).

export type PackageUsage = {
  classesTotal: number;
  classesUsed: number;
  // Bookings currently in `scheduled` status for this package.
  scheduled: number;
};

// Classes still to be taught in the package. Clamped to [0, classesTotal] as a
// guard against dirty data; in normal operation classesUsed ≥ scheduled, so the
// raw expression already lands in range.
export function classesLeftToTeach({ classesTotal, classesUsed, scheduled }: PackageUsage): number {
  return Math.min(classesTotal, Math.max(0, classesTotal - classesUsed + scheduled));
}

export function formatPackageUsage(usage: PackageUsage, en: boolean): string {
  const left = classesLeftToTeach(usage);
  const available = en
    ? `${left} available`
    : `${left} ${left === 1 ? "disponible" : "disponibles"}`;
  return en
    ? `Package of ${usage.classesTotal} · ${available}`
    : `Paquete de ${usage.classesTotal} · ${available}`;
}
