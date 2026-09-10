"use server";

import { z } from "zod";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { absent } from "@/lib/form-data";
import { expiryInstant } from "@/lib/discounts/status";
import {
  createDiscountCode as createDiscountCodeCore,
  deleteDiscountCode as deleteDiscountCodeCore,
  setDiscountCodeActive as setDiscountCodeActiveCore,
} from "@/lib/discounts/manage";
import { revalidateAfterAction } from "@/lib/revalidate";

// Teacher CRUD for the discount-code primitive (slice 2a). Codes are
// teacher-funded promos. The business rules (create / activate / delete, and
// the deactivate-not-delete rule for used codes) live in @/lib/discounts/manage
// so the mobile REST route drives the same logic; this action owns FormData
// parsing + localized messages.
//
// MESSAGES COME FROM THE CATALOG, not from an `en ? … : …` ternary. Every
// string here used to be a two-armed conditional on `locale === "en"`, which
// silently made French the third locale that got Spanish: a French teacher
// mistyping a code was told "Solo letras, números y guiones." The catalog is
// the only place that knows how many languages there are.

/** Which field an error belongs to, so the form can point at it. */
export type DiscountField = "code" | "value" | "perStudentLimit" | "maxRedemptions" | "expiresAt";

export type DiscountActionState =
  { error?: string; field?: DiscountField; ok?: boolean; code?: string } | undefined;

const idField = z.string().uuid();

// zod paths → the input the teacher is looking at. `percent` and `amountPesos`
// are one control on screen (the type toggle swaps which is rendered), so both
// resolve to the same field.
const FIELD_FOR_PATH: Record<string, DiscountField> = {
  code: "code",
  percent: "value",
  amountPesos: "value",
  perStudentLimit: "perStudentLimit",
  maxRedemptions: "maxRedemptions",
  expiresAt: "expiresAt",
};

const createSchema = (t: TFunction, now: Date) =>
  z
    .object({
      code: z
        .string()
        .trim()
        .min(3, t("web.dashboard.discounts.errors.codeTooShort"))
        .max(40, t("web.dashboard.discounts.errors.codeCharset"))
        .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, t("web.dashboard.discounts.errors.codeCharset")),
      kind: z.enum(["percent", "fixed"]),
      // Percent path: 1–100 (stored as basis points).
      percent: z.coerce
        .number({ message: t("web.dashboard.discounts.errors.percentRange") })
        .int(t("web.dashboard.discounts.errors.percentRange"))
        .min(1, t("web.dashboard.discounts.errors.percentRange"))
        .max(100, t("web.dashboard.discounts.errors.percentRange"))
        .optional(),
      // Fixed path: major units the teacher types, stored as minor units.
      amountPesos: z.coerce
        .number({ message: t("web.dashboard.discounts.errors.amountRange") })
        .positive(t("web.dashboard.discounts.errors.amountRange"))
        .optional(),
      maxRedemptions: z
        .union([z.coerce.number().int().positive(), z.literal("").transform(() => undefined)])
        .optional(),
      perStudentLimit: z.coerce.number().int().positive().max(1000).default(1),
      // YYYY-MM-DD or empty. A date already past would create a code that is
      // dead the moment it exists — the checkout would refuse it and the
      // dashboard would (correctly, and uselessly) show it as expired. Compared
      // against the instant it would actually be stored with, rather than
      // against a calendar day, because "expired" is a timestamp comparison in
      // resolveAndValidateDiscount and the two must not disagree at the edges.
      expiresAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, t("web.dashboard.discounts.errors.expiryPast"))
        .refine((ymd) => expiryInstant(ymd) > now, t("web.dashboard.discounts.errors.expiryPast"))
        .optional()
        .or(z.literal("").transform(() => undefined)),
    })
    .refine((v) => (v.kind === "percent" ? v.percent != null : v.amountPesos != null), {
      message: t("web.dashboard.discounts.errors.valueRequired"),
      path: ["percent"],
    });

export async function createDiscountCode(
  _prev: DiscountActionState,
  formData: FormData,
): Promise<DiscountActionState> {
  const t = await getT();
  // The form renders the percent input OR the pesos input, never both, so the
  // other name is absent from the submission. absent() keeps that from reaching
  // z.coerce.number() as a 0 — see @/lib/form-data.
  const parsed = createSchema(t, new Date()).safeParse({
    code: formData.get("code"),
    kind: formData.get("kind"),
    percent: absent(formData.get("percent")),
    amountPesos: absent(formData.get("amountPesos")),
    maxRedemptions: absent(formData.get("maxRedemptions")),
    perStudentLimit: absent(formData.get("perStudentLimit")),
    expiresAt: absent(formData.get("expiresAt")),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: issue?.message ?? t("web.dashboard.discounts.errors.invalid"),
      field: FIELD_FOR_PATH[String(issue?.path[0] ?? "")],
    };
  }
  const input = parsed.data;
  const teacher = await requireOnboardedTeacher();

  const result = await createDiscountCodeCore(teacher.id, {
    code: input.code,
    kind: input.kind,
    percent: input.percent,
    amountPesos: input.amountPesos,
    maxRedemptions: input.maxRedemptions ?? null,
    perStudentLimit: input.perStudentLimit,
    expiresAt: input.expiresAt ?? null,
  });
  if (!result.ok) {
    return { error: t("web.dashboard.discounts.errors.duplicate"), field: "code" };
  }

  revalidateAfterAction("/dashboard/discounts");
  // The normalized form, because that is the code students will type and the
  // one the new row shows — echoing back her lower-case draft would make the
  // confirmation disagree with the list it just appeared in.
  return { ok: true, code: input.code.toUpperCase() };
}

export async function setDiscountCodeActive(
  _prev: DiscountActionState,
  formData: FormData,
): Promise<DiscountActionState> {
  const t = await getT();
  const parsed = z
    .object({ id: idField, active: z.coerce.boolean() })
    .safeParse({ id: formData.get("id"), active: formData.get("active") });
  if (!parsed.success) return { error: t("web.dashboard.discounts.errors.invalid") };

  const teacher = await requireOnboardedTeacher();
  const { ok } = await setDiscountCodeActiveCore(teacher.id, parsed.data.id, parsed.data.active);
  if (!ok) {
    return { error: t("web.dashboard.discounts.errors.notFound") };
  }
  revalidateAfterAction("/dashboard/discounts");
  return { ok: true };
}

export async function deleteDiscountCode(
  _prev: DiscountActionState,
  formData: FormData,
): Promise<DiscountActionState> {
  const t = await getT();
  const parsed = z.object({ id: idField }).safeParse({ id: formData.get("id") });
  if (!parsed.success) return { error: t("web.dashboard.discounts.errors.invalid") };

  const teacher = await requireOnboardedTeacher();
  const result = await deleteDiscountCodeCore(teacher.id, parsed.data.id);
  if (!result.ok) {
    return {
      error:
        result.reason === "has-redemptions"
          ? t("web.dashboard.discounts.errors.hasRedemptions")
          : t("web.dashboard.discounts.errors.notFound"),
    };
  }
  revalidateAfterAction("/dashboard/discounts");
  return { ok: true };
}
