// Request-scoped auth for route handlers that take a plain `Request` — the
// counterpart to `requireTeacher()` / `requireOnboardedTeacher()` in
// `src/lib/auth.ts`, which read `next/headers` instead and answer a failure by
// redirecting.
//
// Two things make this a separate module rather than a wrapper:
//
//  1. **It throws instead of redirecting.** `ApiAuthError` carries a status and
//     a machine-readable reason, which `./route.ts`'s `handle()` turns into a
//     JSON body. A `fetch()` caller follows a redirect and then dies parsing
//     HTML, so a route a script or a client component calls cannot use the
//     page guards.
//  2. **It resolves the session from the request's own headers.** better-auth
//     resolves `auth.api.getSession({ headers })` from a cookie or a bearer
//     token identically, so the same gate serves either.
//
// It is deliberately NOT imported from `lib/auth.ts`: that file's module graph
// (next/headers, subscriptions/*, starter-templates, slug, …) is much heavier,
// and the two lines duplicated below beat that coupling. That reason predates
// this file's rename and still holds.
//
// **On the name.** Nine of this file's eleven exports went with a large route
// deletion — the session payload builder, the student and superuser gates, the
// notification-recipient resolver, the admin-role lookup and a force-update
// gate. What is left is what the web code actually calls.

import * as Sentry from "@sentry/nextjs";
import { auth } from "@/lib/auth/server";
import { identifyServerUser } from "@/lib/analytics/posthog";
import { prisma } from "@/lib/prisma";

import type { Teacher } from "@prisma/client";

// Tag the current request's Sentry scope + identify to PostHog, exactly like
// lib/auth.ts's requireTeacher/requireAdmin do for page requests, so a request
// authorized here identifies the SAME way.
function attachActorToObservability(
  actor: { id: string; email: string | null },
  role: "teacher" | "student" | "admin",
): void {
  Sentry.setUser({ id: actor.id, ...(actor.email ? { email: actor.email } : {}) });
  identifyServerUser(actor.id, { email: actor.email, role });
}

export type ApiSessionUser = {
  authUserId: string;
  email: string;
  name: string | null;
  twoFactorEnabled: boolean;
};

/** A refusal a route handler can turn into a JSON body — see `./route.ts`. */
export class ApiAuthError extends Error {
  status: number;
  reason: string;
  // Extra JSON fields merged onto the error body — e.g. `retryAfterMs` on a
  // 429 "rate-limited" so a client can drive an accurate retry countdown.
  extra?: Record<string, unknown>;
  constructor(status: number, reason: string, extra?: Record<string, unknown>) {
    super(reason);
    this.status = status;
    this.reason = reason;
    this.extra = extra;
  }
}

export async function getApiUser(req: Request): Promise<ApiSessionUser | null> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user) return null;
  const u = session.user;
  return {
    authUserId: u.id,
    email: u.email,
    name: u.name || null,
    twoFactorEnabled: Boolean(u.twoFactorEnabled),
  };
}

export async function requireApiUser(req: Request): Promise<ApiSessionUser> {
  const user = await getApiUser(req);
  if (!user) throw new ApiAuthError(401, "no-session");
  return user;
}

export async function requireApiTeacher(req: Request): Promise<Teacher> {
  const user = await requireApiUser(req);
  const teacher = await prisma.teacher.findUnique({ where: { id: user.authUserId } });
  if (!teacher) throw new ApiAuthError(403, "no-teacher-row");
  // Mirror the web `requireTeacher()` moderation kill-switch — without this,
  // disabling a teacher does nothing on this surface.
  if (teacher.disabledAt) throw new ApiAuthError(403, "teacher-disabled");
  attachActorToObservability(teacher, "teacher");
  return teacher;
}

export async function requireApiOnboardedTeacher(req: Request): Promise<Teacher> {
  const teacher = await requireApiTeacher(req);
  if (!teacher.onboardingCompleteAt) throw new ApiAuthError(409, "onboarding-incomplete");
  return teacher;
}
