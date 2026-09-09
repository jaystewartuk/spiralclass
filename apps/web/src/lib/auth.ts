import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { FALLBACK_TIMEZONE } from "@spiralclass/shared";
import { auth } from "@/lib/auth/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { generateBookingSlug } from "@/lib/slug";
import { starterAvailabilityFor, starterTemplatesFor } from "@/lib/starter-templates";
import { identifyServerUser } from "@/lib/analytics/posthog";
import { REFERRAL_COOKIE } from "@/lib/subscriptions/referral";
import { provisionNewTeacher } from "@/lib/teacher-provisioning";
import { hasClaimableStudentRow, resolveLinkedStudent } from "@/lib/auth/student-link";
import { getPreferredLocale } from "@/lib/i18n";

// Tag the current request's Sentry isolation scope + identify to PostHog
// so any error captured downstream carries the user, and replays/funnels
// associate with the real Person. Called once per requireTeacher /
// requireStudent / requireAdmin pass. Safe to call repeatedly — Sentry
// merges; PostHog dedupes per-process.
//
// NOT shared with lib/api/auth.ts's requireApiTeacher, which does the
// identical two calls locally — importing this file from there would drag its
// whole module graph (next/headers, subscriptions/*, starter-templates, slug,
// …) into every route handler's dynamic import. That was measured when there
// were 220 such handlers and it tripped their 5s per-test timeout under full
// suite load; there are far fewer now, but two lines duplicated is still
// cheaper than the coupling.
function attachActorToObservability(
  actor: { id: string; email: string | null },
  role: "teacher" | "student",
): void {
  Sentry.setUser({ id: actor.id, ...(actor.email ? { email: actor.email } : {}) });
  identifyServerUser(actor.id, { email: actor.email, role });
}

// Request-memoized via React `cache`: layouts nest (e.g. the student group
// layout and the /my-classes layout both read the current student in one
// render), so without this each caller re-hits better-auth / Postgres. cache()
// is per-request, so it never leaks a session across users.
export const getAuthUser = cache(async () => {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ?? null;
});

export async function requireAuthUser() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");
  return user;
}

export const getCurrentTeacher = cache(async () => {
  const user = await getAuthUser();
  if (!user) return null;
  return prisma.teacher.findUnique({ where: { id: user.id } });
});

export const getCurrentStudent = cache(async () => {
  const user = await getAuthUser();
  if (!user) return null;
  return prisma.student.findFirst({ where: { authUserId: user.id } });
});

// Ensures a teacher row exists for the authenticated user, creating it
// with sensible defaults if it doesn't (covers dashboard-created users
// and the confirm-email-on signup path). Always returns a teacher.
//
// If the user is already linked as a student, redirects to the student
// portal instead of lazy-creating a teacher row.
//
// Request-memoized like getCurrentTeacher: the (app) layout and the page it
// wraps both resolve the teacher in a single render, so without cache() they
// would each run the lazy create() concurrently for a brand-new teacher and
// the loser would throw a unique-constraint error.
export const requireTeacher = cache(async () => {
  const user = await requireAuthUser();
  const existing = await prisma.teacher.findUnique({ where: { id: user.id } });
  if (existing) {
    if (existing.disabledAt) redirect("/?error=teacher-disabled");
    attachActorToObservability(existing, "teacher");
    return existing;
  }

  // Teacher and Student are mutually exclusive roles per auth identity
  // (docs/architecture/multi-teacher-students.md "Mutual exclusivity"): this
  // login already owns a Student row, so refuse to also mint a Teacher row
  // for it. The explanatory query param mirrors `/?error=teacher-disabled`
  // above — silently redirecting left the user with no idea why they never
  // reached the dashboard.
  // Checked via hasClaimableStudentRow, NOT `authUserId: user.id`. The link is
  // exactly what a first-time buyer is missing: her Student row was created by
  // checkout with `authUserId: null`, so an `authUserId` lookup answered "not a
  // student" and this function went on to mint her a Teacher row — starter
  // packages, starter availability, teacher onboarding — for an account that
  // had just paid for lessons.
  //
  // That is worse than a misroute. The new Teacher row makes
  // resolveLinkedStudent() return `conflict` for that identity permanently, so
  // she can never be linked to her own Student row again without an operator
  // deleting the Teacher row by hand. Refusing to provision is the only safe
  // default: a genuine teacher who has never signed in has no roster row
  // carrying her email, so this cannot lock a real teacher out.
  if (await hasClaimableStudentRow({ id: user.id, email: user.email })) {
    redirect("/my-classes?notice=already-student");
  }

  const email = user.email ?? `${user.id}@unknown.local`;
  const name = user.name?.trim() || email.split("@")[0] || "Maestra";

  // Lightweight ambassador attribution: a `?ref=CODE` on the onboarding link
  // is stashed in a cookie (see lib/subscriptions/referral.ts); capture it on
  // the row at signup so the commission report can attribute this teacher.
  let referralSource: string | null = null;
  try {
    const code = (await cookies()).get(REFERRAL_COOKIE)?.value?.trim();
    if (code) referralSource = code.slice(0, 64);
  } catch {
    // No request cookies (e.g. background context) — attribution stays null.
  }

  // Seeded package names come from the i18n catalog in the
  // teacher's own locale (cookie, then Accept-Language), falling back to the
  // platform default when the request resolves neither — see
  // starter-templates.ts for why that fallback is no longer es-MX.
  const starterLocale = await getPreferredLocale();

  let teacher;
  try {
    teacher = await prisma.teacher.create({
      data: {
        id: user.id,
        email,
        name,
        // Nothing is known about where she is at provision time — the request
        // carries no zone — so seed the neutral fallback rather than a market's
        // zone that renders as a plausible wrong answer. The onboarding
        // timezone step detects her real zone and re-stamps these starter
        // rules (saveTimezoneAction), so this value is transient by design.
        timezone: FALLBACK_TIMEZONE,
        bookingSlug: generateBookingSlug(email),
        referralSource,
        // Stamp the same resolved locale already used for the starter package
        // names onto the row itself. Without this the column stays at its "en"
        // default forever unless she later opens the language picker (the only
        // other writer, setLocaleAction) — even though her dashboard already
        // renders in her detected language every request via getPreferredLocale
        // (cookie, then Accept-Language). Background jobs with no request
        // context (lesson-insights/brief generation) read this column directly,
        // so a Spanish-reading teacher who never touched Settings → Language got
        // English AI output while her whole UI was correctly in Spanish.
        locale: starterLocale,
        packageTemplates: { create: starterTemplatesFor(starterLocale) },
        availabilityRules: { create: starterAvailabilityFor(FALLBACK_TIMEZONE) },
      },
      include: { packageTemplates: { select: { id: true } } },
    });
  } catch (err) {
    // Lost a concurrent lazy-provision race (a second request — e.g. a
    // router prefetch racing the real navigation — created the row first).
    // The winner already ran the welcome side effects; adopt its row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const created = await prisma.teacher.findUnique({ where: { id: user.id } });
      if (created) {
        if (created.disabledAt) redirect("/?error=teacher-disabled");
        attachActorToObservability(created, "teacher");
        return created;
      }
    }
    throw err;
  }

  attachActorToObservability(teacher, "teacher");
  // Trial provisioning + signup/starter-template analytics: shared with
  // mobile's lazy-create so a mobile signup can never silently skip
  // trial_started again.
  await provisionNewTeacher(teacher);

  return teacher;
});

export async function requireOnboardedTeacher() {
  const teacher = await requireTeacher();
  if (!teacher.onboardingCompleteAt) redirect("/onboarding/timezone");
  return teacher;
}

// Student portal guard. Redirects to `/` if the user isn't linked to a
// student row — they likely arrived here without ever clicking a booking
// link. A dedicated "which teacher?" flow would be the fix if that ever
// becomes common; nothing has asked for it.
export async function requireStudent() {
  const user = await requireAuthUser();
  let student = await prisma.student.findFirst({ where: { authUserId: user.id } });

  // Not linked yet — try to claim the row before giving up.
  //
  // This used to `redirect("/")` immediately, which made the portal reachable
  // only AFTER some other code path had already linked the identity. Three did;
  // the magic-link route a first-time buyer arrives on did not, so a paying
  // student was bounced to the landing page, offered the teacher dashboard, and
  // lazily provisioned as a teacher.
  //
  // Doing the link here as well means any path that establishes a valid
  // session gets a working portal on first request — including one added later
  // that forgets. The resolver is idempotent and race-safe (unique
  // `auth_user_id`, P2002 loser re-reads the winner), so calling it from more
  // than one place is safe by design.
  if (!student) {
    const linked = await resolveLinkedStudent({ id: user.id, email: user.email });
    if (linked.status === "linked") {
      student = await prisma.student.findUnique({ where: { id: linked.id } });
    }
  }

  // Still nothing: either no roster row carries this email, or this identity
  // already owns a Teacher row (`conflict` — the roles are mutually
  // exclusive). Say which, instead of a bare bounce to `/` that leaves someone
  // who has just paid with no idea why her classes aren't there.
  if (!student) redirect("/?error=no-student-record");

  attachActorToObservability(student, "student");
  return student;
}
