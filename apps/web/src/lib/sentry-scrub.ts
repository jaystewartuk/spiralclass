import type { ErrorEvent } from "@sentry/nextjs";

// PII scrubber for Sentry `beforeSend`. Two passes:
//
// 1. Wholesale-redact values under known PII keys anywhere in the
//    event tree (request body, extra, contexts, breadcrumb data).
// 2. Regex-scrub free-text strings (messages, exception values, URL
//    query strings) for stray emails, phone numbers, and bank account
//    identifiers that may have been concatenated into log lines.
//
// Trade-off: regex scrubbing is lossy — a stack frame referencing
// `user@example.com` becomes `[redacted-email]`. That's acceptable.
// Sentry still receives enough context (type, message shape, stack)
// to be useful without leaking subject identity into the SaaS.

const PII_KEYS = new Set([
  "email",
  "phone",
  "phoneNumber",
  "phoneE164",
  "phone_e164",
  "publicWhatsappE164",
  "public_whatsapp_e164",
  // Bank account identifiers. `details` is the whole payee blob on a
  // `teacher_payout_instruments` row (D-124) — since the fields inside it are
  // per-country and open-ended, the only safe rule is to redact the container
  // rather than enumerate what might be in it. The named keys below stay
  // because they also appear on their own, outside a `details` object.
  "details",
  "clabe",
  "iban",
  "accountNumber",
  "account_number",
  "routingNumber",
  "routing_number",
  "sortCode",
  "sort_code",
  "cbu",
  "cci",
  "pixKey",
  "pix_key",
  "rut",
  "ifsc",
  "password",
  "newPassword",
  "currentPassword",
  "token",
  "tokenHash",
  "token_hash",
  "authToken",
  "accessToken",
  "refreshToken",
  "sessionToken",
  "fullName",
  "name",
  "studentName",
  "teacherName",
  "address",
]);

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Loose E.164: optional +, 10–15 digits. Catches Mexican +52 numbers
// and bare 10-digit numbers in log lines.
const PHONE_RE = /\+?\d{10,15}/g;
// Bank account numbers concatenated into a free-text log line. Two shapes,
// because D-124 opened the payout rail past Mexico:
//   * a bare run of 15-22 digits — a CLABE (18), a CBU (22), a CCI (20), and
//     the long domestic account numbers either side of them. The lower bound
//     is 15 rather than 18 so a Peruvian or Nigerian account in a log line is
//     caught too; PHONE_RE already covers 10-15, so nothing is left uncovered
//     between them.
//   * an IBAN — two letters, two check digits, then 11-30 alphanumerics.
//     Matched explicitly because it is not all digits and the numeric rule
//     would miss it entirely.
const BANK_NUMBER_RE = /(?<!\d)\d{15,22}(?!\d)/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;

function scrubString(value: string): string {
  return (
    value
      .replace(EMAIL_RE, "[redacted-email]")
      // IBAN before the numeric rule: an IBAN's trailing digits would otherwise
      // be eaten by BANK_NUMBER_RE, leaving its country and bank prefix behind.
      .replace(IBAN_RE, "[redacted-bank-account]")
      .replace(BANK_NUMBER_RE, "[redacted-bank-account]")
      .replace(PHONE_RE, "[redacted-phone]")
  );
}

function walk(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (value == null) return value;
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEYS.has(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = walk(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  // Top-level scalar strings worth scrubbing.
  if (event.message) event.message = scrubString(event.message);

  // Exception values (stack-trace messages).
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) ex.value = scrubString(ex.value);
    }
  }

  // Request — most PII lives here (body, query, headers).
  if (event.request) {
    event.request = walk(event.request) as typeof event.request;
  }

  // Extra + contexts can contain arbitrary debug payloads.
  if (event.extra) event.extra = walk(event.extra) as typeof event.extra;
  if (event.contexts) event.contexts = walk(event.contexts) as typeof event.contexts;

  // Breadcrumbs are the noisiest source of accidental PII leaks
  // (logged URLs, fetch bodies, console-log breadcrumbs).
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((b) => ({
      ...b,
      message: b.message ? scrubString(b.message) : b.message,
      data: b.data ? (walk(b.data) as typeof b.data) : b.data,
    }));
  }

  // Keep the auth user id (useful for incident triage) but drop email.
  if (event.user) {
    const { id, ip_address } = event.user;
    event.user = { id, ip_address };
  }

  return event;
}
