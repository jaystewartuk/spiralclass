import { ensureSubscriptionForTeacher } from "@/lib/subscriptions/service";
import { trackServerEvent } from "@/lib/analytics/posthog";
import { logger } from "@/lib/logger";

const log = logger({ surface: "teacher-provisioning" });

type NewTeacher = { id: string; packageTemplates: { id: string }[] };

/**
 * First-signup side effects, called from web's lazy-create (`requireTeacher`
 * in lib/auth.ts).
 *
 * It is its own module because there were once TWO lazy-creates — this one and
 * a mobile session resolver — duplicated with a real gap: the mobile copy never
 * called `ensureSubscriptionForTeacher` or emitted `trial_started`, so a
 * mobile-origin teacher's trial got provisioned later, silently, on the first
 * subscription-status fetch, and never appeared in a `trial_started` funnel at
 * all (the teacher-activation review). The second caller is deleted; the
 * shape stays, because "the side effects of a first signup" is a thing worth
 * being able to point at.
 *
 * Deliberately NOT placed in lib/auth.ts, and that still binds: this module
 * imports only the subscription service and the analytics wrapper, where
 * lib/auth.ts drags in next/headers and a large transitive graph.
 */
export async function provisionNewTeacher(teacher: NewTeacher): Promise<void> {
  trackServerEvent({
    name: "teacher_signup_completed",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id },
  });
  for (const tpl of teacher.packageTemplates) {
    trackServerEvent({
      name: "package_template_created",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id, templateId: tpl.id, source: "starter_seed" },
    });
  }

  // Best-effort: a brand-new teacher must never be blocked by this failing.
  try {
    await ensureSubscriptionForTeacher(teacher.id);
    trackServerEvent({
      name: "trial_started",
      distinctId: teacher.id,
      properties: { teacherId: teacher.id },
    });
  } catch (err) {
    log.warn("subscription provisioning failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
