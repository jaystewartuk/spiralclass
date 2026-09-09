// Amazon SES client (SESv2 SendEmail, Raw content). Same EmailClient shape as
// resend.ts — real SigV4-signed HTTP client when SES creds are set, so
// getEmailClient() can swap providers without touching any call site.
//
// Raw (MIME) content, not Simple, because Simple has no way to attach the
// List-Unsubscribe / List-Unsubscribe-Post headers callers rely on for RFC
// 8058 one-click unsubscribe (see resend.ts's `headers` field).
//
// Signing uses aws4fetch (a small, dependency-free SigV4 signer) instead of
// the full AWS SDK — this is a single POST to one REST endpoint, not worth
// the SDK's bundle size.

import { AwsClient } from "aws4fetch";
import type { EmailClient, SendEmailInput, SendEmailResult } from "./resend";

export type FetchSesClientConfig = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  fromAddress: string;
  fetchImpl?: typeof fetch;
};

function mimeHeaderEscape(value: string): string {
  // Header values are user/system-controlled subjects and addresses, not
  // free text — strip CR/LF so nothing can inject an extra MIME header.
  return value.replace(/[\r\n]+/g, " ");
}

function buildRawMessage(input: SendEmailInput, fromAddress: string): string {
  const boundary = `----spiralclass-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const headers = [
    `From: ${mimeHeaderEscape(fromAddress)}`,
    `To: ${mimeHeaderEscape(input.to)}`,
    `Subject: ${mimeHeaderEscape(input.subject)}`,
    "MIME-Version: 1.0",
  ];
  if (input.replyTo) headers.push(`Reply-To: ${mimeHeaderEscape(input.replyTo)}`);
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    headers.push(`${mimeHeaderEscape(key)}: ${mimeHeaderEscape(value)}`);
  }

  if (!input.html) {
    headers.push("Content-Type: text/plain; charset=UTF-8");
    return `${headers.join("\r\n")}\r\n\r\n${input.body}`;
  }

  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    input.body,
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "",
    input.html,
    `--${boundary}--`,
  ].join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${parts}`;
}

export function fetchSesClient(config: FetchSesClientConfig): EmailClient {
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "ses",
    region: config.region,
  });
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = `https://email.${config.region}.amazonaws.com/v2/email/outbound-emails`;

  return {
    async send(input): Promise<SendEmailResult> {
      const raw = buildRawMessage(input, config.fromAddress);
      const body = JSON.stringify({
        FromEmailAddress: config.fromAddress,
        Destination: { ToAddresses: [input.to] },
        Content: { Raw: { Data: Buffer.from(raw, "utf-8").toString("base64") } },
      });

      let res: Response;
      try {
        const signed = await aws.sign(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        res = await fetchImpl(signed);
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
          error: `ses-${res.status}: ${text.slice(0, 500)}`,
          code: `ses-${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      }
      try {
        const parsed = JSON.parse(text) as { MessageId?: string };
        if (!parsed.MessageId) {
          return {
            ok: false,
            error: `missing MessageId: ${text.slice(0, 200)}`,
            code: "missing-id",
            retryable: false,
          };
        }
        return { ok: true, providerMessageId: parsed.MessageId };
      } catch {
        return {
          ok: false,
          error: `unparseable: ${text.slice(0, 200)}`,
          code: "unparseable",
          retryable: false,
        };
      }
    },
  } satisfies EmailClient;
}
