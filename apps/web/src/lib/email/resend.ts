// Resend client. Used for notification email. Same factory shape as
// the other integrations: real HTTP client when RESEND_API_KEY is set,
// in-memory stub otherwise.

export type SendEmailInput = {
  to: string;
  subject: string;
  body: string; // plain text
  html?: string; // branded HTML body (see lib/email/html-shell.ts)
  // Monitored reply-to. The default `from` is a no-reply subdomain address,
  // so without this a teacher replying to (say) an account-disabled notice
  // hits a black hole. Forwarded to Resend's `reply_to`.
  replyTo?: string;
  // Extra SMTP headers — used for RFC 8058 List-Unsubscribe / one-click POST so
  // Gmail/Yahoo bulk-sender requirements are met and inbox placement holds.
  headers?: Record<string, string>;
};

export type SendEmailFailure = {
  ok: false;
  // The provider's own words, including its response body. Useful in a log
  // line; NOT something an alert can be read from — Sentry's server-side
  // scrubber replaces `extra` values with "[Filtered]" on this project, which
  // is why AGENDAPROFE-1V sat unresolved for seven weeks saying only that a
  // send had failed.
  error: string;
  // The same failure, classified down to a handful of stable values —
  // "resend-403", "ses-500", "network", "unparseable", "missing-id". Low
  // cardinality, so it is safe as a Sentry tag and as a grouping key, and it
  // survives to the place someone actually reads. Callers that report a send
  // failure should report THIS, and keep `error` as detail.
  code: string;
  retryable: boolean;
};

export type SendEmailResult = { ok: true; providerMessageId: string } | SendEmailFailure;

export type EmailClient = {
  send(input: SendEmailInput): Promise<SendEmailResult>;
};

export type FetchResendClientConfig = {
  apiKey: string;
  fromAddress: string;
  fetchImpl?: typeof fetch;
};

export function fetchResendClient(config: FetchResendClientConfig): EmailClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    async send(input): Promise<SendEmailResult> {
      let res: Response;
      try {
        res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: config.fromAddress,
            to: input.to,
            subject: input.subject,
            text: input.body,
            ...(input.html ? { html: input.html } : {}),
            ...(input.replyTo ? { reply_to: input.replyTo } : {}),
            ...(input.headers ? { headers: input.headers } : {}),
          }),
        });
      } catch (err) {
        return {
          ok: false,
          error: `network: ${err instanceof Error ? err.message : String(err)}`,
          code: "network",
          retryable: true,
        };
      }
      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          error: `resend-${res.status}: ${text.slice(0, 500)}`,
          code: `resend-${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      }
      try {
        const parsed = JSON.parse(text) as { id?: string };
        if (!parsed.id) {
          return {
            ok: false,
            error: `missing id: ${text.slice(0, 200)}`,
            code: "missing-id",
            retryable: false,
          };
        }
        return { ok: true, providerMessageId: parsed.id };
      } catch {
        return {
          ok: false,
          error: `unparseable: ${text.slice(0, 200)}`,
          code: "unparseable",
          retryable: false,
        };
      }
    },
  };
}

export type RecordedEmail = SendEmailInput & {
  providerMessageId: string;
  at: Date;
};

export type StubEmailClient = EmailClient & {
  getSends(): RecordedEmail[];
  reset(): void;
  failNext(error: string, retryable: boolean, code?: string): void;
};

// A developer running `next dev` with no RESEND_API_KEY / SES_* gets the stub,
// which used to swallow every message in silence. That made local sign-in
// impossible rather than merely degraded: the whole auth rail is a one-time
// code delivered by email, so with nowhere to read it there is no way into the
// app at all. Printing the body to the server console is the smallest thing
// that makes a fresh clone usable.
//
// Guarded on "development" specifically, not on `!== "production"`: the unit
// and integration suites run under NODE_ENV=test and send thousands of stub
// emails, and they assert on getSends(), not on stdout.
function logStubEmail(input: SendEmailInput): void {
  if (process.env.NODE_ENV !== "development") return;
  console.info(
    [
      "",
      "--- email (no provider configured; not sent) ---",
      `to:      ${input.to}`,
      `subject: ${input.subject}`,
      "",
      input.body,
      "--- end email ---",
      "",
    ].join("\n"),
  );
}

export function createStubEmailClient(): StubEmailClient {
  const sends: RecordedEmail[] = [];
  let seq = 1;
  let nextFailure: { error: string; retryable: boolean; code: string } | null = null;

  return {
    async send(input): Promise<SendEmailResult> {
      if (nextFailure) {
        const f = nextFailure;
        nextFailure = null;
        return { ok: false, error: f.error, code: f.code, retryable: f.retryable };
      }
      const providerMessageId = `email-stub-${seq++}`;
      sends.push({ ...input, providerMessageId, at: new Date() });
      logStubEmail(input);
      return { ok: true, providerMessageId };
    },
    getSends() {
      return [...sends];
    },
    reset() {
      sends.length = 0;
      seq = 1;
      nextFailure = null;
    },
    failNext(error, retryable, code = "stub") {
      nextFailure = { error, retryable, code };
    },
  };
}
