import { type PayoutInstrument, type StringKey } from "@spiralclass/shared";
import { buildWisePayUrl } from "@/lib/wise";

// The payee block a student actually pays against (D-124, D-145).
//
// One builder, used by the web instructions page. Before D-124 each surface
// reached into
// the instrument and picked out `wiseHandle` or `clabe` by hand; three
// hand-written versions of "which fields does this account have" is three
// places for a student to be shown the wrong thing, so it became one builder
// over a scheme registry.
//
// D-145 removed the registry with the `bank_account` kind, and this stayed a
// builder rather than collapsing back into the page. The shape is what callers
// are written against, and it is the seam a second kind would return
// through — the lesson from before D-124 was that inlining it is what let the
// surfaces drift.

export type PayeeField = {
  // i18n catalog key for the field's label — the catalog's own key type, so a
  // field whose label is missing a translation fails the build rather than
  // rendering a raw key at a student.
  labelKey: StringKey;
  // Grouped for reading aloud and comparing by eye.
  display: string;
  // The canonical value, for a copy button. Copying a grouped value into a
  // banking app that rejects spaces is a real and annoying failure.
  copy: string;
};

export type PayeeInstructions = {
  kind: "wise";
  recipientName: string;
  fields: PayeeField[];
  // A prefilled Quick-Pay URL to hand off to, so the student never retypes the
  // amount or the reference.
  wisePayUrl: string | null;
  wiseEmail: string | null;
};

export function buildPayeeInstructions(args: {
  instrument: PayoutInstrument;
  amountMinorUnits: number;
  currency: string;
  reference: string;
  fallbackRecipientName: string;
}): PayeeInstructions | null {
  const { instrument, amountMinorUnits, currency, reference } = args;
  const recipientName = instrument.accountHolder ?? args.fallbackRecipientName;

  if (!instrument.wiseHandle) return null;
  return {
    kind: "wise",
    recipientName,
    fields: [
      {
        labelKey: "payments.bank.field.wiseTag",
        display: instrument.wiseHandle,
        copy: instrument.wiseHandle,
      },
    ],
    wisePayUrl: buildWisePayUrl({
      handle: instrument.wiseHandle,
      amountMinorUnits,
      currency,
      reference,
    }),
    wiseEmail: instrument.wiseEmail,
  };
}
