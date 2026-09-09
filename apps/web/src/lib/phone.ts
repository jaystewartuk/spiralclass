// E.164 normalization now lives in @spiralclass/shared so web and mobile
// normalize phone numbers identically. Re-exported for existing imports.
export { normalizeE164 } from "@spiralclass/shared";

// Equivalent E.164 forms (all `+`-prefixed) a phone number can take, used to
// MATCH a sign-in phone against stored `Student.phoneE164` rows. The number
// that arrives at login (from Supabase/GoTrue's `user.phone`, which has no `+`)
// must reconcile with a roster value that went through `normalizeE164` (which
// keeps whatever digits the teacher entered). The only real ambiguity in this
// market is the legacy Mexican mobile "1": historically MX mobiles carried a
// `1` after the country code (`+521NXXXXXXXXX`); modern E.164 drops it
// (`+52NXXXXXXXXX`). Carriers and roster imports disagree on that digit for the
// same handset, so we generate both forms and match on either. Non-MX numbers
// (and malformed input) collapse to the single canonical `+digits` form.
export function phoneMatchVariants(input: string): string[] {
  const digits = input.replace(/\D/g, "");
  if (!digits) return [];
  const variants = new Set<string>([`+${digits}`]);
  if (digits.startsWith("52")) {
    const rest = digits.slice(2);
    if (rest.startsWith("1") && rest.length === 11) {
      variants.add(`+52${rest.slice(1)}`); // +521NXXXXXXXXX → +52NXXXXXXXXX
    } else if (rest.length === 10) {
      variants.add(`+521${rest}`); // +52NXXXXXXXXX → +521NXXXXXXXXX
    }
  }
  return [...variants];
}
