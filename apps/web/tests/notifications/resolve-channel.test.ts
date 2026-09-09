import { describe, expect, it } from "vitest";
import { resolveChannels } from "@/lib/notifications/resolve-channel";

// Channel resolver matrix. Pure function; exercises each channel's eligibility
// check independently plus the allowedChannels filter.

function channels(r: ReturnType<typeof resolveChannels>) {
  return r.channels;
}
function skippedChannels(r: ReturnType<typeof resolveChannels>) {
  return r.skipped.map((s) => s.channel);
}
function skipReason(r: ReturnType<typeof resolveChannels>, ch: string) {
  return r.skipped.find((s) => s.channel === ch)?.reason;
}

describe("resolveChannels — full eligibility", () => {
  it("all channels eligible when every opt-in is on", () => {
    const r = resolveChannels({
      recipient: {
        email: "s@x.com",
        hasActivePushTokens: true,
        pushOptIn: true,
        emailOptIn: true,
      },
    });
    expect(channels(r)).toEqual(["push", "email"]);
    expect(r.skipped).toHaveLength(0);
  });

  it("no push token → push skipped, email eligible", () => {
    const r = resolveChannels({
      recipient: {
        email: "s@x.com",
        hasActivePushTokens: false,
      },
    });
    expect(channels(r)).toEqual(["email"]);
    expect(skipReason(r, "push")).toBe("no_push_token");
  });

  it("push opt-out → push skipped, email eligible", () => {
    const r = resolveChannels({
      recipient: {
        email: "s@x.com",
        hasActivePushTokens: true,
        pushOptIn: false,
      },
    });
    expect(channels(r)).toEqual(["email"]);
    expect(skipReason(r, "push")).toBe("push_opt_out");
  });

  it("email opt-out → push eligible, email skipped", () => {
    const r = resolveChannels({
      recipient: {
        email: "s@x.com",
        hasActivePushTokens: true,
        emailOptIn: false,
      },
    });
    expect(channels(r)).toEqual(["push"]);
    expect(skipReason(r, "email")).toBe("email_opt_out");
  });

  it("no email address → push eligible, email skipped", () => {
    const r = resolveChannels({
      recipient: {
        email: null,
        hasActivePushTokens: true,
      },
    });
    expect(channels(r)).toEqual(["push"]);
    expect(skipReason(r, "email")).toBe("no_email");
  });

  it("no push, no email → empty (undeliverable)", () => {
    const r = resolveChannels({
      recipient: {
        email: null,
        hasActivePushTokens: false,
      },
    });
    expect(channels(r)).toEqual([]);
    expect(skippedChannels(r)).toContain("push");
    expect(skippedChannels(r)).toContain("email");
  });

  it("push only (no email) → push eligible only", () => {
    const r = resolveChannels({
      recipient: {
        email: null,
        hasActivePushTokens: true,
      },
    });
    expect(channels(r)).toEqual(["push"]);
  });
});

describe("resolveChannels — allowedChannels per-category filter", () => {
  it("null allowedChannels = no restriction; all eligible channels returned", () => {
    const r = resolveChannels({
      recipient: {
        email: "s@x.com",
        hasActivePushTokens: true,
      },
      allowedChannels: null,
    });
    expect(channels(r)).toEqual(["push", "email"]);
  });

  it("allowedChannels excludes push → email returned", () => {
    const r = resolveChannels({
      recipient: {
        email: "s@x.com",
        hasActivePushTokens: true,
      },
      allowedChannels: ["email"],
    });
    expect(channels(r)).toEqual(["email"]);
    expect(skipReason(r, "push")).toBe("channel_excluded");
  });

  it("allowedChannels excludes email → push returned", () => {
    const r = resolveChannels({
      recipient: {
        email: "s@x.com",
        hasActivePushTokens: true,
      },
      allowedChannels: ["push"],
    });
    expect(channels(r)).toEqual(["push"]);
    expect(skipReason(r, "email")).toBe("channel_excluded");
  });

  it("push-only allowedChannels + no push token → empty (undeliverable for this category)", () => {
    const r = resolveChannels({
      recipient: {
        email: "s@x.com",
        hasActivePushTokens: false,
      },
      allowedChannels: ["push"],
    });
    expect(channels(r)).toEqual([]);
  });

  it("email-only allowedChannels → email returned even without push", () => {
    const r = resolveChannels({
      recipient: { email: "s@x.com" },
      allowedChannels: ["email"],
    });
    expect(channels(r)).toEqual(["email"]);
  });
});
