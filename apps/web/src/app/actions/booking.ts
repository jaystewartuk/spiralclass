"use server";

import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { bookingRequestSchema } from "@/lib/validators";
import { getPreferredLocale } from "@/lib/i18n";
import { inngest } from "@/lib/inngest/client";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { studentIdentityIds } from "@/lib/students/identity";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { maybeEmitFirstBooking } from "@/lib/analytics/first-events";
import { bookPackageSlot, type BookingEventEmitter } from "@/lib/booking/book-package-slot";
import { revalidateAfterAction } from "@/lib/revalidate";
import { usesEnglishCopy } from "@spiralclass/shared";

export type ActionState = { error?: string; ok?: string } | undefined;

// Bridge the booking core's typed events onto the existing Inngest plumbing.
const emitViaInngest: BookingEventEmitter = async (event) => {
  if (event.name === "notification.queued") {
    await emitNotificationQueued(event.data);
  } else {
    await inngest.send({ name: event.name, data: event.data });
  }
};

// Server-side re-validation of the chosen slot (: server is source of
// truth for timing). Inserts booking with status='scheduled'; on unique-index
// violation (another student took the slot between render and submit) returns
// a friendly error.
export async function createBooking(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const locale = await getPreferredLocale();
  const en = usesEnglishCopy(locale);
  const parsed = bookingRequestSchema.safeParse({
    packageId: formData.get("packageId"),
    startUtc: formData.get("startUtc"),
  });
  if (!parsed.success) {
    return { error: en ? "Invalid selection." : "Selección inválida." };
  }

  const user = await getAuthUser();
  if (!user) redirect("/");

  const student = await prisma.student.findFirst({
    where: { authUserId: user.id },
    select: { id: true, name: true, email: true, disabledAt: true },
  });
  if (!student) return { error: en ? "Account not found." : "Cuenta no encontrada." };
  if (student.disabledAt) {
    return { error: en ? "This account is disabled." : "Esta cuenta está deshabilitada." };
  }

  // The package may live on a sibling row (same inbox, another teacher's
  // roster — see studentIdentityIds). The submitted packageId only names the
  // credit pool (teacher + class length); the booking core spends the
  // soonest-to-expire credit in it and binds the booking to that package.
  const identityIds = await studentIdentityIds(student);
  const pkg = await prisma.package.findFirst({
    where: {
      id: parsed.data.packageId,
      studentId: { in: identityIds },
      status: "active",
    },
    include: { teacher: true, template: true },
  });
  if (!pkg) return { error: en ? "Package unavailable." : "Paquete no disponible." };

  // Delegate slot generation re-validation, the Model-B capacity claim and the event
  // fan-out to the shared booking core (also used by the teacher self-serve
  // flow). The student is bound by every rule, including minAdvanceH.
  const outcome = await bookPackageSlot(
    { prisma, emit: emitViaInngest },
    {
      pkg,
      studentIds: identityIds,
      teacher: pkg.teacher,
      startUtc: new Date(parsed.data.startUtc),
      notifyTeacher: true,
    },
  );

  if (outcome.code !== "ok") {
    switch (outcome.code) {
      case "package-exhausted":
        return {
          error: en
            ? "You've used all the classes in this package."
            : "Ya usaste todas las clases de este paquete.",
        };
      case "package-expired":
        return { error: en ? "This package has expired." : "Este paquete ya expiró." };
      case "slot-taken":
        return {
          error: en
            ? "That slot was just booked by someone else."
            : "Ese horario ya fue reservado por alguien más.",
        };
      default:
        return {
          error: en ? "That slot is no longer available." : "Ese horario ya no está disponible.",
        };
    }
  }

  trackServerEvent({
    name: "booking_created",
    distinctId: student.id,
    properties: {
      teacherId: pkg.teacherId,
      bookingId: outcome.bookingId,
      packageId: pkg.id,
      via: "via_link",
      teacherName: pkg.teacher.name,
      className: pkg.template?.name ?? null,
      classType: pkg.template?.singleClass ? "single_class" : "package",
      classId: pkg.templateId,
      scheduledAt: parsed.data.startUtc,
    },
  });
  await maybeEmitFirstBooking(pkg.teacherId, outcome.bookingId);
  // Drain before the redirect — posthog-node flushes in the background and the
  // serverless function can freeze the moment this action returns/redirects.
  await flushAnalytics();

  revalidateAfterAction("/my-classes");
  redirect(`/my-classes/book/confirmation?bookingId=${outcome.bookingId}`);
}
