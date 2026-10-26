"use server";

import { parseCaptionTiming } from "@spiralclass/shared";
import { requireTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { revalidateAfterAction } from "@/lib/revalidate";

export type CaptionTimingState = { error?: string; ok?: boolean } | undefined;

// Saves how this teacher's live subtitles are cut into lines (caption-timing.ts
// in @spiralclass/shared). Whatever is posted goes through the same parser the
// call reads with, so a hand-edited form cannot store a value the parser would
// not accept; an out-of-range value is clamped, not rejected. The dials are
// plain preferences, so unlike lesson insights they are not Pro-gated.
export async function saveCaptionTimingAction(
  _prev: CaptionTimingState,
  formData: FormData,
): Promise<CaptionTimingState> {
  const teacher = await requireTeacher();
  const timing = parseCaptionTiming({
    pauseMs: formData.get("pauseMs"),
    maxChars: formData.get("maxChars"),
  });

  await prisma.teacher.update({
    where: { id: teacher.id },
    data: { captionTiming: timing },
  });

  trackServerEvent({
    name: "caption_timing_saved",
    distinctId: teacher.id,
    properties: { teacherId: teacher.id, pauseMs: timing.pauseMs, maxChars: timing.maxChars },
  });
  await flushAnalytics();

  revalidateAfterAction("/settings/captions");
  return { ok: true };
}
