import type { ManualPackageFieldErrorCode } from "@spiralclass/shared";

// Maps validateManualPackageFields' error codes to the localized copy shown
// under the field. Shared between AddPackageForm and EditPackageForm so the
// two forms' wording can't drift apart.
export function packageFieldMessage(
  code: ManualPackageFieldErrorCode | undefined,
  en: boolean,
  maxRemaining?: number,
): string | undefined {
  switch (code) {
    case "required":
      return en ? "Required" : "Requerido";
    case "invalid-number":
      return en ? "Enter a valid number" : "Ingresa un número válido";
    case "remaining-gt-total":
      return en
        ? "Classes left can't exceed the total."
        : "Las clases restantes no pueden superar el total.";
    case "remaining-gt-max": {
      const max = Math.max(maxRemaining ?? 0, 0);
      return en
        ? `Classes left can be at most ${max} for this package.`
        : `Las clases restantes pueden ser como máximo ${max} para este paquete.`;
    }
    default:
      return undefined;
  }
}
