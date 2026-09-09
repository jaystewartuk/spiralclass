import { isInstrumentReady, type InstrumentReadiness } from "@spiralclass/shared";

/**
 * "Can my students pay me, and how?" — resolved once, for the whole page.
 *
 * The page used to answer neither half. It rendered two equally-weighted
 * cards, each stating its own rail's internals ("Charges enabled: pending"),
 * and left the teacher to work out from them whether anyone could actually buy
 * a package. That is the ONE question this screen exists to answer, and it was
 * the one thing on it nothing said.
 *
 * So the verdict is computed here, as data, before any markup exists: each
 * rail collapses to a single state, and the page's headline is a function of
 * whether any of them is `live`. Pure and exported so the states can be tested
 * directly — every one of them is reachable in production, and several
 * (a linked account in a country the platform no longer supports, an enabled
 * Wise instrument whose handle was cleared) are awkward to pose in a browser.
 */

/** What one rail can be, from the teacher's point of view. */
export type RailState =
  /** Offerable at checkout right now. */
  | "live"
  /** Linked, but Stripe has not enabled charges yet — her move, in Stripe. */
  | "verifying"
  /** Nothing set up; setting it up is available to her. */
  | "not-connected"
  /** Switched on but missing the detail it is paid through (no Wisetag). */
  | "incomplete"
  /** Configured and deliberately switched off. */
  | "off"
  /** Not offered to her at all — the card rail outside SUPPORTED_CONNECT_COUNTRIES. */
  | "unavailable"
  /**
   * The rail does not exist on this deploy, so it is not mentioned at all.
   * Distinct from `unavailable`, which is a fact about HER country and worth
   * telling her; this is a fact about our configuration and telling her
   * "not available in your country" would simply be false.
   */
  | "hidden";

export type PayoutReadiness = {
  card: RailState;
  wise: RailState;
  /** True when at least one rail can take a payment today. */
  canBePaid: boolean;
};

export type ReadinessInput = {
  /** `hasStripeCreds()` — a deploy with no Stripe keys hides the rail entirely. */
  stripeConfigured: boolean;
  /** `isConnectCountrySupported(teacher.country)`. */
  payoutCountrySupported: boolean;
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean;
  /** Every instrument on file, configured or not. */
  instruments: readonly InstrumentReadiness[];
};

export function resolvePayoutReadiness(input: ReadinessInput): PayoutReadiness {
  const card = cardState(input);
  const wise = wiseState(input.instruments);
  return { card, wise, canBePaid: card === "live" || wise === "live" };
}

function cardState(input: ReadinessInput): RailState {
  // A linked account outranks the country gate deliberately, and matches
  // `stripeAvailable` in the page: a teacher who linked before her country
  // left SUPPORTED_CONNECT_COUNTRIES still has a live rail, and telling her it
  // is "not available" while her students are paying through it would be
  // false. The gate governs whether she may START, not whether what she has
  // works.
  if (input.stripeAccountId) return input.stripeChargesEnabled ? "live" : "verifying";
  if (!input.stripeConfigured) return "hidden";
  if (!input.payoutCountrySupported) return "unavailable";
  return "not-connected";
}

function wiseState(instruments: readonly InstrumentReadiness[]): RailState {
  const wise = instruments.find((i) => i.kind === "wise");
  if (!wise) return "not-connected";
  if (isInstrumentReady(wise)) return "live";
  // Enabled without a handle is the state the DB CHECK constraint and the
  // validator both refuse to create — but a handle cleared through an older
  // path, or a row predating the constraint, lands here rather than silently
  // reading as "off". Naming it is what lets the page say "add your Wisetag"
  // instead of showing a toggle that is on beside a rail that is not.
  if (wise.enabled) return "incomplete";
  return wise.wiseHandle ? "off" : "not-connected";
}
