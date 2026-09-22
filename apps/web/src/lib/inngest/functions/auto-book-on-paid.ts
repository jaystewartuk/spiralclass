import { inngest } from "../client";
import { prisma } from "@/lib/prisma";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { autoBookIntendedSlot } from "@/lib/booking/auto-book-intended";
import type { BookingEventEmitter } from "@/lib/booking/book-package-slot";

// Pay-at-reservation: once a single-class payment lands (same `payment.paid`
// event the transfer + magic-link handlers key off), turn the slot the student
// picked at checkout into a real booking. Idempotent — a re-delivered event
// finds the credit already spent and no-ops — and never fails on a taken slot:
// the credit just stays bookable (see autoBookIntendedSlot). Retries cover only
// genuine infra errors.

// Bridge the booking core's typed events onto Inngest, mirroring the student
// book route.
const emitViaInngest: BookingEventEmitter = async (event) => {
  if (event.name === "notification.queued") {
    await emitNotificationQueued(event.data);
  } else {
    await inngest.send({ name: event.name, data: event.data });
  }
};

export const autoBookOnPaidFn = inngest.createFunction(
  {
    id: "auto-book-on-paid",
    retries: 3,
    triggers: [{ event: "payment.paid" }],
  },
  async ({ event, step }) => {
    const { packageId } = event.data as { packageId: string };
    return await step.run("auto-book-intended-slot", () =>
      autoBookIntendedSlot({ prisma, emit: emitViaInngest }, packageId),
    );
  },
);
