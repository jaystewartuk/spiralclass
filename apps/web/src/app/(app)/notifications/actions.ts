"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireTeacher } from "@/lib/auth";
import {
  markAllTeacherNotificationsRead,
  markTeacherNotificationRead,
} from "@/lib/notifications/inbox-queries";

/**
 * The only paths these actions will send a browser to.
 *
 * Same-origin RELATIVE paths only; never an absolute URL supplied via the
 * form. "//host" is rejected alongside "http(s)://host" — it looks relative
 * but a browser reads it as protocol-relative and leaves the origin.
 */
function safeRelativePath(value: string, fallback: string): string {
  return value.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

// Open a single notification: mark it read, then navigate to its destination
// (if any). Driven by a per-row <form> so it works without client JS — the
// notification id, its target href and the view to come back to ride in
// hidden inputs.
export async function openNotificationAction(formData: FormData): Promise<void> {
  const teacher = await requireTeacher();
  const id = String(formData.get("id") ?? "");
  const href = String(formData.get("href") ?? "");
  // Where to land when the notification has no destination of its own. The
  // inbox is filtered and paged, so "/notifications" would silently drop her
  // back to the first page of All from wherever she actually was.
  const returnTo = safeRelativePath(String(formData.get("return") ?? ""), "/notifications");

  if (id) {
    await markTeacherNotificationRead(teacher.id, id);
  }
  // Revalidate the shell so the nav bell badge reflects the new read count on
  // the next render.
  revalidatePath("/", "layout");

  redirect(safeRelativePath(href, returnTo));
}

export async function markAllReadAction(formData: FormData): Promise<void> {
  const teacher = await requireTeacher();
  await markAllTeacherNotificationsRead(teacher.id);
  revalidatePath("/", "layout");
  // Back to the view she was in, minus its cursor: every row on the page she
  // was looking at is now read, so an "Unread" page-two cursor points at a
  // position that no longer exists.
  redirect(safeRelativePath(String(formData.get("return") ?? ""), "/notifications"));
}
