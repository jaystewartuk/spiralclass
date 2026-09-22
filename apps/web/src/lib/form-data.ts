// Reading optional fields out of a FormData, safely.
//
// A form that renders EITHER one input OR another — the percent/pesos pairs in
// discounts and referrals — omits the input it is not showing, so
// formData.get() returns null for that name. An input that is rendered but left
// blank returns "".
//
// Both are "the user did not supply this", and neither is what
// z.coerce.number() does with them: Number(null) and Number("") are both 0, so
// an absent field arrives at the schema as a real 0 and fails min(1) /
// positive() / nonnegative() checks that were never meant to see it.
// .optional() does not catch either, because it admits only undefined.
//
// That defect shipped twice — see the fixes to saveReferralProgram and
// createDiscountCode, each of which made its whole form unsaveable in every
// configuration it could produce. Normalize here, before zod sees the value.
export function absent(value: FormDataEntryValue | null): FormDataEntryValue | undefined {
  return value === null || value === "" ? undefined : value;
}
