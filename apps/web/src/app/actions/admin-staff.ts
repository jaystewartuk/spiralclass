"use server";

import { issueMessage } from "@spiralclass/shared";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isBootstrapActor, requireAdmin } from "@/lib/admin";
import { getPreferredLocale } from "@/lib/i18n";
import { revalidateAfterAction } from "@/lib/revalidate";
import { createT } from "@spiralclass/shared";

export type AdminStaffActionState = { error?: string; ok?: boolean } | undefined;

// True if `adminId` is the platform's LAST active superadmin — demoting or
// disabling them would lock everyone out of superadmin-only surfaces (staff
// management) with no way back except the env bootstrap.
// Counts OTHER active superadmins.
async function isLastActiveSuperadmin(adminId: string): Promise<boolean> {
  const others = await prisma.adminUser.count({
    where: { role: "superadmin", disabledAt: null, id: { not: adminId } },
  });
  return others === 0;
}

const inviteSchema = z.object({
  email: z.string().trim().email("email.invalid").toLowerCase(),
  role: z.enum(["superadmin", "finance", "support", "tester", "engineer"]),
});

export async function inviteAdminAction(
  _prev: AdminStaffActionState,
  formData: FormData,
): Promise<AdminStaffActionState> {
  const actor = await requireAdmin("superadmin");
  const locale = await getPreferredLocale();
  const t = createT(locale);
  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return {
      error: issueMessage(parsed.error, t, "web.action.invalidData"),
    };
  }

  try {
    await prisma.adminUser.create({
      data: {
        email: parsed.data.email,
        role: parsed.data.role,
        createdById: isBootstrapActor(actor) ? null : actor.id,
      },
    });
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "P2002") {
      return { error: t("web.action.admin.staff.emailExists") };
    }
    throw err;
  }

  revalidateAfterAction("/admin/staff");
  return { ok: true };
}

const updateSchema = z.object({
  adminId: z.string().uuid("web.action.invalidId"),
  role: z.enum(["superadmin", "finance", "support", "tester", "engineer"]),
});

export async function updateAdminRoleAction(
  _prev: AdminStaffActionState,
  formData: FormData,
): Promise<AdminStaffActionState> {
  const actor = await requireAdmin("superadmin");
  const locale = await getPreferredLocale();
  const t = createT(locale);
  const parsed = updateSchema.safeParse({
    adminId: formData.get("adminId"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return {
      error: issueMessage(parsed.error, t, "web.action.invalidData"),
    };
  }

  if (
    !isBootstrapActor(actor) &&
    parsed.data.adminId === actor.id &&
    parsed.data.role !== "superadmin"
  ) {
    return {
      error: t("web.action.admin.staff.cantDemoteSelf"),
    };
  }

  const target = await prisma.adminUser.findUnique({
    where: { id: parsed.data.adminId },
    select: { role: true, disabledAt: true },
  });
  if (!target) {
    return { error: t("web.action.admin.staff.notFound") };
  }
  if (
    target.role === "superadmin" &&
    parsed.data.role !== "superadmin" &&
    !target.disabledAt &&
    (await isLastActiveSuperadmin(parsed.data.adminId))
  ) {
    return {
      error: t("web.action.admin.staff.lastSuperadminRemove"),
    };
  }

  await prisma.adminUser.update({
    where: { id: parsed.data.adminId },
    data: { role: parsed.data.role },
  });
  revalidateAfterAction("/admin/staff");
  return { ok: true };
}

const toggleSchema = z.object({
  adminId: z.string().uuid("web.action.invalidId"),
  disable: z.enum(["true", "false"]),
});

export async function toggleAdminDisabledAction(
  _prev: AdminStaffActionState,
  formData: FormData,
): Promise<AdminStaffActionState> {
  const actor = await requireAdmin("superadmin");
  const locale = await getPreferredLocale();
  const t = createT(locale);
  const parsed = toggleSchema.safeParse({
    adminId: formData.get("adminId"),
    disable: formData.get("disable"),
  });
  if (!parsed.success) {
    return {
      error: issueMessage(parsed.error, t, "web.action.invalidData"),
    };
  }

  if (
    !isBootstrapActor(actor) &&
    parsed.data.adminId === actor.id &&
    parsed.data.disable === "true"
  ) {
    return {
      error: t("web.action.admin.staff.cantDisableSelf"),
    };
  }

  if (parsed.data.disable === "true") {
    const target = await prisma.adminUser.findUnique({
      where: { id: parsed.data.adminId },
      select: { role: true, disabledAt: true },
    });
    if (!target) {
      return { error: t("web.action.admin.staff.notFound") };
    }
    if (
      target.role === "superadmin" &&
      !target.disabledAt &&
      (await isLastActiveSuperadmin(parsed.data.adminId))
    ) {
      return {
        error: t("web.action.admin.staff.lastSuperadminDisable"),
      };
    }
  }

  await prisma.adminUser.update({
    where: { id: parsed.data.adminId },
    data: { disabledAt: parsed.data.disable === "true" ? new Date() : null },
  });
  revalidateAfterAction("/admin/staff");
  return { ok: true };
}
