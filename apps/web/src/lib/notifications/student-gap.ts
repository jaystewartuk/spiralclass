import type { NotificationCategory } from "@spiralclass/shared";
import { isCategoryEnabled, isNotificationsFullyDisabled } from "./preferences";

/**
 * Whether a student will actually be TOLD about something a teacher is about
 * to send, assign or schedule for her (D-204).
 *
 * The dispatcher gates by category before any channel is tried, so a student
 * with `class_materials` off receives neither push nor email for materials or
 * homework, and the teacher's screen read as "sent" either way. This is the
 * pure half of the teacher-side notice: the page asks it, the component
 * renders the answer.
 *
 *  - `ok`           — she will be notified.
 *  - `category_off` — she turned that category off (or it was stored off by an
 *                     earlier default); the item still reaches her portal.
 *  - `paused`       — the roster-import snapshot: every category off until the
 *                     teacher launches her (`isNotificationsFullyDisabled`).
 */
export type StudentNotificationGap = "ok" | "category_off" | "paused";

export function studentNotificationGap(
  prefs: Partial<Record<string, unknown>> | null | undefined,
  category: NotificationCategory,
): StudentNotificationGap {
  if (isNotificationsFullyDisabled(prefs)) return "paused";
  return isCategoryEnabled(prefs, category) ? "ok" : "category_off";
}
