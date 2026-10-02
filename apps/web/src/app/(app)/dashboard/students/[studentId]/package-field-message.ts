import type { ManualPackageFieldErrorCode, TFunction } from "@spiralclass/shared";

// Maps validateManualPackageFields' error codes to the localized copy shown
// under the field. Shared between AddPackageForm and EditPackageForm so the
// two forms' wording can't drift apart.
export function packageFieldMessage(
  code: ManualPackageFieldErrorCode | undefined,
  t: TFunction,
  maxRemaining?: number,
): string | undefined {
  switch (code) {
    case "required":
      return t("web.dashboard.classes.focusAreas.required");
    case "invalid-number":
      return t("web.action.packageField.invalidNumber");
    case "remaining-gt-total":
      return t("web.action.packageField.exceedsTotal");
    case "remaining-gt-max": {
      const max = Math.max(maxRemaining ?? 0, 0);
      return t("web.action.packageField.atMost", { max });
    }
    default:
      return undefined;
  }
}
