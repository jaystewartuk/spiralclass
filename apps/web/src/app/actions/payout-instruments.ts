"use server";

import { redirect } from "next/navigation";
import { wiseInstrumentSchema, usesEnglishCopy } from "@spiralclass/shared";
import { requireOnboardedTeacher } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPreferredLocale } from "@/lib/i18n";
import { saveTeacherInstrument } from "@/lib/payments/save-instrument";
import { revalidateAfterAction } from "@/lib/revalidate";

export type PayoutInstrumentState = { error?: string; ok?: string } | undefined;

// Persist one payout instrument configured in /settings/payments (D-113).
//
// One action per kind. D-145 left one kind, so there is one action — but it
// stays shaped per kind rather than collapsing into a polymorphic one, because
// a single action would have to re-discriminate on a form field the client
// controls. It goes through `saveTeacherInstrument`, so the analytics gate and
// the marketplace-ready recheck live in one place.
//
// Validation happens in the shared Zod schema first, so the DB CHECK
// constraints are a redundancy net rather than the primary error surface. That
// split mattered most for the per-field checksums D-145 removed with the
// `bank_account` kind (a CLABE control digit, an IBAN mod-97, a Nigerian NUBAN
// spanning two fields) — a Wisetag is one regex. The rule it encoded still
// stands for any kind added later: a payee value a student pays against is
// validated in shared code every caller runs, never only in Postgres, because
// a constraint Postgres alone knows is one a client can be looser than.

export async function updateWiseInstrument(
  _prev: PayoutInstrumentState,
  formData: FormData,
): Promise<PayoutInstrumentState> {
  const teacher = await requireOnboardedTeacher();
  const locale = await getPreferredLocale();

  const parsed = wiseInstrumentSchema(locale).safeParse({
    enabled: formData.get("enabled"),
    handle: formData.get("handle"),
    accountHolder: formData.get("accountHolder"),
    email: formData.get("email"),
  });
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ??
        (usesEnglishCopy(locale) ? "Invalid data" : "Datos inválidos"),
    };
  }

  await saveTeacherInstrument(prisma, {
    teacherId: teacher.id,
    kind: "wise",
    enabled: parsed.data.enabled,
    accountHolder: parsed.data.accountHolder ?? null,
    wiseHandle: parsed.data.handle ?? null,
    wiseEmail: parsed.data.email ?? null,
  });

  revalidateAfterAction("/settings/payments");
  redirect("/settings/payments?wise=1");
}
