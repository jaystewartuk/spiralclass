import { createSign, generateKeyPairSync } from "node:crypto";
import { DEFAULT_PRICING_CURRENCY, majorToMinorUnits } from "@spiralclass/shared";
import { serverEnv } from "@/lib/env";
import { decryptField } from "@/lib/crypto/field-encryption";

// Wise Platform API client — read-only, scoped to one job: pull incoming
// credits off a teacher's Wise Business balance statement so the reconciler
// (src/lib/payments/wise-reconcile.ts) can match them to that teacher's
// pending payments. There is NO Wise endpoint to create payment links or
// fixed requests (confirmed against docs.wise.com/api-reference), so the
// *send* side stays as prefilled Quick-Pay URLs; this module is purely the
// "did the money land?" half.
//
// Account model: PER-TEACHER. Each opted-in teacher connects their own Wise
// Business profile (token + profile id + an SCA signing keypair stored on
// the Teacher row). Money never funnels through a shared account — the
// poller builds one client per teacher and only ever reads that teacher's
// statement, in THAT teacher's own pricing currency (Teacher.pricingCurrency,
// D-64) — a non-MXN-priced teacher's Wise balance is never in MXN, so
// reconciliation must pull the balance matching their own currency, not a
// platform-wide one. Only the base URL is a platform-wide env; everything
// else (secrets + currency) is per-teacher.
//
// SCA: balance-statement reads are Strong-Customer-Authentication protected.
// The first GET returns 403 with an `x-2fa-approval` one-time-token; we sign
// that token with the teacher's RSA private key and replay the request with
// the signature. See `signedFetch` below and:
//   https://docs.wise.com/api-docs/features/strong-customer-authentication-2fa

const DEFAULT_BASE = "https://api.transferwise.com";

// Column names used for field-encryption subkey derivation. Exported so the
// write path (src/lib/wise/credentials.ts) encrypts under the exact same
// per-column subkey the reader decrypts with.
export const WISE_TOKEN_COLUMN = "wiseApiTokenEnc";
export const WISE_KEY_COLUMN = "wiseApiKeyEnc";

export type WiseCredit = {
  // Wise's own reference for the line (referenceNumber) — used for logs and
  // de-dup, never shown to users.
  externalId: string;
  // Best-effort payment reference text pulled from the statement line. The
  // student-pasted "AGP-XXXXXXXX" token may live in `paymentReference` or be
  // embedded in the free-text description; we surface the raw string and let
  // the matcher normalize + extract.
  reference: string | null;
  amountMinorUnits: number;
  currency: string;
  occurredAt: Date;
};

export type WiseClient = {
  fetchIncomingCredits(input: { since: Date; until?: Date }): Promise<WiseCredit[]>;
};

type WiseApiConfig = {
  token: string;
  profileId: string;
  privateKeyPem: string;
  base: string;
  currency: string;
};

// The per-teacher credential columns the reconciler selects off the Teacher
// row. The instrument's own `enabled` flag gates participation even when
// creds are on file; the reconciler's query filters on it (D-113).
// `pricingCurrency` picks which of the teacher's Wise balances to read
// statement lines from — a teacher priced in COP has no MXN balance to poll.
export type TeacherWiseCreds = {
  wiseApiProfileId: string | null;
  wiseApiTokenEnc: string | null;
  wiseApiKeyEnc: string | null;
  pricingCurrency: string;
};

function platformBase(): string {
  return (serverEnv().WISE_API_BASE ?? DEFAULT_BASE).replace(/\/$/, "");
}

// Decrypts a field-encrypted column value. When FIELD_ENCRYPTION_KEY is
// unset (or the value was stored before encryption was enabled), the value
// is plaintext and `decryptField` returns null — fall back to the raw value
// so the additive-migration path works, matching the field-encryption
// module's documented contract.
function readSecret(column: string, stored: string): string {
  return decryptField(column, stored) ?? stored;
}

// Builds a Wise client for a single teacher, or null when the teacher isn't
// fully connected (creds missing or Wise paused). The reconciler calls this
// per teacher so a misconfigured teacher is skipped, not fatal.
export function wiseClientForTeacher(creds: TeacherWiseCreds): WiseClient | null {
  if (!creds.wiseApiProfileId || !creds.wiseApiTokenEnc || !creds.wiseApiKeyEnc) {
    return null;
  }
  const config: WiseApiConfig = {
    token: readSecret(WISE_TOKEN_COLUMN, creds.wiseApiTokenEnc),
    profileId: creds.wiseApiProfileId,
    // `\n`-escaped single-line PEMs (e.g. pasted via an env/script) are
    // restored; a real multi-line block passes through unchanged.
    privateKeyPem: readSecret(WISE_KEY_COLUMN, creds.wiseApiKeyEnc).replace(/\\n/g, "\n"),
    base: platformBase(),
    currency: (creds.pricingCurrency || DEFAULT_PRICING_CURRENCY).toUpperCase(),
  };
  return makeWiseClient(config);
}

// Generates an RSA keypair for a teacher's Wise SCA signing. We keep the
// private key (encrypted, on the Teacher row); the teacher uploads the
// public key under Wise → Settings → API tokens. Run from a setup script
// or admin action when connecting a teacher.
export function generateWiseSigningKeypair(): {
  publicKeyPem: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

function makeWiseClient(config: WiseApiConfig): WiseClient {
  let cachedBalanceId: number | null = null;

  async function resolveBalanceId(): Promise<number> {
    if (cachedBalanceId !== null) return cachedBalanceId;
    const url = `${config.base}/v4/profiles/${config.profileId}/balances?types=STANDARD`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    if (!res.ok) {
      throw new WiseApiError(`balances lookup failed (${res.status})`, res.status);
    }
    const balances = (await res.json()) as Array<{
      id: number;
      currency: string;
    }>;
    const match = balances.find((b) => b.currency?.toUpperCase() === config.currency);
    if (!match) {
      throw new WiseApiError(`no ${config.currency} balance on profile ${config.profileId}`, 404);
    }
    cachedBalanceId = match.id;
    return match.id;
  }

  async function fetchIncomingCredits(input: { since: Date; until?: Date }): Promise<WiseCredit[]> {
    const balanceId = await resolveBalanceId();
    const intervalEnd = input.until ?? new Date();
    const params = new URLSearchParams({
      currency: config.currency,
      intervalStart: input.since.toISOString(),
      intervalEnd: intervalEnd.toISOString(),
      type: "COMPACT",
    });
    const url = `${config.base}/v1/profiles/${config.profileId}/balance-statements/${balanceId}/statement.json?${params.toString()}`;
    const res = await signedFetch(url, config);
    if (!res.ok) {
      throw new WiseApiError(`statement fetch failed (${res.status})`, res.status);
    }
    const json = (await res.json()) as StatementResponse;
    return parseStatementCredits(json);
  }

  return { fetchIncomingCredits };
}

export class WiseApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "WiseApiError";
    this.status = status;
  }
}

// Performs an SCA-aware GET. On the 403 + `x-2fa-approval` challenge we sign
// the one-time-token and replay once. Any other non-ok status is returned
// to the caller to handle.
async function signedFetch(url: string, config: WiseApiConfig): Promise<Response> {
  const first = await fetch(url, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (first.status !== 403) return first;

  const oneTimeToken = first.headers.get("x-2fa-approval");
  if (!oneTimeToken) return first; // genuine 403, not an SCA challenge

  const signature = signToken(oneTimeToken, config.privateKeyPem);
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${config.token}`,
      "x-2fa-approval": oneTimeToken,
      "X-Signature": signature,
    },
  });
}

// SHA256withRSA over the raw one-time-token, base64-encoded — the exact
// scheme Wise expects for the `X-Signature` header.
export function signToken(oneTimeToken: string, privateKeyPem: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(oneTimeToken);
  signer.end();
  return signer.sign(privateKeyPem, "base64");
}

type StatementResponse = {
  transactions?: Array<{
    type?: string;
    date?: string;
    amount?: { value?: number; currency?: string };
    referenceNumber?: string;
    details?: {
      paymentReference?: string;
      description?: string;
    };
  }>;
};

// Pure: extracts incoming CREDIT lines from a Wise statement payload and
// normalizes them to `WiseCredit`. Exported for unit testing against
// fixtures (no network). Skips non-credits, zero/negative amounts, and lines
// we can't date.
export function parseStatementCredits(json: StatementResponse): WiseCredit[] {
  const out: WiseCredit[] = [];
  for (const tx of json.transactions ?? []) {
    if ((tx.type ?? "").toUpperCase() !== "CREDIT") continue;
    const value = tx.amount?.value;
    if (typeof value !== "number" || value <= 0) continue;
    const dateStr = tx.date;
    if (!dateStr) continue;
    const occurredAt = new Date(dateStr);
    if (Number.isNaN(occurredAt.getTime())) continue;

    const reference =
      tx.details?.paymentReference?.trim() || tx.details?.description?.trim() || null;

    const currency = (tx.amount?.currency ?? "").toUpperCase();
    out.push({
      externalId: tx.referenceNumber ?? `${dateStr}:${value}`,
      reference: reference && reference.length > 0 ? reference : null,
      // Wise statement amounts are decimal major units; convert to minor units
      // using the credit's own currency exponent (0-decimal currencies like JPY
      // must not be multiplied by 100).
      amountMinorUnits: majorToMinorUnits(value, currency),
      currency,
      occurredAt,
    });
  }
  return out;
}
