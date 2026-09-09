"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getPreferredLocale } from "@/lib/i18n";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";
import { materialSendTimeElapsed } from "@/lib/materials/timing";
import { enqueueMaterialsSend } from "@/lib/notifications/enqueue";
import { emitNotificationQueued } from "@/lib/notifications/events";
import { gateProFeature, upgradeNudge } from "@/lib/subscriptions/enforce";
import { revalidateClassMaterialLists } from "@/lib/materials/revalidate";
import { logger } from "@/lib/logger";

const log = logger({ surface: "booking-library-materials" });

// Gap G3 (docs/features/library-materials.md) — attach an item the teacher
// already has in her reusable library onto one reserved class, instead of
// only ever uploading something fresh (app/actions/materials.ts). Reuses the
// same send-timing vocabulary and immediate-send-if-elapsed behavior as a
// fresh upload; a native-content item (no storagePath/linkUrl) is attached
// for on-page visibility only — there's nothing to push over WhatsApp/email.

const sendTimingSchema = z.enum(["confirmation", "t_5d", "t_24h", "t_1h"]);

export type AttachLibraryMaterialState = { error?: string; ok?: boolean } | undefined;

export async function attachLibraryMaterialToBookingAction(
  _prev: AttachLibraryMaterialState,
  formData: FormData,
): Promise<AttachLibraryMaterialState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();
  const en = locale === "en";

  // Same Pro gate as a fresh per-class upload (app/actions/materials.ts) —
  // attaching rides the identical delivery pipeline.
  const gate = await gateProFeature(teacher.id, "materials");
  if (!gate.ok) return { error: upgradeNudge(gate.limit, locale) };

  const bookingId = String(formData.get("bookingId") ?? "");
  // Multi-select: the panel submits one `libraryMaterialId` per checked item.
  // getAll also covers the single-select callers (one value) unchanged.
  const libraryMaterialIds = [
    ...new Set(formData.getAll("libraryMaterialId").map(String).filter(Boolean)),
  ];
  const sendTiming = sendTimingSchema.safeParse(formData.get("sendTiming") ?? "");
  if (!bookingId || libraryMaterialIds.length === 0) {
    return { error: en ? "Choose a material first." : "Primero elige un material." };
  }
  if (!sendTiming.success) {
    return {
      error: en ? "Choose when to send the material." : "Selecciona cuándo enviar el material.",
    };
  }

  //: tenant-scope both sides — a booking and library items that all
  // belong to this teacher.
  const [booking, materials] = await Promise.all([
    prisma.booking.findFirst({
      where: { id: bookingId, teacherId: teacher.id },
      select: { id: true, studentId: true, scheduledStart: true, status: true },
    }),
    prisma.libraryMaterial.findMany({
      where: { id: { in: libraryMaterialIds }, teacherId: teacher.id, archived: false },
      select: { id: true, storagePath: true, linkUrl: true },
    }),
  ]);
  if (!booking) return { error: en ? "Class not found." : "Clase no encontrada." };
  if (materials.length === 0) {
    return {
      error: en
        ? "Those materials are no longer available."
        : "Esos materiales ya no están disponibles.",
    };
  }

  const now = new Date();
  for (const material of materials) {
    await prisma.bookingLibraryMaterial.upsert({
      where: {
        bookingId_libraryMaterialId: { bookingId: booking.id, libraryMaterialId: material.id },
      },
      create: {
        bookingId: booking.id,
        libraryMaterialId: material.id,
        sendTiming: sendTiming.data,
      },
      update: { sendTiming: sendTiming.data },
    });

    trackServerEvent({
      name: "library_item_attached_to_class",
      distinctId: teacher.id,
      properties: {
        teacherId: teacher.id,
        bookingId: booking.id,
        libraryMaterialId: material.id,
        sendTiming: sendTiming.data,
      },
    });

    // Same immediate-send-if-elapsed rule as a fresh upload (materials.ts) —
    // only meaningful for a file/link item; a native-content item has nothing
    // to push over WhatsApp/email and is visible on-page instead.
    if (
      booking.status === "scheduled" &&
      (material.storagePath || material.linkUrl) &&
      materialSendTimeElapsed(sendTiming.data, booking.scheduledStart, now)
    ) {
      const id = await enqueueMaterialsSend(prisma, {
        teacherId: teacher.id,
        studentId: booking.studentId,
        bookingId: booking.id,
        storagePath: material.storagePath,
        materialsUrl: material.linkUrl,
      });
      try {
        await emitNotificationQueued({ notificationId: id, teacherId: teacher.id });
      } catch (err) {
        log.warn("emit failed", { error: err });
      }
    }
  }
  await flushAnalytics();

  revalidatePath(`/dashboard/classes/${booking.id}`);
  // The class-list "Has Materials" chip must reflect this new attachment too.
  revalidateClassMaterialLists();
  return { ok: true };
}

// Single-arg variant for a plain `<form action={...}>` not wrapped in
// useActionState (the "at their level" shelf's one-click attach button) —
// same logic as attachLibraryMaterialToBookingAction, errors just don't
// surface inline since there's no state to render them into.
export async function attachLibraryMaterialToBookingQuickAction(formData: FormData): Promise<void> {
  await attachLibraryMaterialToBookingAction(undefined, formData);
}

export async function detachLibraryMaterialFromBookingAction(formData: FormData): Promise<void> {
  const teacher = await requireOnboardedTeacher();
  const bookingId = String(formData.get("bookingId") ?? "");
  const libraryMaterialId = String(formData.get("libraryMaterialId") ?? "");
  if (!bookingId || !libraryMaterialId) return;

  // Scope through the booking's teacherId; deleteMany is a no-op otherwise.
  await prisma.bookingLibraryMaterial.deleteMany({
    where: { bookingId, libraryMaterialId, booking: { teacherId: teacher.id } },
  });
  revalidatePath(`/dashboard/classes/${bookingId}`);
  // Detaching the last library material may flip the class-list chip off.
  revalidateClassMaterialLists();
}
