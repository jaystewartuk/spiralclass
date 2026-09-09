// Notification category definitions shared between web and mobile.
// The web preferences lib and the mobile notifications screen both import
// from here so adding a category in one place covers both platforms.

export const NOTIFICATION_CATEGORIES = [
  "class_reminders",
  "booking_updates",
  "class_materials",
  "expiry_reminders",
  "messages",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const TEACHER_NOTIFICATION_CATEGORIES = [
  // Pre-class reminders about the teacher's own upcoming classes — the teacher
  // mirror of the student "class_reminders" category. Independently toggleable.
  "class_reminders",
  "class_activity",
  "student_progress",
  "subscription",
  "growth",
  "messages",
] as const;

export type TeacherNotificationCategory = (typeof TEACHER_NOTIFICATION_CATEGORIES)[number];

// Delivery channels available across the system. Shared so both the web
// dispatcher and the mobile settings screen use the same literal set.
export const NOTIFICATION_CHANNELS = ["push", "email"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

// Channels available to teacher recipients. Push requires a registered device
// token; email is the terminal fallback.
export const TEACHER_NOTIFICATION_CHANNELS = ["push", "email"] as const;
export type TeacherNotificationChannel = (typeof TEACHER_NOTIFICATION_CHANNELS)[number];
