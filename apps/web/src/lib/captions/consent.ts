// Live-captions consent gate (the captions architecture review P0).
//
// Captions are bidirectional: a student's own speech can be recognised by a
// browser's speech service and its text translated during an ordinary
// scheduled class (D-185). That's a materially
// more direct, real-time case than the post-call lesson-insights pipeline
// (see lib/lesson-notes/consent.ts) — so this is a SEPARATE consent, not a
// reuse of insightsConsentAt: an adult student must consent HERSELF
// (self-service, on her own account page), not via teacher attestation. The
// minor path stays teacher-attested, exactly like the insights gate, and
// shares the same `isMinor` flag (one concept, not duplicated per feature).
//
// This only gates whether the STUDENT's speech may be captioned — whichever
// browser in the call would recognise it. Receiving captions of what the
// other participant says is never gated by this predicate. It is enforced in
// captionsPublishConsentOk (lib/captions/class-access.ts), whose verdict the
// caption config route hands both browsers and the translation route
// re-checks on every call.
//
// Pure predicate (no I/O), mirroring lessonInsightsConsentOk's shape.

export type CaptionsConsent = {
  // Shared with the insights gate — a minor's own consent is never accepted
  // as a substitute for a guardian's.
  isMinor: boolean;
  // Adult student's own recorded consent timestamp (null = not given).
  captionsConsentAt: Date | null;
  // Guardian's recorded consent timestamp for a minor (null = not given).
  captionsGuardianConsentAt: Date | null;
};

// True only when the right consent for this pair has been recorded:
//   - minor   → captionsGuardianConsentAt must be set
//   - adult   → captionsConsentAt must be set
// Everything defaults to OFF, so an existing/new pairing with no recorded
// consent is correctly NOT ok.
export function captionsConsentOk(consent: CaptionsConsent): boolean {
  if (consent.isMinor) return consent.captionsGuardianConsentAt != null;
  return consent.captionsConsentAt != null;
}
