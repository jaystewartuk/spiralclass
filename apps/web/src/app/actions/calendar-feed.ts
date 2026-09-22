"use server";

/* eslint-disable @typescript-eslint/no-unused-vars -- server actions
 * called via useActionState must accept (prev, formData); these
 * actions are confirm-only (no fields) so neither parameter is used. */

import { requireTeacher, requireStudent } from "@/lib/auth";
import { rotateTeacherFeedToken, rotateStudentFeedToken } from "@/lib/calendar/feed-token";
import { revalidateAfterAction } from "@/lib/revalidate";

export type FeedActionState = { error?: string; ok?: boolean } | undefined;

// Regenerate the calendar feed token, invalidating any previously shared
// subscription URL. The page re-reads the (new) token on revalidate.

export async function regenerateTeacherFeedAction(
  _prev: FeedActionState,
  _formData: FormData,
): Promise<FeedActionState> {
  const teacher = await requireTeacher();
  await rotateTeacherFeedToken(teacher.id);
  revalidateAfterAction("/settings/calendar");
  return { ok: true };
}

export async function regenerateStudentFeedAction(
  _prev: FeedActionState,
  _formData: FormData,
): Promise<FeedActionState> {
  const student = await requireStudent();
  await rotateStudentFeedToken(student.id);
  revalidateAfterAction("/my-classes/account");
  return { ok: true };
}
