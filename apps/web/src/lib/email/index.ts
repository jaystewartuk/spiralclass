import { hasResendCreds, hasSesCreds, serverEnv } from "@/lib/env";
import { createStubEmailClient, fetchResendClient, type EmailClient } from "./resend";
import { fetchSesClient } from "./ses";
import { logger } from "@/lib/logger";

const log = logger({ surface: "email" });

let cached: EmailClient | null = null;
let cachedKind: "stub" | "resend" | "ses" | null = null;

const FALLBACK_FROM = "SpiralClass <no-reply@updates.spiralclass.com>";

// SES is metered with no monthly floor (unlike Resend's flat-fee tiers), so
// it's preferred when both are configured. EMAIL_PROVIDER forces a specific
// one — e.g. to roll back to Resend without unsetting the SES creds.
export function getEmailClient(): EmailClient {
  if (cached) return cached;
  const env = serverEnv();
  const wantSes = env.EMAIL_PROVIDER ? env.EMAIL_PROVIDER === "ses" : hasSesCreds();

  if (wantSes && hasSesCreds()) {
    cached = fetchSesClient({
      region: env.SES_REGION!,
      accessKeyId: env.SES_ACCESS_KEY_ID!,
      secretAccessKey: env.SES_SECRET_ACCESS_KEY!,
      fromAddress: env.SES_FROM ?? env.RESEND_FROM ?? "no-reply@updates.spiralclass.com",
    });
    cachedKind = "ses";
  } else if (hasResendCreds()) {
    const fromAddress = env.RESEND_FROM ? `SpiralClass <${env.RESEND_FROM}>` : FALLBACK_FROM;
    cached = fetchResendClient({
      apiKey: env.RESEND_API_KEY!,
      fromAddress,
    });
    cachedKind = "resend";
  } else {
    cached = createStubEmailClient();
    cachedKind = "stub";
    if (env.NODE_ENV === "production") {
      log.warn("FATAL: no email provider configured in production; falling back to stub.");
    }
  }
  return cached;
}

export function getEmailClientKind(): "stub" | "resend" | "ses" | null {
  if (!cached) getEmailClient();
  return cachedKind;
}

export function __resetEmailClient() {
  cached = null;
  cachedKind = null;
}

export type { EmailClient } from "./resend";
