import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { flushAnalytics, trackServerEvent } from "@/lib/analytics/posthog";

// The lead lifecycle, owned here so every caller applies identical rules.
// `new` is the capture state and has no
// transition event; the other three map 1:1 to typed analytics names.
export const LEAD_STATUSES = ["new", "contacted", "converted", "archived"] as const;
export const leadStatusSchema = z.enum(LEAD_STATUSES);
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Move a lead through its lifecycle, scoped to the owning teacher so a teacher
 * can only touch her own leads. Returns false when no matching row exists (not
 * found / not hers); fires the status-transition analytics event on success. */
export async function applyLeadStatus(
  teacherId: string,
  leadId: string,
  status: LeadStatus,
): Promise<boolean> {
  const updated = await prisma.lead.updateMany({
    where: { id: leadId, teacherId },
    data: { status },
  });
  if (updated.count === 0) return false;

  if (status !== "new") {
    const name =
      status === "contacted"
        ? "lead_contacted"
        : status === "converted"
          ? "lead_converted"
          : "lead_archived";
    trackServerEvent({
      name,
      distinctId: teacherId,
      properties: { teacherId, leadId },
    });
    await flushAnalytics();
  }
  return true;
}
