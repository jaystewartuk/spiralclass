"use server";

import { fromZonedTime } from "date-fns-tz";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { blockedDateSchema } from "@/lib/validators";
import { getPreferredLocale, getT } from "@/lib/i18n";
import { toYMD } from "@/lib/tz";
import { isFullyCovered, rangeLength } from "@/lib/blocked-dates/ranges";
import { inngest } from "@/lib/inngest/client";
import { emitNotificationQueued } from "@/lib/notifications/events";
import type { CancelEventEmitter } from "@/lib/cancellation/cancel-handler";
import { notifyBookingsInBlockedRange } from "@/lib/cancellation/blocked-date-collision";
import { revalidateAfterAction } from "@/lib/revalidate";

export type BlockedDateState = { error?: string; ok?: string } | undefined;

const emitViaInngest: CancelEventEmitter = async (event) => {
  if (event.name === "notification.queued") {
    await emitNotificationQueued(event.data);
  } else {
    await inngest.send({ name: event.name, data: event.data });
  }
};

//: blocked dates remove all future slots and trigger a reschedule
// prompt for any bookings already on those dates. Slot generation already
// filters them out (`src/lib/slots.ts`); this action also flips any
// scheduled booking inside the new range to `canceled_by_teacher` via the
// shared teacher-cancel path. That path restores the class to the
// package, logs an override, and queues the `teacher_cancel` notification
// (which the dispatcher renders as a reschedule prompt).
//
// Date strings come in as YYYY-MM-DD from the teacher's local view; we
// expand them to a full local-day range in the teacher's IANA tz so the
// block fully covers the day regardless of the student's tz.
//
// Every message this returns comes from the shared catalog. They were inline
// `en ? … : …` ternaries, which meant a French teacher was told what she had
// just done in Spanish, and "We canceled 1 classes" whenever the count was
// one — the catalog's `_one` variants are what fix the second half.
export async function createBlockedDateAction(
  _prev: BlockedDateState,
  formData: FormData,
): Promise<BlockedDateState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const t = await getT();
  const parsed = blockedDateSchema(locale).safeParse({
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? t("web.settings.blockedDates.invalid"),
    };
  }

  const startsAt = fromZonedTime(`${parsed.data.startDate}T00:00:00`, teacher.timezone);
  const endsAt = fromZonedTime(`${parsed.data.endDate}T23:59:59.999`, teacher.timezone);

  // Refuse a block that adds nothing. Re-blocking a day already covered — by
  // one existing block or by two that meet across it — used to insert a
  // duplicate row, so the list grew entries that could not be told apart and
  // removing one of them appeared to do nothing. Checked against days in the
  // teacher's own zone, which is the unit a block is actually written in.
  const overlapping = await prisma.blockedDate.findMany({
    where: { teacherId: teacher.id, startsAt: { lte: endsAt }, endsAt: { gte: startsAt } },
    select: { startsAt: true, endsAt: true },
  });
  const existing = overlapping.map((b) => ({
    start: toYMD(b.startsAt, teacher.timezone),
    end: toYMD(b.endsAt, teacher.timezone),
  }));
  if (isFullyCovered(existing, { start: parsed.data.startDate, end: parsed.data.endDate })) {
    return { error: t("web.settings.blockedDates.alreadyBlocked") };
  }

  await prisma.blockedDate.create({
    data: {
      teacherId: teacher.id,
      startsAt,
      endsAt,
      reason: parsed.data.reason ?? null,
    },
  });

  const { canceled } = await notifyBookingsInBlockedRange(
    { prisma, emit: emitViaInngest },
    {
      teacherId: teacher.id,
      startsAt,
      endsAt,
      reason: parsed.data.reason ?? null,
    },
  );

  revalidateAfterAction("/settings/blocked-dates");
  if (canceled > 0) {
    return { ok: t("web.settings.blockedDates.savedCanceled", { count: canceled }) };
  }
  // A plain success used to return `undefined`, which the form could not tell
  // apart from "no action has run yet" — so the only way to know the block had
  // landed was to notice the list had grown.
  return {
    ok: t("web.settings.blockedDates.savedDays", {
      count: rangeLength({ start: parsed.data.startDate, end: parsed.data.endDate }),
    }),
  };
}

export async function deleteBlockedDateAction(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) return;
  // Filter by teacherId so RLS-defeating service-role can't be tricked into
  // deleting another teacher's row through this action either.
  await prisma.blockedDate.deleteMany({ where: { id, teacherId: teacher.id } });
  revalidateAfterAction("/settings/blocked-dates");
}
