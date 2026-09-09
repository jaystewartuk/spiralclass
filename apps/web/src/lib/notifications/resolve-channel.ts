// Channel resolution. Pure function — testable across the full eligibility
// matrix. Returns ALL channels the recipient is eligible for, in dispatch order
// (push → email); the dispatcher then either cascades (push-first, email as
// fallback) or fans out to every one, per the template's delivery strategy
// (see deliversPushFirst in dispatcher.ts).
//
// Eligibility is evaluated independently per channel:
//   push  — recipient has ≥1 active device_token and hasn't opted out
//   email — has an address and hasn't opted out
//
// `allowedChannels` (per-category prefs) acts as an allow-list: only channels
// in the list (or all channels when null) are considered.

export type Recipient = {
  email: string | null;
  // True when the dispatcher loaded at least one non-revoked device_token for
  // this recipient. Optional so tests written before the push branch don't
  // need an explicit `false`.
  hasActivePushTokens?: boolean;
  emailOptIn?: boolean;
  // False when the recipient has opted out of push from notification settings.
  // Default (undefined/true) means push is active.
  pushOptIn?: boolean;
};

export type ChannelSkipReason =
  "no_push_token" | "push_opt_out" | "no_email" | "email_opt_out" | "channel_excluded"; // channel not in per-category allowedChannels

export type ChannelSkip = {
  channel: "push" | "email";
  reason: ChannelSkipReason;
};

export type MultiChannelResolution = {
  // Channels that passed all eligibility checks, in dispatch order (push → email).
  channels: Array<"push" | "email">;
  // Channels that were excluded and why — for audit logging.
  skipped: ChannelSkip[];
};

export type ResolveInput = {
  recipient: Recipient;
  // Per-category channel allow-list from the recipient's preferences. When
  // present, only channels in this list are considered. Absent / null = no
  // restriction (all channels evaluated). Non-suppressible templates pass null.
  allowedChannels?: ("push" | "email")[] | null;
};

export function resolveChannels(input: ResolveInput): MultiChannelResolution {
  const r = input.recipient;
  const allowed = input.allowedChannels ?? null;

  const channels: Array<"push" | "email"> = [];
  const skipped: ChannelSkip[] = [];

  // --- Push ---
  const pushAllowed = allowed === null || allowed.includes("push");
  if (!pushAllowed) {
    skipped.push({ channel: "push", reason: "channel_excluded" });
  } else if (r.pushOptIn === false) {
    skipped.push({ channel: "push", reason: "push_opt_out" });
  } else if (!r.hasActivePushTokens) {
    skipped.push({ channel: "push", reason: "no_push_token" });
  } else {
    channels.push("push");
  }

  // --- Email ---
  const emailAllowed = allowed === null || allowed.includes("email");
  if (!emailAllowed) {
    skipped.push({ channel: "email", reason: "channel_excluded" });
  } else if (!r.email) {
    skipped.push({ channel: "email", reason: "no_email" });
  } else if (r.emailOptIn === false) {
    skipped.push({ channel: "email", reason: "email_opt_out" });
  } else {
    channels.push("email");
  }

  return { channels, skipped };
}
