import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { trackServerEvent } from "@/lib/analytics/posthog";

// Student engagement tracking for the organized materials library
// (/my-classes/materials) — the material_opened / material_completed PostHog
// events, fired from the small purpose-built API routes under
// api/materials/[id]/**. One lookup + property-shaping lives here rather than
// in the route, so the Prisma query and materialType derivation stay testable
// apart from the handler.

export type MaterialEngagementEvent = "opened" | "completed";

type Deps = { db: PrismaClient };

export async function trackMaterialEngagement(
  studentId: string,
  materialId: string,
  event: MaterialEngagementEvent,
  surface: "web" | "mobile",
  durationSeconds: number | undefined,
  deps?: Partial<Deps>,
): Promise<boolean> {
  const db = deps?.db ?? prisma;
  const material = await db.libraryMaterial.findUnique({
    where: { id: materialId },
    select: {
      id: true,
      label: true,
      teacherId: true,
      body: true,
      storagePath: true,
      podcast: { select: { status: true } },
    },
  });
  if (!material) return false;

  const materialType: "content" | "audio" | "file" | "link" =
    material.podcast?.status === "ready"
      ? "audio"
      : material.body != null
        ? "content"
        : material.storagePath
          ? "file"
          : "link";

  const base = {
    materialId: material.id,
    materialTitle: material.label ?? "Untitled material",
    materialType,
    teacherId: material.teacherId,
    surface,
  };

  if (event === "opened") {
    trackServerEvent({ name: "material_opened", distinctId: studentId, properties: base });
  } else {
    trackServerEvent({
      name: "material_completed",
      distinctId: studentId,
      properties: { ...base, ...(durationSeconds != null ? { durationSeconds } : {}) },
    });
  }
  return true;
}
