// Lesson-insights consent gate (D-22, refines D-19 item 6 and D-21 item 2).
//
// Capturing a student's voice for the insights pipeline requires an explicit,
// recorded consent for the specific (teacher, student) pair. The visible
// recording indicator (D-21 item 2) is necessary but is not treated as sufficient on
// its own — so capture is gated HERE, at the point of capture, on a
// deliberately-recorded consent.
//
// This is a pure predicate (no I/O) so it's trivially unit-testable and can be
// called from the capture entry point and from UI without duplicating the rule.

export type InsightsConsent = {
  // The pair is flagged as a minor → a guardian's consent is the one that
  // counts. We do not accept the student's own consent for a minor.
  isMinor: boolean;
  // Adult student's recorded consent timestamp (null = not given).
  insightsConsentAt: Date | null;
  // Guardian's recorded consent timestamp for a minor (null = not given).
  guardianConsentAt: Date | null;
  // The package the class is paid from, when the caller is deciding about one
  // class. A class for two has a second person in the room who has no account
  // and so no consent row (D-188); what stands in for it is the buyer's
  // confirmation at purchase, `Package.partnerConsentAt`. Omitted when the
  // question is about the pair rather than a class (the student profile).
  classPackage?: { seats: number; partnerConsentAt: Date | null };
};

// True only when the right consent for this pair has been recorded:
//   - minor   → guardianConsentAt must be set
//   - adult   → insightsConsentAt must be set
//   - a class for two → the buyer's confirmation for the second person too
// Everything defaults to OFF, so an existing/new pairing with no recorded
// consent is correctly NOT ok — and so is a class for two recorded by the
// teacher rather than bought, which nobody confirmed for the second person.
export function lessonInsightsConsentOk(consent: InsightsConsent): boolean {
  if (consent.classPackage?.seats === 2 && consent.classPackage.partnerConsentAt == null) {
    return false;
  }
  if (consent.isMinor) return consent.guardianConsentAt != null;
  return consent.insightsConsentAt != null;
}
