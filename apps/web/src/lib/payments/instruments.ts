import type { Prisma, PrismaClient } from "@prisma/client";
import {
  type PayoutInstrument,
  type PayoutInstrumentKind,
  type StudentBuyInstrument,
  railForKind,
  isInstrumentOfferable,
  sortInstruments,
} from "@spiralclass/shared";

export { railForKind };

// Server-side resolution of a teacher's payout instruments (D-113).
//
// Every read path goes through here rather than querying
// `teacherPayoutInstrument` directly, for two reasons:
//
//   1. `INSTRUMENT_SELECT` is the only projection that leaves this module, and
//      it omits the three `wiseApi*` credential columns. A page or an API
//      route that selects the whole row would ship a teacher's Wise API token
//      to the browser; making the safe projection the default path means that
//      cannot happen by forgetting. The credentials have exactly one reader
//      (lib/wise/credentials.ts, for the statement poller) and it asks for
//      them explicitly.
//   2. "Which instruments can this student actually be offered" is one
//      question with several conditions (enabled, detail on file, currency
//      compatible). Spreading it across call sites is how the Stripe/Wise
//      gate drifted before.

// The projection safe to hand to a page, a component, or a wire response.
export const INSTRUMENT_SELECT = {
  id: true,
  kind: true,
  enabled: true,
  accountHolder: true,
  wiseHandle: true,
  wiseEmail: true,
} as const satisfies Prisma.TeacherPayoutInstrumentSelect;

type InstrumentClient = Pick<PrismaClient, "teacherPayoutInstrument">;

// Every instrument a teacher has on file, configured or not — the settings
// page needs the unconfigured ones too, so it can render an empty form.
export async function listTeacherInstruments(
  prisma: InstrumentClient,
  teacherId: string,
): Promise<PayoutInstrument[]> {
  const rows = await prisma.teacherPayoutInstrument.findMany({
    where: { teacherId },
    select: INSTRUMENT_SELECT,
  });
  return sortInstruments(rows);
}

// The instruments a student may actually be shown at checkout, for a price in
// `currency`.
//
// The currency filter is load-bearing rather than cosmetic: SPEI moves MXN and
// only MXN, so offering it against a GBP price would quote a student an amount
// their bank physically cannot send, and the failure would surface as a
// support ticket rather than a validation error.
export function offerableInstruments(
  instruments: readonly PayoutInstrument[],
  currency: string,
): PayoutInstrument[] {
  return sortInstruments(instruments.filter((i) => isInstrumentOfferable(i, currency)));
}

export async function listOfferableInstruments(
  prisma: InstrumentClient,
  teacherId: string,
  currency: string,
): Promise<PayoutInstrument[]> {
  return offerableInstruments(await listTeacherInstruments(prisma, teacherId), currency);
}

// Resolve the instrument a checkout named, re-checking that it belongs to this
// teacher and is still offerable. The id arrives from an untrusted client, so
// ownership is verified here rather than assumed from the fact that it parsed
// as a UUID.
export async function resolveOfferableInstrument(
  prisma: InstrumentClient,
  args: { teacherId: string; instrumentId: string; currency: string },
): Promise<PayoutInstrument | null> {
  const row = await prisma.teacherPayoutInstrument.findFirst({
    where: { id: args.instrumentId, teacherId: args.teacherId },
    select: INSTRUMENT_SELECT,
  });
  if (!row) return null;
  return isInstrumentOfferable(row, args.currency) ? row : null;
}

// The instrument as the checkout picker needs it: enough to label the option
// and to name it back to the server, and nothing more. Payee details are NOT
// here — they belong to the instructions page, which a student only reaches
// once a payment row (and therefore a reference) exists. Shipping an account
// number to everyone who loads a public booking page would hand it out with no
// reference gate at all.
export function toWireInstrument(instrument: {
  id: string;
  kind: PayoutInstrumentKind;
}): StudentBuyInstrument {
  return { id: instrument.id, kind: instrument.kind };
}

// The i18n key for an instrument's display name. Names are proper nouns, so
// they are the same in every locale — but they still go through the catalog so
// a surface never hardcodes one.
export function instrumentNameKey(kind: PayoutInstrumentKind): string {
  return `payments.instrument.${kind}`;
}

// The payee detail a student is actually asked to pay against, reduced to the
// one string that identifies the destination. Used for compact surfaces
// (payment detail, admin, notifications) — the full instructions page renders
// the whole instrument, not this.
export function instrumentPayeeSummary(instrument: PayoutInstrument): string | null {
  return instrument.wiseHandle;
}

// The label a picker shows for an option.
//
// Still a function rather than the literal "Wise": D-145 left one kind, and the
// reason a picker labels an option at all is that a student has to recognize
// the payee before sending — which is this rail's main defence against
// "student says sent, teacher can't find it".
export function instrumentDisplayName(instrument: { kind: PayoutInstrumentKind }): string | null {
  return instrument.kind === "wise" ? "Wise" : null;
}

// The price a student is quoted for a template on a given rail.
//
// `transferPriceMinorUnits` is the NON-CARD price and falls back to the card
// price when unset — teachers don't have to set both. It is one price across
// every manual instrument rather than per-instrument: the discount exists to
// pass on the card-processing saving, which is the same saving whichever
// transfer the student uses.
export function priceForMethod(
  template: { priceMinorUnits: number; transferPriceMinorUnits: number | null },
  method: "stripe" | "manual_transfer",
): number {
  if (method === "manual_transfer") {
    return template.transferPriceMinorUnits ?? template.priceMinorUnits;
  }
  return template.priceMinorUnits;
}
