// Payee instruments for the manual-transfer payout rail (D-113, D-124, D-145).
//
// The manual rail renders payee instructions plus a unique reference, lets the
// student self-attest, and lets the teacher confirm. Since D-145 there is
// exactly ONE kind of instrument — a Wisetag — and this module is the shared
// vocabulary for it, so web and mobile agree on readiness and display without
// either re-implementing it.
//
// ── Why one kind, when the union was the point ────────────────────────────
//
// D-113 shipped three kinds (`wise`, `spei`, `bank_account`); D-124 folded SPEI
// into `bank_account` behind a 15-scheme per-country registry, so that adding a
// country was a registry row rather than a migration. That was good design for
// the problem as it stood, and D-145 removes it because the problem changed:
// [D-143](../../docs/decisions/D-143.md) made the teacher merchant of record on
// her own Stripe account, so Stripe now presents her country's own bank
// transfer — SPEI in Mexico — with automatic reconciliation, which a
// self-attested bank transfer can never have.
//
// `bank_account` had become the strictly worse copy of something Stripe does
// natively, and it was being offered NEXT TO it: one buyer, two SPEI options,
// one confirming in seconds and one waiting on the teacher.
//
// Wise stays because it is the one thing Stripe is not:
//
//   * it auto-reconciles through the teacher's OWN Wise API credentials, so it
//     is not the manual rail in the sense `bank_account` was;
//   * it is the fallback in the five countries Stripe refuses a merchant
//     account (IN, ZA, NG, ID, IS) and everywhere outside the 44 measured
//     Connect countries;
//   * it is what still works if her Stripe account goes restricted.
//
// What is deliberately NOT here, and was not before either: a free-form
// payee-details blob. An unvalidated payee field on a page someone pays from is
// the one place this rail can lose real money with no way back. That rule
// outlived the registry it was written for — if a second kind is ever added
// back, it comes with a validator, not a text box.

export const PAYOUT_INSTRUMENT_KINDS = ["wise"] as const;

export type PayoutInstrumentKind = (typeof PAYOUT_INSTRUMENT_KINDS)[number];

export function isPayoutInstrumentKind(value: unknown): value is PayoutInstrumentKind {
  return (
    typeof value === "string" && (PAYOUT_INSTRUMENT_KINDS as readonly string[]).includes(value)
  );
}

// --- Per-kind capabilities --------------------------------------------------

// Whether a kind can ever be reconciled without the teacher touching it.
//
// Trivially true while Wise is the only kind, and kept as a function rather
// than inlined because it encodes WHY: the poll-wise-statements cron reads a
// teacher's own Wise balance statement through her own API token and matches
// pending payments. No retail bank exposes an equivalent per-teacher statement
// API we could rely on across countries — which is exactly what made the old
// `bank_account` kind permanently teacher-confirmed, and a large part of why
// D-145 removed it. A second kind added later must answer this question
// honestly before the settings UI can.
export function supportsAutoReconcile(kind: PayoutInstrumentKind): boolean {
  return kind === "wise";
}

// The analytics rail dimension for an instrument kind.
//
// Still a function over the kind rather than the constant `"wise"`, because the
// PaymentRail enum deliberately keeps `bank_transfer` for the historical rows
// written before D-145. Nothing emits it any more; nothing may reinterpret the
// rows that carry it either.
export function railForKind(kind: PayoutInstrumentKind): "wise" | "bank_transfer" {
  return kind === "wise" ? "wise" : "bank_transfer";
}

// --- Wisetag ----------------------------------------------------------------

export const WISE_HANDLE_RE = /^[A-Za-z0-9._-]{2,32}$/u;

export function isValidWiseHandle(value: string): boolean {
  return WISE_HANDLE_RE.test(value.trim());
}

// --- Shared shape -----------------------------------------------------------

// The instrument as every read path sees it. `TeacherPayoutInstrument` rows are
// projected onto this before crossing a wire or a component boundary, so the
// Wise API credential columns never leave the server by accident.
export type PayoutInstrument = {
  id: string;
  kind: PayoutInstrumentKind;
  enabled: boolean;
  accountHolder: string | null;
  wiseHandle: string | null;
  wiseEmail: string | null;
};

// The minimal shape every readiness question needs. Kept separate from
// `PayoutInstrument` so a caller that only selected these columns (a listing
// gate, a dashboard checklist) doesn't have to over-select to satisfy a type.
export type InstrumentReadiness = {
  kind: PayoutInstrumentKind;
  enabled: boolean;
  wiseHandle: string | null;
};

// An instrument is ready when it is enabled AND carries the detail it is paid
// through.
export function isInstrumentReady(instrument: InstrumentReadiness): boolean {
  return instrument.enabled && Boolean(instrument.wiseHandle);
}

// Whether this instrument can be offered for a price in `currency`.
//
// Always true today: Wise is multi-currency, so unlike the domestic clearing
// schemes D-145 removed there is no price it cannot quote. Kept as a named
// question because the reason is a property of Wise, not a law — a future kind
// on a single-currency rail would make this load-bearing again, and the
// checkout already asks it.
export function instrumentSupportsCurrency(
  instrument: { kind: PayoutInstrumentKind },
  currency: string,
): boolean {
  void currency;
  return instrument.kind === "wise";
}

// Ready AND payable in this currency — the full question a checkout asks.
// Split from `isInstrumentReady` because the settings page cares about the
// first half alone.
export function isInstrumentOfferable(instrument: InstrumentReadiness, currency: string): boolean {
  return isInstrumentReady(instrument) && instrumentSupportsCurrency(instrument, currency);
}

// Whether the teacher can take a manual transfer at all, for a price in
// `currency`.
export function hasOfferableInstrument(
  instruments: readonly InstrumentReadiness[],
  currency: string,
): boolean {
  return instruments.some((i) => isInstrumentOfferable(i, currency));
}

// Stable ordering for the checkout picker and the settings page. A no-op with
// one kind, kept so the call sites do not have to change back if a second kind
// returns — and so nothing starts relying on database order, which is not one.
const KIND_ORDER: Record<PayoutInstrumentKind, number> = { wise: 0 };

export function sortInstruments<T extends { kind: PayoutInstrumentKind }>(
  instruments: readonly T[],
): T[] {
  return [...instruments].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}
