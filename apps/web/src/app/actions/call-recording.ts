"use server";

import { revalidatePath } from "next/cache";

import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  startBookingRecording,
  stopBookingRecording,
  type RecordingResult,
} from "@/lib/video/call-recording";

// Web server-action wrappers around the shared recording core
// (lib/video/call-recording.ts). The core owns the booking-scoped logic — the
// D-22 consent gate, the stale-row self-heal — shared verbatim with the mobile
// API route; here we only add web auth + cache revalidation. The visible
// "Recording" indicator both parties see is driven by LiveKit's own recording
// state, so there is no silent recording.

export async function startCallRecording(bookingId: string): Promise<RecordingResult> {
  const teacher = await requireOnboardedTeacher();
  const result = await startBookingRecording(prisma, teacher.id, bookingId);
  if (result.ok) revalidatePath(`/dashboard/classes/${bookingId}`);
  return result;
}

export async function stopCallRecording(bookingId: string): Promise<RecordingResult> {
  const teacher = await requireOnboardedTeacher();
  const result = await stopBookingRecording(prisma, teacher.id, bookingId);
  if (result.ok) revalidatePath(`/dashboard/classes/${bookingId}`);
  return result;
}
