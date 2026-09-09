import { describe, it, expect } from "vitest";
import {
  PAYOUT_INSTRUMENT_KINDS,
  hasOfferableInstrument,
  instrumentSupportsCurrency,
  isInstrumentOfferable,
  isInstrumentReady,
  isPayoutInstrumentKind,
  isValidWiseHandle,
  railForKind,
  sortInstruments,
  supportsAutoReconcile,
  type InstrumentReadiness,
} from "./payout-instruments";

const wise = (over: Partial<InstrumentReadiness> = {}): InstrumentReadiness => ({
  kind: "wise",
  enabled: true,
  wiseHandle: "anal3829",
  ...over,
});

describe("kind union", () => {
  it("is closed to wise alone since D-145", () => {
    // D-113 shipped three kinds and D-124 folded them to two. `bank_account`
    // is gone because Stripe now presents the teacher's own country's bank
    // transfer with automatic reconciliation, which a self-attested one never
    // could — it had become the strictly worse copy, offered beside it.
    expect(PAYOUT_INSTRUMENT_KINDS).toEqual(["wise"]);
  });

  it("guards unknown values, including the kind that was removed", () => {
    expect(isPayoutInstrumentKind("wise")).toBe(true);
    // Rows carrying the old kind cannot exist (the migration deleted them and
    // the Postgres enum no longer has the value), but a stale client
    // could still send the string — it must not be accepted back in.
    expect(isPayoutInstrumentKind("bank_account")).toBe(false);
    expect(isPayoutInstrumentKind("spei")).toBe(false);
    expect(isPayoutInstrumentKind("")).toBe(false);
    expect(isPayoutInstrumentKind(null)).toBe(false);
  });
});

describe("per-kind capabilities", () => {
  it("Wise auto-reconciles — the reason it survived D-145", () => {
    expect(supportsAutoReconcile("wise")).toBe(true);
  });

  it("still reports the wise analytics rail", () => {
    // PaymentRail keeps `bank_transfer` for rows written before D-145. Nothing
    // emits it now; nothing may reinterpret those rows either.
    expect(railForKind("wise")).toBe("wise");
  });
});

describe("currency capability", () => {
  it("leaves Wise multi-currency", () => {
    // The removed domestic schemes were single-currency (SPEI moves MXN and
    // only MXN), which is what made this question load-bearing. Wise has no
    // such limit, so the answer is now always yes — but it is still asked.
    expect(instrumentSupportsCurrency({ kind: "wise" }, "MXN")).toBe(true);
    expect(instrumentSupportsCurrency({ kind: "wise" }, "GBP")).toBe(true);
    expect(instrumentSupportsCurrency({ kind: "wise" }, "JPY")).toBe(true);
  });
});

describe("Wisetag", () => {
  it("accepts the documented handle shape", () => {
    expect(isValidWiseHandle("anal3829")).toBe(true);
    expect(isValidWiseHandle("a.b_c-d")).toBe(true);
    // Trimmed before matching, so surrounding whitespace is accepted — a
    // teacher pasting from the Wise app brings it with her.
    expect(isValidWiseHandle("  anal3829  ")).toBe(true);
  });

  it("rejects too short, too long, and illegal characters", () => {
    expect(isValidWiseHandle("a")).toBe(false);
    expect(isValidWiseHandle("x".repeat(33))).toBe(false);
    expect(isValidWiseHandle("has space")).toBe(false);
    expect(isValidWiseHandle("emoji🙂")).toBe(false);
  });
});

describe("isInstrumentReady", () => {
  it("is ready when enabled and the handle is present", () => {
    expect(isInstrumentReady(wise())).toBe(true);
  });

  it("is not ready when disabled, even with a handle on file", () => {
    // Pausing an instrument must not lose the details — that is the whole
    // point of the per-instrument `enabled` flag.
    expect(isInstrumentReady(wise({ enabled: false }))).toBe(false);
  });

  it("is not ready when the handle is missing", () => {
    expect(isInstrumentReady(wise({ wiseHandle: null }))).toBe(false);
    expect(isInstrumentReady(wise({ wiseHandle: "" }))).toBe(false);
  });
});

describe("offerability", () => {
  it("requires both readiness and a compatible currency", () => {
    expect(isInstrumentOfferable(wise(), "MXN")).toBe(true);
    expect(isInstrumentOfferable(wise({ enabled: false }), "MXN")).toBe(false);
  });

  it("reports whether the teacher can take any manual transfer at all", () => {
    expect(hasOfferableInstrument([wise()], "MXN")).toBe(true);
    expect(hasOfferableInstrument([wise({ wiseHandle: null })], "MXN")).toBe(false);
    // A teacher with no instrument at all is the Stripe-only case, which is
    // now the expected shape rather than an error.
    expect(hasOfferableInstrument([], "MXN")).toBe(false);
  });
});

describe("sortInstruments", () => {
  it("does not mutate its input", () => {
    const input = [wise()];
    const sorted = sortInstruments(input);
    expect(sorted).not.toBe(input);
    expect(input).toHaveLength(1);
  });

  it("is stable with the single remaining kind", () => {
    const a = { kind: "wise" as const, id: "a" };
    const b = { kind: "wise" as const, id: "b" };
    expect(sortInstruments([a, b]).map((i) => i.id)).toEqual(["a", "b"]);
  });
});
