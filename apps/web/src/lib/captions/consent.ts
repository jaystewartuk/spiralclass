// Live-captions consent gate (the captions architecture review P0).
//
// Captions are bidirectional: a student's own mic can be streamed to a
// third-party ASR provider (and its transcript to an LLM translator) during
// an ordinary scheduled class. That's a materially
// more direct, real-time case than the post-call lesson-insights pipeline
// (see lib/lesson-notes/consent.ts) — so this is a SEPARATE consent, not a
// reuse of insightsConsentAt: an adult student must consent HERSELF
// (self-service, on her own account page), not via teacher attestation. The
// minor path stays teacher-attested, exactly like the insights gate, and
// shares the same `isMinor` flag (one concept, not duplicated per feature).
//
// This only gates whether THIS person's own mic may be published to ASR —
// receiving captions of what the other participant says is never gated by
// this predicate (see lib/captions/class-access.ts and the token-mint
// routes for where this is actually enforced).
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
