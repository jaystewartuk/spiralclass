"use client";

import {
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import { isOneClassSoldAsCredit } from "@spiralclass/shared";
import { ChevronDown, Copy, Package, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldError } from "@/components/ui/field-error";
import { FormStatus } from "@/components/ui/form-status";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveTemplatesAction, type OnboardingState } from "@/app/actions/onboarding";
import {
  computeWisePriceFromStripe,
  stripeWorstCaseRatePercent,
  suggestStripePriceFromWise,
} from "@/lib/pricing/stripe-fee";
import {
  PACKAGE_NAME_MAX_CHARS,
  PACKAGE_SUBJECT_MAX_CHARS,
  deriveWiseAuto,
  duplicatePackageName,
  packageRowIssues,
  pendingPackageChanges,
  pricePerClassMinorUnits,
  transferPriceIsNotADiscount,
  type PackageDraft,
  type PackageRow,
  type PackageRowIssue,
} from "@/lib/pricing/package-editor";
import {
  minorUnitsToMajor,
  currencyExponent,
  formatMinorUnits,
  majorToMinorUnits,
} from "@/lib/money";
import { useT } from "@/components/locale-provider";
import { usePricingCurrency } from "@/components/pricing-currency-context";
import { cn } from "@/lib/utils";

// The package editor, shared by /settings/templates and the onboarding
// packages step. The server contract is unchanged and deliberately so: the
// whole list still round-trips through ONE submission as index-aligned
// `tpl_*` arrays, and a removed row still posts with `keep=0` so the action
// archives it. What changed is everything the teacher touches.
//
// It used to render every package as a permanently-open card titled "Package
// 1".."Package N" — the one label that is guaranteed to say nothing, on a
// screen whose entire job is telling four near-identical offers apart. A
// teacher with six packages met roughly forty number inputs stacked in one
// column and a Save button below all of them, and the page never once showed
// her the thing she is actually deciding: what a class costs inside each
// package. So a row summarises itself now — name, shape, price, price per
// class — and opens only when she asks for it.
//
// Six real defects went with that shape, fixed here rather than styled over:
//
//   1. The saving line rendered in MXN for every teacher. `formatMinorUnits`
//      defaults its currency, and this call site never passed one — so a
//      teacher pricing in GBP was told her student saves "$120.00 MXN".
//   2. Nothing said the page had unsaved work. A batch form where one nav
//      click silently discards four repriced packages has to say so, so the
//      action bar names what is pending and a beforeunload guard backs it.
//   3. Validation was `required` on the visible inputs — which are NOT the
//      inputs that submit. It also cannot survive a collapsed row: a
//      `required` control inside a `hidden` subtree makes the browser refuse
//      the submit with an error it cannot show anywhere. Rows are validated
//      explicitly now, before dispatch, and the offending rows are opened.
//   4. `step={1}` on the price made every non-integer price invalid, which is
//      most of them outside a whole-unit currency. The step comes from the
//      currency's own exponent now, same as every other number here.
//   5. The price fields never named their currency anywhere on the screen.
//   6. A transfer price above the card price — the discount rail costing the
//      student MORE — was accepted in silence by both the form and checkout.
//
// The two surfaces differ only where they must: the wizard step keeps its
// linear footer (its primary action is "continue", and it sits under a
// stepper and a back link a sticky bar would cover), settings gets the sticky
// action bar a page you return to and edit in place needs.

let nextLocalId = 1;
const localId = () => `new-${nextLocalId++}`;

const BLANK_DRAFT = (): PackageDraft => ({
  id: "",
  name: "",
  subject: null,
  classCount: 4,
  singleClass: false,
  classDurationMin: 50,
  priceMinorUnits: 0,
  transferPriceMinorUnits: null,
  expirationMonths: 1,
});

const ISSUE_KEY = {
  "name-missing": "web.packages.errorNameMissing",
  "class-count": "web.packages.errorClassCount",
  duration: "web.packages.errorDuration",
  "price-negative": "web.packages.errorPriceNegative",
  "expiration-missing": "web.packages.errorExpirationMissing",
} as const;

/** Which field an issue belongs to — decides what gets focused on a failed submit. */
const ISSUE_FIELD: Record<PackageRowIssue, "name" | "count" | "duration" | "price" | "expiration"> =
  {
    "name-missing": "name",
    "class-count": "count",
    duration: "duration",
    "price-negative": "price",
    "expiration-missing": "expiration",
  };

// Matches FormStatus's own fade, so the saved confirmation and the bar holding
// it disappear together instead of leaving an empty bar behind.
const SAVED_VISIBLE_MS = 4200;

// The step a price input moves in: one minor unit, per currency. A hardcoded
// `1` made £24.50 an invalid value the browser silently refused to submit,
// while `0.01` would be a hundredth of a yen.
function priceStep(currency: string): number {
  return 1 / 10 ** currencyExponent(currency);
}

// Every row submits the same fixed set of hidden fields, in list order, so the
// action's parallel getAll() arrays stay index-aligned — removed rows included.
//
// `currency` is required, not optional with an MXN default: these inputs carry
// MAJOR units to the action, and converting minor→major with a hardcoded 100 is
// a 100x error in a 0-decimal currency (CLP, JPY, KRW, VND), not a rounding one.
// A defaulted parameter would let a caller forget silently; this way it cannot.
function RowHiddenInputs({ row, currency }: { row: PackageRow; currency: string }) {
  return (
    <>
      <input type="hidden" name="tpl_id" value={row.id} />
      <input type="hidden" name="tpl_name" value={row.name} />
      <input type="hidden" name="tpl_subject" value={row.subject ?? ""} />
      <input type="hidden" name="tpl_single_class" value={row.singleClass ? "1" : "0"} />
      <input type="hidden" name="tpl_class_count" value={row.singleClass ? 1 : row.classCount} />
      <input type="hidden" name="tpl_duration" value={row.classDurationMin} />
      <input
        type="hidden"
        name="tpl_price"
        value={minorUnitsToMajor(row.priceMinorUnits, currency)}
      />
      <input
        type="hidden"
        name="tpl_wise_price"
        value={
          row.transferPriceMinorUnits === null
            ? ""
            : minorUnitsToMajor(row.transferPriceMinorUnits, currency)
        }
      />
      <input type="hidden" name="tpl_expiration" value={row.expirationMonths ?? ""} />
      <input type="hidden" name="tpl_keep" value={row.keep ? "1" : "0"} />
    </>
  );
}

export function TemplatesForm({
  initial,
  redirectTo,
  submitLabel,
  payoutCountrySupported,
  showSubject = true,
  stickyActions = false,
  cap = null,
  soldByTemplateId,
  emptyDescription,
}: {
  initial: PackageDraft[];
  redirectTo?: "/settings/templates";
  submitLabel?: string;
  // From `isConnectCountrySupported(teacher.country)` — a teacher outside the
  // Stripe Connect payout circle never gets a Stripe rail at all (Wise is her
  // only rail, D-58), so the "Stripe price" / "charge less for Wise" split is
  // meaningless: there's no Stripe price to discount against. Those teachers
  // see a single plain "Price" field instead.
  payoutCountrySupported: boolean;
  // Per-package subject is hidden during onboarding and shown in
  // /settings/templates (D-112): on a language-first platform the subject is a
  // property of the TEACHER (`targetLanguage`, asked at step 1), so asking it
  // again per package before she has a single student is friction for the rare
  // two-language teacher's benefit. The field is only hidden, never cleared —
  // `RowHiddenInputs` still submits `tpl_subject` from row state, so a subject
  // set in settings survives an onboarding re-save untouched.
  showSubject?: boolean;
  /**
   * Settings only: pin the actions to the bottom of the viewport and report
   * unsaved work. The wizard step deliberately keeps its linear footer — its
   * action is "continue to the next step", it sits between a stepper and a
   * back link, and a sticky bar would cover the latter.
   */
  stickyActions?: boolean;
  /** Active-package cap from the entitlements resolver; null = unlimited (Pro). */
  cap?: number | null;
  /**
   * How many packages each template has already sold, keyed by template id.
   * Removing a template archives it — it does NOT touch the packages already
   * bought from it — and that is the one fact a teacher needs before she
   * removes one, so the row says it rather than leaving her to guess.
   */
  soldByTemplateId?: Record<string, number>;
  emptyDescription?: string;
}) {
  const t = useT();
  const currency = usePricingCurrency();

  const toRows = useCallback(
    (drafts: PackageDraft[]): PackageRow[] =>
      drafts.map((r) => {
        // Drop a stale Wise price the moment we load it, when this teacher has
        // no card rail to discount against. The split's controls are hidden for
        // her (see `payoutCountrySupported`), and a value that no control can
        // reach is one nobody can correct — while checkout still charges it
        // (`transferPriceMinorUnits ?? priceMinorUnits`). Normalising here keeps the
        // single visible "Price" field honest about what a student pays.
        const transferPriceMinorUnits = payoutCountrySupported ? r.transferPriceMinorUnits : null;
        return {
          ...r,
          transferPriceMinorUnits,
          keep: true,
          // `currency` is D-143: the discount maths is currency-aware now,
          // because a card-rail teacher can price in a 0-decimal currency where
          // the old hardcoded 100 minor units was a 100x error.
          wiseAuto: deriveWiseAuto(r.priceMinorUnits, transferPriceMinorUnits, currency),
          localKey: r.id || localId(),
        };
      }),
    [payoutCountrySupported, currency],
  );

  // `baseline` is the list the server last confirmed; `rows` is what she sees.
  // The difference between the two is the entire unsaved-changes model.
  const [baseline, setBaseline] = useState<PackageDraft[]>(initial);
  const [rows, setRows] = useState<PackageRow[]>(() => toRows(initial));
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());
  const [attempted, setAttempted] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const [state, formAction, pending] = useActionState<OnboardingState, FormData>(
    saveTemplatesAction,
    undefined,
  );

  const fieldRefs = useRef(new Map<string, HTMLInputElement | null>());
  const toggleRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const undoRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const focusAfterAdd = useRef<string | null>(null);
  const focusAfterRemove = useRef<string | null>(null);

  const setFieldRef = useCallback(
    (localKey: string, field: string) => (el: HTMLInputElement | null) => {
      fieldRefs.current.set(`${localKey}:${field}`, el);
    },
    [],
  );

  const setOpen = useCallback((localKey: string, open: boolean) => {
    setOpenKeys((keys) => {
      const next = new Set(keys);
      if (open) next.add(localKey);
      else next.delete(localKey);
      return next;
    });
  }, []);

  // The settings save returns instead of redirecting (the wizard step still
  // redirects to the next step), so adopt the server's ids — a row created
  // this session now has one — and reset the baseline, so the action bar goes
  // quiet rather than claiming the work is still pending.
  useEffect(() => {
    if (!state?.ok || !state.templates) return;
    setBaseline(state.templates);
    setRows(toRows(state.templates));
    setAttempted(false);
    setJustSaved(true);
    const timer = setTimeout(() => setJustSaved(false), SAVED_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [state, toRows]);

  // A newly added row opens focused on its name field: naming it is the first
  // thing she has to do, so the cursor should already be there.
  useEffect(() => {
    const key = focusAfterAdd.current;
    if (key) {
      focusAfterAdd.current = null;
      fieldRefs.current.get(`${key}:name`)?.focus();
      return;
    }
    // Removing a row unmounts the button that was focused, so focus falls to
    // <body>. Put it somewhere deliberate: the undo control that replaced it.
    const removed = focusAfterRemove.current;
    if (removed) {
      focusAfterRemove.current = null;
      undoRefs.current.get(removed)?.focus();
    }
  }, [rows]);

  const visible = useMemo(() => rows.filter((r) => r.keep), [rows]);
  const removed = useMemo(() => rows.filter((r) => !r.keep && r.id), [rows]);
  const changes = useMemo(() => pendingPackageChanges(baseline, rows), [baseline, rows]);
  const issues = useMemo(() => packageRowIssues(rows), [rows]);
  const baselineById = useMemo(() => new Map(baseline.map((b) => [b.id, b])), [baseline]);
  const atCap = cap !== null && visible.length >= cap;

  // Warn on a real unload (reload, close, an external link). Next.js client
  // navigation does not fire this event, so it is a backstop for the losses a
  // browser can still tell us about — not a complete route guard.
  useEffect(() => {
    if (!changes.dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changes.dirty]);

  const update = useCallback((localKey: string, patch: Partial<PackageRow>) => {
    setRows((rs) => rs.map((r) => (r.localKey === localKey ? { ...r, ...patch } : r)));
  }, []);

  // Flipping a row to "individual class" pins its class count to 1 — the
  // student pays per class at reservation time, so there's no multi-class
  // balance to size.
  const toggleSingleClass = useCallback((localKey: string, enabled: boolean) => {
    setRows((rs) =>
      rs.map((r) =>
        r.localKey === localKey
          ? { ...r, singleClass: enabled, classCount: enabled ? 1 : r.classCount }
          : r,
      ),
    );
  }, []);

  const setPrice = useCallback(
    (localKey: string, priceMinorUnits: number) => {
      setRows((rs) =>
        rs.map((r) => {
          if (r.localKey !== localKey) return r;
          const nextWise =
            r.wiseAuto && r.transferPriceMinorUnits !== null
              ? computeWisePriceFromStripe(priceMinorUnits, currency)
              : r.transferPriceMinorUnits;
          return { ...r, priceMinorUnits, transferPriceMinorUnits: nextWise };
        }),
      );
    },
    [currency],
  );

  const toggleWiseDiscount = useCallback(
    (localKey: string, enabled: boolean) => {
      setRows((rs) =>
        rs.map((r) => {
          if (r.localKey !== localKey) return r;
          if (!enabled) return { ...r, transferPriceMinorUnits: null, wiseAuto: false };
          return {
            ...r,
            transferPriceMinorUnits: computeWisePriceFromStripe(r.priceMinorUnits, currency),
            wiseAuto: true,
          };
        }),
      );
    },
    [currency],
  );

  const setWisePrice = useCallback((localKey: string, transferPriceMinorUnits: number) => {
    setRows((rs) =>
      rs.map((r) =>
        r.localKey === localKey ? { ...r, transferPriceMinorUnits, wiseAuto: false } : r,
      ),
    );
  }, []);

  // Used by the inline calculator: takes the teacher's current transfer price
  // as the target, then back-solves a clean card headline + the auto-computed
  // discount that meets or just exceeds that target.
  const applyWiseTargetSuggestion = useCallback(
    (localKey: string, targetWiseMinorUnits: number) => {
      const stripeMinorUnits = suggestStripePriceFromWise(targetWiseMinorUnits, currency);
      setRows((rs) =>
        rs.map((r) =>
          r.localKey === localKey
            ? {
                ...r,
                priceMinorUnits: stripeMinorUnits,
                transferPriceMinorUnits: computeWisePriceFromStripe(stripeMinorUnits, currency),
                wiseAuto: true,
              }
            : r,
        ),
      );
    },
    [currency],
  );

  function addRow(seed: PackageDraft = BLANK_DRAFT()) {
    if (atCap) return;
    const localKey = localId();
    focusAfterAdd.current = localKey;
    setRows((rs) => [
      ...rs,
      { ...seed, id: "", localKey, keep: true, wiseAuto: seed.transferPriceMinorUnits !== null },
    ]);
    setOpen(localKey, true);
  }

  function duplicateRow(row: PackageRow) {
    if (atCap) return;
    const name = duplicatePackageName(
      row.name || t("web.packages.untitled"),
      visible.map((r) => r.name),
    );
    const localKey = localId();
    focusAfterAdd.current = localKey;
    setRows((rs) => {
      const at = rs.findIndex((r) => r.localKey === row.localKey);
      const copy: PackageRow = { ...row, id: "", name, localKey, keep: true };
      return [...rs.slice(0, at + 1), copy, ...rs.slice(at + 1)];
    });
    setOpen(localKey, true);
  }

  // Remove = drop a never-saved row entirely; mark a saved one for archive
  // (kept in the list, collapsed and undoable, so the server sees keep=0).
  // Nothing is destroyed until Save, which is why this needs no confirmation:
  // an undo that is already on screen beats a dialog asking whether she meant
  // it, and the action bar counts the removal alongside every other change.
  function removeRow(row: PackageRow) {
    setOpen(row.localKey, false);
    if (!row.id) {
      const index = visible.findIndex((r) => r.localKey === row.localKey);
      const neighbour = visible[index + 1] ?? visible[index - 1];
      setRows((rs) => rs.filter((r) => r.localKey !== row.localKey));
      setTimeout(() => {
        const target = neighbour ? toggleRefs.current.get(neighbour.localKey) : null;
        (target ?? addButtonRef.current)?.focus();
      }, 0);
      return;
    }
    focusAfterRemove.current = row.localKey;
    update(row.localKey, { keep: false });
  }

  function restoreRow(localKey: string) {
    update(localKey, { keep: true });
    setTimeout(() => toggleRefs.current.get(localKey)?.focus(), 0);
  }

  function discard() {
    setRows(toRows(baseline));
    setOpenKeys(new Set());
    setAttempted(false);
  }

  // Validate before dispatch. React 19 honours preventDefault here, so an
  // invalid list never reaches the action; the offending rows are opened (a
  // collapsed row cannot show its own error) and the first one takes focus.
  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    setAttempted(true);
    if (issues.size === 0) return;
    e.preventDefault();
    setOpenKeys((keys) => new Set([...keys, ...issues.keys()]));
    const first = visible.find((r) => issues.has(r.localKey));
    if (!first) return;
    const issue = issues.get(first.localKey);
    if (!issue) return;
    // Deferred past the render that opens the row — the field does not exist yet.
    requestAnimationFrame(() => {
      fieldRefs.current.get(`${first.localKey}:${ISSUE_FIELD[issue]}`)?.focus();
    });
  }

  // A server-side rejection names the offending row by INDEX (the action's
  // `templateIndex`), so open it — an error pointing at a collapsed row is an
  // error the teacher cannot see.
  //
  // The index is into `rows`, NOT `visible`: the action parses the hidden
  // inputs, which every row emits — a package removed this session included —
  // so a removed row ahead of the offending one shifts the visible list out of
  // step with what the server counted.
  //
  // The list is read through a ref rather than declared as a dependency: this
  // reacts to a NEW server response, and re-running it on every keystroke
  // afterwards would re-open a card the teacher had just closed.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(() => {
    if (state?.templateIndex === undefined) return;
    const row = rowsRef.current[state.templateIndex];
    if (row?.keep) setOpen(row.localKey, true);
  }, [state, setOpen]);

  const showErrors = attempted && issues.size > 0;
  const showBar = !stickyActions || changes.dirty || pending || justSaved || showErrors;

  const actions = (
    <>
      {stickyActions && (
        <ConfirmDialog
          trigger={
            <Button type="button" variant="ghost" size="sm" disabled={pending || !changes.dirty}>
              {t("web.packages.discard")}
            </Button>
          }
          title={t("web.packages.discardTitle")}
          description={t("web.packages.discardBody")}
          footer={(close) => (
            <>
              <Button type="button" variant="outline" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  discard();
                  close();
                }}
              >
                {t("web.packages.discard")}
              </Button>
            </>
          )}
        />
      )}
      <Button type="submit" disabled={pending}>
        {pending ? t("web.onboarding.saving") : (submitLabel ?? t("common.continue"))}
      </Button>
    </>
  );

  const status = (
    <div className="min-w-0 space-y-0.5">
      {changes.dirty && !pending && (
        <p className="text-sm font-medium tabular-nums">
          {t("web.packages.unsaved", { count: changes.count })}
        </p>
      )}
      {showErrors ? (
        <p role="alert" className="text-destructive text-sm">
          {t("web.packages.fixErrors")}
        </p>
      ) : (
        <FormStatus
          state={state}
          savedMessage={t("settings.templates.saved")}
          pending={pending}
          savingMessage={t("web.onboarding.saving")}
        />
      )}
    </div>
  );

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="space-y-4">
      {redirectTo && <input type="hidden" name="redirectTo" value={redirectTo} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground text-sm tabular-nums" aria-live="polite">
          {t("web.packages.count", { count: visible.length })}
        </p>
        <Button
          type="button"
          ref={addButtonRef}
          variant="outline"
          size="sm"
          onClick={() => addRow()}
          disabled={atCap}
        >
          <Plus className="size-4" aria-hidden />
          {t("onboarding.templates.add")}
        </Button>
      </div>

      {atCap && cap !== null && (
        <p className="text-muted-foreground text-sm">
          {t("web.packages.capReached", { max: cap })}{" "}
          <Link
            href="/settings/billing"
            className="text-primary underline-offset-4 hover:underline"
          >
            {t("web.packages.capUpgrade")}
          </Link>
        </p>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon={Package}
          title={t("web.packages.emptyTitle")}
          description={emptyDescription ?? t("web.packages.emptyBody")}
          action={
            <Button type="button" onClick={() => addRow()} disabled={atCap} className="mt-1">
              <Plus className="size-4" aria-hidden />
              {t("web.packages.emptyCta")}
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3">
          {visible.map((row) => (
            <PackageCard
              key={row.localKey}
              row={row}
              currency={currency}
              t={t}
              open={openKeys.has(row.localKey)}
              issue={showErrors ? (issues.get(row.localKey) ?? null) : null}
              status={
                !row.id
                  ? "new"
                  : baselineById.has(row.id) && changedAgainst(row, baselineById.get(row.id)!)
                    ? "edited"
                    : null
              }
              sold={soldByTemplateId?.[row.id] ?? 0}
              payoutCountrySupported={payoutCountrySupported}
              showSubject={showSubject}
              canDuplicate={!atCap}
              onToggle={(open) => setOpen(row.localKey, open)}
              onChange={(patch) => update(row.localKey, patch)}
              onSingleClass={(v) => toggleSingleClass(row.localKey, v)}
              onPrice={(centavos) => setPrice(row.localKey, centavos)}
              onWiseToggle={(v) => toggleWiseDiscount(row.localKey, v)}
              onWisePrice={(centavos) => setWisePrice(row.localKey, centavos)}
              onWiseSuggest={(centavos) => applyWiseTargetSuggestion(row.localKey, centavos)}
              onDuplicate={() => duplicateRow(row)}
              onRemove={() => removeRow(row)}
              toggleRef={(el) => toggleRefs.current.set(row.localKey, el)}
              fieldRef={setFieldRef}
            />
          ))}
        </ul>
      )}

      {removed.length > 0 && (
        <ul className="space-y-2">
          {removed.map((row) => {
            const sold = soldByTemplateId?.[row.id] ?? 0;
            return (
              <li key={row.localKey}>
                <Card className="border-dashed shadow-none">
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-muted-foreground truncate text-sm line-through">
                        {row.name || t("web.packages.untitled")}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {t("web.packages.removed")}
                        {sold > 0 && ` ${t("web.packages.removedSold", { count: sold })}`}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto shrink-0 px-0"
                      ref={(el) => {
                        undoRefs.current.set(row.localKey, el);
                      }}
                      onClick={() => restoreRow(row.localKey)}
                    >
                      {t("web.onboarding.templates.undoRemove")}
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {/* Every row's payload, kept as one ordered block rather than scattered
          through the cards: the action reads index-aligned arrays, so THIS
          list — not the card markup — is the thing that must stay in order. */}
      {rows.map((row) => (
        <div key={`posted-${row.localKey}`} hidden>
          <RowHiddenInputs row={row} currency={currency} />
        </div>
      ))}

      {state?.error && !showErrors && (
        <p
          id="templates-error"
          role="alert"
          aria-live="polite"
          className="text-destructive text-sm"
        >
          {state.error}
        </p>
      )}

      {stickyActions ? (
        showBar && (
          <div
            className="bg-background/95 pb-safe-bottom supports-[backdrop-filter]:bg-background/80 sticky bottom-0 z-20 -mx-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t px-4 py-3 backdrop-blur"
            role="region"
            aria-label={t("settings.templates.title")}
          >
            {status}
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          </div>
        )
      ) : (
        <div className="space-y-2">
          {status}
          <div className="flex flex-wrap gap-2">{actions}</div>
        </div>
      )}
    </form>
  );
}

/** Has this row drifted from what the server last confirmed? Mirrors
 * `pendingPackageChanges`'s notion of "edited" for the per-row chip. */
function changedAgainst(row: PackageRow, original: PackageDraft): boolean {
  return pendingPackageChanges([original], [row]).edited > 0;
}

function PackageCard({
  row,
  currency,
  t,
  open,
  issue,
  status,
  sold,
  payoutCountrySupported,
  showSubject,
  canDuplicate,
  onToggle,
  onChange,
  onSingleClass,
  onPrice,
  onWiseToggle,
  onWisePrice,
  onWiseSuggest,
  onDuplicate,
  onRemove,
  toggleRef,
  fieldRef,
}: {
  row: PackageRow;
  currency: string;
  t: ReturnType<typeof useT>;
  open: boolean;
  issue: PackageRowIssue | null;
  status: "new" | "edited" | null;
  sold: number;
  payoutCountrySupported: boolean;
  showSubject: boolean;
  canDuplicate: boolean;
  onToggle: (open: boolean) => void;
  onChange: (patch: Partial<PackageRow>) => void;
  onSingleClass: (enabled: boolean) => void;
  onPrice: (centavos: number) => void;
  onWiseToggle: (enabled: boolean) => void;
  onWisePrice: (centavos: number) => void;
  onWiseSuggest: (centavos: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  toggleRef: (el: HTMLButtonElement | null) => void;
  fieldRef: (localKey: string, field: string) => (el: HTMLInputElement | null) => void;
}) {
  const key = row.localKey;
  const panelId = `pkg-panel-${key}`;
  const errorId = `pkg-error-${key}`;
  const name = row.name.trim() || t("web.packages.untitled");
  const perClass = pricePerClassMinorUnits(row);
  const step = priceStep(currency);
  const notADiscount = transferPriceIsNotADiscount(row);
  const wiseDiscountEnabled = row.transferPriceMinorUnits !== null;
  const wiseSavings = wiseDiscountEnabled ? row.priceMinorUnits - row.transferPriceMinorUnits! : 0;

  // The collapsed line: what this package IS, in the order a teacher reads it.
  const meta = [
    row.singleClass
      ? t("web.packages.metaClasses", { count: 1 })
      : t("web.packages.metaClasses", { count: row.classCount || 0 }),
    t("web.packages.metaDuration", { minutes: row.classDurationMin || 0 }),
    row.expirationMonths
      ? t("web.packages.metaExpiry", { count: row.expirationMonths })
      : t("web.packages.metaNoExpiry"),
    ...(sold > 0 ? [t("web.packages.metaSold", { count: sold })] : []),
  ].join(" · ");

  return (
    <li>
      <Card className={cn(issue && "border-destructive")}>
        <div className="flex items-start gap-1 p-2 lg:px-3">
          <Button
            type="button"
            variant="ghost"
            ref={toggleRef}
            onClick={() => onToggle(!open)}
            aria-expanded={open}
            aria-controls={panelId}
            // Deliberately no `aria-label`: one would REPLACE the summary as
            // the button's accessible name, and the summary is the content —
            // a screen-reader user would lose the price, the shape and the
            // per-class figure that a sighted reader gets for free.
            className="h-auto min-w-0 flex-1 items-start justify-start gap-3 px-2 py-2 text-left font-normal whitespace-normal"
          >
            <ChevronDown
              className={cn(
                "text-muted-foreground mt-1 size-4 shrink-0 transition-transform",
                open && "rotate-180",
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className={cn(
                    "truncate font-semibold",
                    !row.name.trim() && "text-muted-foreground font-normal italic",
                  )}
                >
                  {name}
                </span>
                {row.subject?.trim() && <Badge variant="outline">{row.subject.trim()}</Badge>}
                {row.singleClass && (
                  <Badge variant="info">{t("web.packages.badgeSingleClass")}</Badge>
                )}
                {status && (
                  <Badge variant={status === "new" ? "success" : "secondary"}>
                    {status === "new"
                      ? t("web.packages.statusNew")
                      : t("web.packages.statusEdited")}
                  </Badge>
                )}
              </span>
              <span className="text-muted-foreground mt-1 block truncate text-xs">{meta}</span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block text-sm font-semibold tabular-nums">
                {formatMinorUnits(row.priceMinorUnits, currency)}
              </span>
              {perClass !== null && (
                <span className="text-muted-foreground block text-xs tabular-nums">
                  {t("web.packages.perClass", { amount: formatMinorUnits(perClass, currency) })}
                </span>
              )}
            </span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive mt-0.5 shrink-0"
            onClick={onRemove}
            aria-label={t("web.packages.removeAria", { name })}
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>

        <div id={panelId} hidden={!open} className="space-y-5 border-t px-4 py-4 lg:px-5">
          <fieldset className="space-y-4">
            <legend className="text-sm font-semibold">{t("web.packages.sectionDetails")}</legend>
            <div className={cn("grid gap-4", showSubject && "sm:grid-cols-2")}>
              <div className="space-y-2">
                <Label htmlFor={`name-${key}`}>{t("common.name")}</Label>
                <Input
                  id={`name-${key}`}
                  ref={fieldRef(key, "name")}
                  value={row.name}
                  maxLength={PACKAGE_NAME_MAX_CHARS}
                  onChange={(e) => onChange({ name: e.target.value })}
                  placeholder={t("web.onboarding.templates.namePlaceholder")}
                  invalid={issue === "name-missing"}
                  aria-describedby={issue === "name-missing" ? errorId : undefined}
                />
                {issue === "name-missing" && (
                  <FieldError id={errorId} message={t(ISSUE_KEY[issue])} />
                )}
              </div>
              {showSubject && (
                <div className="space-y-2">
                  <Label htmlFor={`subject-${key}`}>
                    {t("web.onboarding.templates.subjectLabel")}
                  </Label>
                  <Input
                    id={`subject-${key}`}
                    value={row.subject ?? ""}
                    maxLength={PACKAGE_SUBJECT_MAX_CHARS}
                    onChange={(e) => onChange({ subject: e.target.value || null })}
                    placeholder={t("web.onboarding.templates.subjectPlaceholder")}
                    aria-describedby={`subject-hint-${key}`}
                  />
                  <p id={`subject-hint-${key}`} className="text-muted-foreground text-xs">
                    {t("web.onboarding.templates.subjectHint")}
                  </p>
                </div>
              )}
            </div>

            <div className="bg-muted/30 flex items-start gap-3 rounded-md border p-3">
              <Checkbox
                id={`single-${key}`}
                checked={row.singleClass}
                onCheckedChange={(v) => onSingleClass(v === true)}
                className="mt-0.5"
              />
              <div className="min-w-0 space-y-1">
                <Label htmlFor={`single-${key}`} className="text-sm">
                  {t("onboarding.templates.singleClass")}
                </Label>
                <p className="text-muted-foreground text-xs">
                  {t("onboarding.templates.singleClassHint")}
                </p>
                {/* The one state where "is this one class?" and "does paying
                    reserve the time?" disagree — see class-offering.ts. It is a
                    legitimate thing to sell, but nobody CHOOSES it: it is what
                    you get by setting Classes to 1 and leaving this box alone,
                    so it arrives silently. The live Mexican teacher was in it
                    for the whole life of her page — a package named "Individual
                    class" that sold a credit rather than booking the class.
                    Saying so here is cheaper than her finding out from a
                    student. */}
                {isOneClassSoldAsCredit(row) && (
                  <p className="text-warning text-xs">
                    {t("onboarding.templates.oneClassAsCreditHint")}
                  </p>
                )}
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-4 border-t pt-4">
            <legend className="text-sm font-semibold">{t("web.packages.sectionSize")}</legend>
            {/* Two fields when the class count is pinned to 1, three when she
                sizes the package herself — so the row never leaves a gap where
                a control she cannot reach used to be. */}
            <div
              className={cn("grid gap-4", row.singleClass ? "sm:grid-cols-2" : "sm:grid-cols-3")}
            >
              {!row.singleClass && (
                <div className="space-y-2">
                  <Label htmlFor={`count-${key}`}>{t("onboarding.templates.classes")}</Label>
                  <Input
                    id={`count-${key}`}
                    ref={fieldRef(key, "count")}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={row.classCount || ""}
                    onChange={(e) => onChange({ classCount: Number(e.target.value) })}
                    invalid={issue === "class-count"}
                    aria-describedby={issue === "class-count" ? errorId : undefined}
                  />
                  {issue === "class-count" && (
                    <FieldError id={errorId} message={t(ISSUE_KEY[issue])} />
                  )}
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor={`duration-${key}`}>{t("onboarding.templates.duration")}</Label>
                <Input
                  id={`duration-${key}`}
                  ref={fieldRef(key, "duration")}
                  type="number"
                  inputMode="numeric"
                  min={5}
                  step={5}
                  value={row.classDurationMin || ""}
                  onChange={(e) => onChange({ classDurationMin: Number(e.target.value) })}
                  invalid={issue === "duration"}
                  aria-describedby={issue === "duration" ? errorId : undefined}
                />
                {issue === "duration" && <FieldError id={errorId} message={t(ISSUE_KEY[issue])} />}
              </div>
              <div className="space-y-2">
                <Label htmlFor={`expiration-${key}`}>
                  {t("onboarding.templates.expirationMonths")}
                </Label>
                <Input
                  id={`expiration-${key}`}
                  ref={fieldRef(key, "expiration")}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={row.expirationMonths ?? ""}
                  onChange={(e) =>
                    onChange({ expirationMonths: e.target.value ? Number(e.target.value) : null })
                  }
                  invalid={issue === "expiration-missing"}
                  aria-describedby={issue === "expiration-missing" ? errorId : undefined}
                />
                {issue === "expiration-missing" && (
                  <FieldError id={errorId} message={t(ISSUE_KEY[issue])} />
                )}
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-4 border-t pt-4">
            <legend className="text-sm font-semibold">{t("web.packages.sectionPrice")}</legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`price-${key}`}>
                  {t(
                    payoutCountrySupported
                      ? "onboarding.templates.priceStripe"
                      : "onboarding.templates.price",
                  )}
                </Label>
                <MoneyInput
                  id={`price-${key}`}
                  inputRef={fieldRef(key, "price")}
                  currency={currency}
                  step={step}
                  // Render a falsy 0 as an empty string so the field can be
                  // cleared before typing a fresh number — otherwise the
                  // controlled value snaps back to "0" and the teacher has to
                  // type e.g. "010" and delete the leading zero.
                  value={minorUnitsToMajor(row.priceMinorUnits, currency) || ""}
                  onValueChange={(major) => onPrice(majorToMinorUnits(major, currency))}
                  invalid={issue === "price-negative"}
                  describedBy={issue === "price-negative" ? errorId : `price-hint-${key}`}
                />
                {issue === "price-negative" ? (
                  <FieldError id={errorId} message={t(ISSUE_KEY[issue])} />
                ) : (
                  <p id={`price-hint-${key}`} className="text-muted-foreground text-xs">
                    {t("onboarding.templates.priceHint", { currency })}
                    {perClass !== null &&
                      ` ${t("web.packages.perClass", {
                        amount: formatMinorUnits(perClass, currency),
                      })}`}
                  </p>
                )}
              </div>
            </div>

            {payoutCountrySupported && (
              <div className="bg-muted/30 space-y-3 rounded-md border p-3">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id={`wise-discount-${key}`}
                    checked={wiseDiscountEnabled}
                    onCheckedChange={(v) => onWiseToggle(v === true)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor={`wise-discount-${key}`} className="text-sm">
                      {t("onboarding.templates.wiseDiscountLabel")}
                    </Label>
                    {/* D-152: the rate comes from the same constant that sizes
                        the discount, so the number in the sentence can never
                        drift from the arithmetic — and the copy attributes it
                        to US as an estimate, not to Stripe as its rate. */}
                    <p className="text-muted-foreground text-xs">
                      {t("onboarding.templates.wiseDiscountHint", {
                        rate: stripeWorstCaseRatePercent(),
                      })}
                    </p>
                  </div>
                </div>
                {wiseDiscountEnabled && row.transferPriceMinorUnits !== null && (
                  <div className="space-y-3 sm:pl-7">
                    <div className="space-y-2">
                      <Label htmlFor={`wise-price-${key}`} className="text-xs">
                        {t("onboarding.templates.priceWise")}
                      </Label>
                      <div className="flex flex-wrap items-center gap-3">
                        <MoneyInput
                          id={`wise-price-${key}`}
                          currency={currency}
                          step={step}
                          value={minorUnitsToMajor(row.transferPriceMinorUnits, currency)}
                          onValueChange={(major) => onWisePrice(majorToMinorUnits(major, currency))}
                          invalid={notADiscount}
                          describedBy={notADiscount ? `wise-warn-${key}` : undefined}
                          className="w-44 max-w-full"
                        />
                        {wiseSavings > 0 && (
                          <span className="text-success text-xs tabular-nums">
                            {t("onboarding.templates.wiseSavings", {
                              amount: formatMinorUnits(wiseSavings, currency),
                            })}
                          </span>
                        )}
                      </div>
                      {notADiscount && (
                        <p id={`wise-warn-${key}`} className="text-warning text-xs">
                          {t("web.packages.warnTransferNotDiscount")}
                        </p>
                      )}
                    </div>
                    <WisePriceCalculator onApply={onWiseSuggest} />
                  </div>
                )}
              </div>
            )}
          </fieldset>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onDuplicate}
              disabled={!canDuplicate}
              aria-label={t("web.packages.duplicateAria", { name })}
            >
              <Copy className="size-4" aria-hidden />
              {t("web.packages.duplicate")}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => onToggle(false)}>
              {t("web.packages.done")}
            </Button>
          </div>
        </div>
      </Card>
    </li>
  );
}

/**
 * A price field that says what currency it is in.
 *
 * The code sits inside the field rather than in the label because the teacher
 * reads it while typing the number, and it is `aria-hidden`: the label and the
 * hint under the field already name the currency, and a screen reader
 * announcing "GBP" between the label and the value would be the third time.
 */
function MoneyInput({
  id,
  inputRef,
  currency,
  step,
  value,
  onValueChange,
  invalid,
  describedBy,
  className,
}: {
  id?: string;
  inputRef?: (el: HTMLInputElement | null) => void;
  currency: string;
  step: number;
  value: number | string;
  onValueChange: (major: number) => void;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Input
        id={id}
        ref={inputRef}
        type="number"
        inputMode="decimal"
        min={0}
        step={step}
        value={value}
        onChange={(e) => onValueChange(Number(e.target.value))}
        invalid={invalid}
        aria-describedby={describedBy}
        className="pr-14"
      />
      <span
        aria-hidden
        className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-medium"
      >
        {currency}
      </span>
    </div>
  );
}

function WisePriceCalculator({
  onApply,
  disabled,
}: {
  onApply: (centavos: number) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const currency = usePricingCurrency();
  const [target, setTarget] = useState<string>("");
  const targetPesos = Number(target);
  const canApply = !disabled && Number.isFinite(targetPesos) && targetPesos > 0;
  return (
    <details className="text-xs">
      <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring cursor-pointer rounded-sm focus-visible:ring-3 focus-visible:outline-hidden">
        {t("onboarding.templates.wiseCalculatorToggle")}
      </summary>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="space-y-2">
          <Label htmlFor="wise-calc-target" className="text-xs">
            {t("onboarding.templates.wiseCalculatorLabel", { currency })}
          </Label>
          <Input
            id="wise-calc-target"
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            disabled={disabled}
            className="w-36 max-w-full"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canApply}
          onClick={() => {
            onApply(majorToMinorUnits(targetPesos, currency));
            setTarget("");
          }}
        >
          {t("onboarding.templates.wiseCalculatorButton")}
        </Button>
      </div>
      <p className="text-muted-foreground mt-2">{t("onboarding.templates.wiseCalculatorHint")}</p>
    </details>
  );
}
