"use server";

import { requireTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { disconnectGoogleCalendar } from "@/lib/calendar/google/connection";
import { syncTeacherBusy } from "@/lib/calendar/google/sync";
import { revalidateAfterAction } from "@/lib/revalidate";

export type GoogleCalendarActionState = { error?: string; ok?: boolean } | undefined;

const SETTINGS_PATH = "/settings/calendar";

// Disconnect: revoke the token, drop the connection + imported busy intervals.
export async function disconnectGoogleCalendarAction(
  _prev: GoogleCalendarActionState,
  _formData: FormData,
): Promise<GoogleCalendarActionState> {
  void _prev;
  void _formData;
  const teacher = await requireTeacher();
  await disconnectGoogleCalendar(teacher.id);
  revalidateAfterAction(SETTINGS_PATH);
  return { ok: true };
}

// Manual "sync now" — handy when the teacher just changed their Google calendar
// and doesn't want to wait for the next poll.
export async function resyncGoogleCalendarAction(
  _prev: GoogleCalendarActionState,
  _formData: FormData,
): Promise<GoogleCalendarActionState> {
  void _prev;
  void _formData;
  const teacher = await requireTeacher();
  const result = await syncTeacherBusy(teacher.id);
  revalidateAfterAction(SETTINGS_PATH);
  if (result.status === "error") return { error: result.error };
  return { ok: true };
}

// Pause / resume busy-import without disconnecting (keeps the token). The hidden
// `enabled` field carries the target state.
export async function setGoogleSyncEnabledAction(
  _prev: GoogleCalendarActionState,
  formData: FormData,
): Promise<GoogleCalendarActionState> {
  void _prev;
  const teacher = await requireTeacher();
  const enabled = formData.get("enabled") === "true";
  await prisma.googleCalendarConnection.updateMany({
    where: { teacherId: teacher.id },
    data: { syncEnabled: enabled },
  });
  // Resuming triggers a fresh sync so slots reflect reality right away.
  if (enabled) await syncTeacherBusy(teacher.id);
  // Pausing clears the imported intervals so they stop blocking slots.
  else await prisma.googleBusyInterval.deleteMany({ where: { teacherId: teacher.id } });
  revalidateAfterAction(SETTINGS_PATH);
  return { ok: true };
}
