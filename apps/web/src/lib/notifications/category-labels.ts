import type { StringKey } from "@/lib/i18n-translate";

// Catalog keys for the nine preference categories, in one client-safe module.
//
// They used to live inside notification-prefs-form.tsx, which is a Client
// Component — so the schedule (a Server Component that needs the same nine
// names to head its groups) could not import them without dragging
// `next/headers` and the client boundary into each other. A plain data module
// is importable from both.
//
// The split between a NAME and a HINT is deliberate. Every label used to carry
// its own parenthetical — "Student progress (post-class review nudges,
// finished packages)" — which made a scannable list of switches unscannable,
// and put the explanation at the same weight as the thing being explained. The
// name is now a name; the sentence sits under it in the muted tone.

/** The category's name — a short noun phrase, no parenthetical. */
export const CATEGORY_LABEL_KEYS: Record<string, StringKey> = {
  // Student categories.
  class_reminders: "web.notificationPrefs.category.classReminders",
  booking_updates: "web.notificationPrefs.category.bookingUpdates",
  class_materials: "web.notificationPrefs.category.classMaterials",
  expiry_reminders: "web.notificationPrefs.category.expiryReminders",
  messages: "web.notificationPrefs.category.messages",
  // Teacher categories.
  class_activity: "web.notificationPrefs.category.classActivity",
  student_progress: "web.notificationPrefs.category.studentProgress",
  subscription: "web.notificationPrefs.category.subscription",
  growth: "web.notificationPrefs.category.growth",
};

/** One sentence on what the category actually covers. */
export const CATEGORY_HINT_KEYS: Record<string, StringKey> = {
  class_reminders: "web.notificationPrefs.categoryHint.classReminders",
  booking_updates: "web.notificationPrefs.categoryHint.bookingUpdates",
  class_materials: "web.notificationPrefs.categoryHint.classMaterials",
  expiry_reminders: "web.notificationPrefs.categoryHint.expiryReminders",
  messages: "web.notificationPrefs.categoryHint.messages",
  class_activity: "web.notificationPrefs.categoryHint.classActivity",
  student_progress: "web.notificationPrefs.categoryHint.studentProgress",
  subscription: "web.notificationPrefs.categoryHint.subscription",
  growth: "web.notificationPrefs.categoryHint.growth",
};
