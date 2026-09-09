"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  READING_COOKIE,
  READING_DEFAULTS,
  READING_SCALES,
  encodeReading,
  type ReadingPreferences,
} from "@/lib/reading";

/**
 * Saves a reader's text scale, spacing and tint (D-140).
 *
 * Written to TWO places on purpose, and the order matters. The cookie is what
 * the next server render reads, so the first paint is already correct; the
 * column is what makes the choice follow her to another device. If the column
 * write fails the cookie still stands for this browser, which is the
 * degradation that costs least.
 *
 * Signed-out readers get the cookie alone. That is deliberate rather than a
 * gap: the public booking page is where a prospective student meets the
 * product, and asking her to sign in before she can make the text bigger would
 * be the wrong way round.
 */
export async function saveReadingPreferences(prefs: ReadingPreferences): Promise<void> {
  const scale = READING_SCALES.includes(prefs.scale as (typeof READING_SCALES)[number])
    ? prefs.scale
    : READING_DEFAULTS.scale;
  const spacing = prefs.spacing === 1 || prefs.spacing === 2 ? prefs.spacing : 0;
  const clean: ReadingPreferences = { scale, spacing, tint: Boolean(prefs.tint) };

  const store = await cookies();
  store.set(READING_COOKIE, encodeReading(clean), {
    path: "/",
    // A year: this is a setting, not a session. Not httpOnly, because the
    // client control reads it back to show which option is selected.
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });

  const user = await getAuthUser().catch(() => null);
  if (!user?.email) return;

  const data = {
    readingScale: clean.scale,
    readingSpacing: clean.spacing,
    readingTint: clean.tint,
  };
  // A person can be a teacher, a student, or both. Both rows are updated when
  // both exist — the preference is about her eyes, not about which product
  // surface she happens to be on.
  await Promise.all([
    prisma.teacher.updateMany({ where: { email: user.email }, data }),
    prisma.student.updateMany({ where: { email: user.email }, data }),
  ]).catch(() => {
    // The cookie is already set, so the reader still gets what she asked for on
    // this device. Losing the cross-device copy is not worth failing the action.
  });

  revalidatePath("/", "layout");
}
