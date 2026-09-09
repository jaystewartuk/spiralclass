"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireOnboardedTeacher } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import type { TFunction } from "@/lib/i18n-translate";
import { absent } from "@/lib/form-data";
import { saveReferralProgram as saveReferralProgramCore } from "@/lib/referrals/manage";

// Teacher config for the student→student referral program (slice 2b,
// docs/features/referrals-discounts.md). One row per teacher (upsert). Both rewards
// are stored in the same percent/fixed shape as a discount code; the friend's
// discount applies at checkout, the referrer's reward is minted on settle.

/**
 * `fields` carries a message per input rather than one banner for the whole
 * form. The form has three independently-fillable values and the old single
 * "Enter both reward values." could not say which of them was wrong — on a
 * screen where two of the three look identical, that is the difference between
 * a fix and a guess.
 */
export type ReferralProgramState =
  | {
      error?: string;
      ok?: boolean;
      fields?: { referred?: string; referrer?: string; expiry?: string };
    }
  | undefined;

// A reward side: percent (1–100) or fixed (a positive amount in her own
// pricing currency's major units).
const rewardSchema = z
  .object({
    kind: z.enum(["percent", "fixed"]),
    percent: z.coerce.number().int().min(1).max(100).optional(),
    amountPesos: z.coerce.number().positive().optional(),
  })
  .refine((v) => (v.kind === "percent" ? v.percent != null : v.amountPesos != null));

// Blank clears the expiry (the reward never expires); anything else must be a
// whole number of days inside a decade.
const expirySchema = z.union([
  z.literal("").transform(() => null),
  z.coerce.number().int().positive().max(3650),
]);

// RewardFields renders EITHER the percent input OR the amount input for a side,
// never both, so the other name is absent from the submission. absent() keeps
// that from reaching z.coerce.number() as a 0 — see @/lib/form-data.
export async function saveReferralProgram(
  _prev: ReferralProgramState,
  formData: FormData,
): Promise<ReferralProgramState> {
  const t = await getT();

  const referred = rewardSchema.safeParse({
    kind: formData.get("referredKind"),
    percent: absent(formData.get("referredPercent")),
    amountPesos: absent(formData.get("referredAmountPesos")),
  });
  const referrer = rewardSchema.safeParse({
    kind: formData.get("referrerKind"),
    percent: absent(formData.get("referrerPercent")),
    amountPesos: absent(formData.get("referrerAmountPesos")),
  });
  // An out-of-range expiry used to fall through to null — the form said
  // "saved" and silently switched the reward to never expiring, which is the
  // opposite of what was typed. It is an error now.
  const expiry = expirySchema.safeParse(formData.get("rewardExpiryDays") ?? "");

  if (!referred.success || !referrer.success || !expiry.success) {
    return {
      error: t("web.dashboard.referrals.error.summary"),
      fields: {
        referred: referred.success ? undefined : rewardMessage(formData.get("referredKind"), t),
        referrer: referrer.success ? undefined : rewardMessage(formData.get("referrerKind"), t),
        expiry: expiry.success ? undefined : t("web.dashboard.referrals.error.expiryRange"),
      },
    };
  }

  const enabled = z.coerce.boolean().parse(formData.get("enabled") ?? false);
  const teacher = await requireOnboardedTeacher();

  await saveReferralProgramCore(teacher.id, {
    enabled,
    referred: referred.data,
    referrer: referrer.data,
    rewardExpiryDays: expiry.data,
  });

  revalidatePath("/dashboard/referrals");
  return { ok: true };
}

// The two failures a reward side can have are "you left it blank" and "that
// number is out of range", and only the field's own kind says which range.
function rewardMessage(kind: FormDataEntryValue | null, t: TFunction) {
  return kind === "percent"
    ? t("web.dashboard.referrals.error.percentRange")
    : t("web.dashboard.referrals.error.amountRange");
}
