// The reference a student is asked to quote on a manual transfer.
//
// Instrument-agnostic by construction (D-113): Wise puts it in the transfer's
// reference field, SPEI puts it in the concepto. It used to live in
// `lib/wise/` because Wise was the only manual rail; nothing about it was ever
// Wise-specific.
//
// Design decisions:
//   * Short, human-friendly, copy-pasteable. Derived from the payment's
//     `external_reference` UUID (already unique) by prefixing "AGP-" and
//     uppercasing the leading hex. Deterministic, so the column stays
//     backfillable if a migration ever has to re-derive it.
//   * It is the ONLY matching key on the SPEI instrument. Wise has a
//     statement API to fall back on; SPEI has nothing, and its concepto field
//     is free text that senders truncate or mistype. Reference collisions
//     would be unrecoverable there, which is why the width below is not
//     "short enough to type" alone.

const REFERENCE_PREFIX = "AGP-";

// Hex chars of the source UUID kept in the reference. 12 hex = 48 bits: still
// short enough to type/paste, but wide enough that the reference is not
// realistically enumerable. Was 8 (32 bits), which the security audit (M-8)
// flagged as guessable behind the public booking slug — the instructions route
// exposes the teacher's payee name, so a low-entropy reference plus no rate
// limit allowed harvesting that PII. Widening here (deterministic, so the
// column stays backfillable) hardens every newly minted reference; the
// instructions route additionally rate-limits lookups.
const REFERENCE_HEX_CHARS = 12;

export function generatePaymentReference(externalReference: string): string {
  const compact = externalReference.replace(/-/g, "");
  return `${REFERENCE_PREFIX}${compact.slice(0, REFERENCE_HEX_CHARS).toUpperCase()}`;
}
