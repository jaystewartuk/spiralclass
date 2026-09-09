"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { isBootstrapActor, requireAdmin } from "@/lib/admin";
import { getPreferredLocale } from "@/lib/i18n";

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
  email: z.string().trim().email("Email inválido").toLowerCase(),
  role: z.enum(["superadmin", "finance", "support", "tester", "engineer"]),
});

export async function inviteAdminAction(
  _prev: AdminStaffActionState,
  formData: FormData,
): Promise<AdminStaffActionState> {
  const actor = await requireAdmin("superadmin");
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos"),
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
      return { error: en ? "That email already exists" : "Ese email ya existe" };
    }
    throw err;
  }

  revalidatePath("/admin/staff");
  return { ok: true };
}

const updateSchema = z.object({
  adminId: z.string().uuid("ID inválido"),
  role: z.enum(["superadmin", "finance", "support", "tester", "engineer"]),
});

export async function updateAdminRoleAction(
  _prev: AdminStaffActionState,
  formData: FormData,
): Promise<AdminStaffActionState> {
  const actor = await requireAdmin("superadmin");
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = updateSchema.safeParse({
    adminId: formData.get("adminId"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos"),
    };
  }

  if (
    !isBootstrapActor(actor) &&
    parsed.data.adminId === actor.id &&
    parsed.data.role !== "superadmin"
  ) {
    return {
      error: en ? "You can't demote your own account" : "No puedes degradar tu propia cuenta",
    };
  }

  const target = await prisma.adminUser.findUnique({
    where: { id: parsed.data.adminId },
    select: { role: true, disabledAt: true },
  });
  if (!target) {
    return { error: en ? "Admin not found" : "Administrador no encontrado" };
  }
  if (
    target.role === "superadmin" &&
    parsed.data.role !== "superadmin" &&
    !target.disabledAt &&
    (await isLastActiveSuperadmin(parsed.data.adminId))
  ) {
    return {
      error: en
        ? "You can't remove the last active superadmin."
        : "No puedes quitar al último superadministrador activo.",
    };
  }

  await prisma.adminUser.update({
    where: { id: parsed.data.adminId },
    data: { role: parsed.data.role },
  });
  revalidatePath("/admin/staff");
  return { ok: true };
}

const toggleSchema = z.object({
  adminId: z.string().uuid("ID inválido"),
  disable: z.enum(["true", "false"]),
});

export async function toggleAdminDisabledAction(
  _prev: AdminStaffActionState,
  formData: FormData,
): Promise<AdminStaffActionState> {
  const actor = await requireAdmin("superadmin");
  const locale = await getPreferredLocale();
  const en = locale === "en";
  const parsed = toggleSchema.safeParse({
    adminId: formData.get("adminId"),
    disable: formData.get("disable"),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? (en ? "Invalid data" : "Datos inválidos"),
    };
  }

  if (
    !isBootstrapActor(actor) &&
    parsed.data.adminId === actor.id &&
    parsed.data.disable === "true"
  ) {
    return {
      error: en ? "You can't disable your own account" : "No puedes deshabilitar tu propia cuenta",
    };
  }

  if (parsed.data.disable === "true") {
    const target = await prisma.adminUser.findUnique({
      where: { id: parsed.data.adminId },
      select: { role: true, disabledAt: true },
    });
    if (!target) {
      return { error: en ? "Admin not found" : "Administrador no encontrado" };
    }
    if (
      target.role === "superadmin" &&
      !target.disabledAt &&
      (await isLastActiveSuperadmin(parsed.data.adminId))
    ) {
      return {
        error: en
          ? "You can't disable the last active superadmin."
          : "No puedes deshabilitar al último superadministrador activo.",
      };
    }
  }

  await prisma.adminUser.update({
    where: { id: parsed.data.adminId },
    data: { disabledAt: parsed.data.disable === "true" ? new Date() : null },
  });
  revalidatePath("/admin/staff");
  return { ok: true };
}
