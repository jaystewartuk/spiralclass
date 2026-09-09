import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AccountDeletionForm } from "@/app/(app)/settings/account/account-deletion-form";
import { getT } from "@/lib/i18n";

// Shared "Delete account" card for both account pages — wraps the existing
// AccountDeletionForm (already role-parameterized via subjectType) with the
// role-aware copy. We retain payment records for the period UK tax law
// requires — the platform entity is UK-established (D-58). **The operative
// period is the one the published privacy policy states**: six years for
// payment and invoice records (`packages/shared/src/legal/privacy-policy.ts`,
// the "retention" section). Do not restate a different number here; that file
// is the single source of truth and carries its own note that the figure is a
// policy choice to confirm with an accountant. The retained rows are
// isolated/anonymized and carry no personal data after deletion. (This cited
// Mexican law — CFF art. 30 — until 2026-08-25, left over from the pre-D-58
// Mexican entity.)
export async function DeleteAccountCard({
  subjectType,
  pending,
}: {
  subjectType: "student" | "teacher";
  pending: { id: string; scheduledFor: string } | null;
}) {
  const t = await getT();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("web.deleteAccountCard.title")}</CardTitle>
        <CardDescription>{t("web.deleteAccountCard.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <AccountDeletionForm subjectType={subjectType} pending={pending} />
      </CardContent>
    </Card>
  );
}
