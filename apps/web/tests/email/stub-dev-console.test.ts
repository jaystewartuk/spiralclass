import { afterEach, describe, expect, it, vi } from "vitest";
import { createStubEmailClient } from "@/lib/email/resend";

// The stub email client is what a fresh clone gets: no RESEND_API_KEY, no
// SES_*, so getEmailClient() falls through to it. Sign-in is a one-time code
// delivered by email and nothing else, so a stub that records silently means a
// new contributor cannot get into the app at all. It prints to the dev
// server's console instead.
//
// The guard has to be exactly "development". Both test projects run under
// NODE_ENV=test and send stub email constantly; if this widened to
// `!== "production"` every suite would drown in it.

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

// NODE_ENV is readonly in @types/node's ProcessEnv; tests set it by cast.
async function withNodeEnv(value: string, fn: () => Promise<void>) {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
  try {
    await fn();
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = ORIGINAL_NODE_ENV;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stub email client console output", () => {
  it("prints recipient, subject and body when NODE_ENV is development", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const client = createStubEmailClient();

    await withNodeEnv("development", async () => {
      await client.send({
        to: "teacher@example.com",
        subject: "Your sign-in code",
        body: "123456",
      });
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const printed = String(spy.mock.calls[0]?.[0] ?? "");
    expect(printed).toContain("teacher@example.com");
    expect(printed).toContain("Your sign-in code");
    expect(printed).toContain("123456");
    expect(printed).toContain("not sent");
  });

  it("stays silent under NODE_ENV=test so the suites are not flooded", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const client = createStubEmailClient();

    await client.send({ to: "a@example.com", subject: "s", body: "b" });

    expect(spy).not.toHaveBeenCalled();
  });

  it("stays silent in production, where the stub is a misconfiguration rather than a dev aid", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const client = createStubEmailClient();

    await withNodeEnv("production", async () => {
      await client.send({ to: "a@example.com", subject: "s", body: "b" });
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it("still records the send, so existing assertions on getSends() are unaffected", async () => {
    const client = createStubEmailClient();

    await client.send({ to: "a@example.com", subject: "s", body: "b" });

    expect(client.getSends()).toHaveLength(1);
    expect(client.getSends()[0]?.to).toBe("a@example.com");
  });
});
