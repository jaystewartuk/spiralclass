import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// web-push is module-mocked so these tests exercise OUR classification of the
// push service's responses (delivered / permanently gone / retry later)
// without a network call. That classification is the whole point of the
// module: getting "gone" wrong either revokes live subscriptions or keeps
// pushing to dead ones forever.
const sendNotification = vi.fn();

class FakeWebPushError extends Error {
  statusCode: number;
  constructor(statusCode: number) {
    super(`push service returned ${statusCode}`);
    this.statusCode = statusCode;
  }
}

vi.mock("web-push", () => ({
  default: { sendNotification: (...args: unknown[]) => sendNotification(...args) },
  WebPushError: FakeWebPushError,
}));

const { createRealWebPushClient, createStubWebPushClient, isWebPushConfigured, vapidConfig } =
  await import("./web-push");

const VAPID = { publicKey: "pub", privateKey: "priv", subject: "mailto:ops@spiralclass.com" };

const SUBS = [
  { id: "s1", endpoint: "https://push.example/1", p256dh: "k1", auth: "a1" },
  { id: "s2", endpoint: "https://push.example/2", p256dh: "k2", auth: "a2" },
];

const PAYLOAD = { title: "Class confirmed", body: "Tomorrow at 5pm", deepLink: "dashboard" };

describe("vapidConfig", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("is null unless all three values are present", () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    expect(vapidConfig()).toBeNull();
    expect(isWebPushConfigured()).toBe(false);

    // A half-configured deploy must read as unconfigured, not as configured
    // with a broken key — every send would fail and the recipient would look
    // push-reachable while receiving nothing.
    process.env.VAPID_PUBLIC_KEY = "pub";
    expect(vapidConfig()).toBeNull();

    process.env.VAPID_PRIVATE_KEY = "priv";
    expect(vapidConfig()).toBeNull();

    process.env.VAPID_SUBJECT = "mailto:ops@spiralclass.com";
    expect(vapidConfig()).toEqual(VAPID);
    expect(isWebPushConfigured()).toBe(true);
  });

  it("treats a blank-string value as absent", () => {
    process.env.VAPID_PUBLIC_KEY = "  ";
    process.env.VAPID_PRIVATE_KEY = "priv";
    process.env.VAPID_SUBJECT = "mailto:ops@spiralclass.com";
    expect(vapidConfig()).toBeNull();
  });
});

describe("createRealWebPushClient", () => {
  beforeEach(() => {
    sendNotification.mockReset();
  });

  it("reports every accepted subscription as delivered", async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const client = createRealWebPushClient(VAPID);

    const result = await client.send({ subscriptions: SUBS, payload: PAYLOAD });

    expect(result.deliveredIds).toEqual(["s1", "s2"]);
    expect(result.goneIds).toEqual([]);
    expect(result.failedIds).toEqual([]);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it("encrypts to each subscription's own keys and carries the payload as JSON", async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const client = createRealWebPushClient(VAPID);

    await client.send({
      subscriptions: [SUBS[0]],
      payload: { ...PAYLOAD, tag: "notif-1", urgent: true },
    });

    const [subscription, body, options] = sendNotification.mock.calls[0];
    expect(subscription).toEqual({
      endpoint: "https://push.example/1",
      keys: { p256dh: "k1", auth: "a1" },
    });
    expect(JSON.parse(body as string)).toEqual({
      title: "Class confirmed",
      body: "Tomorrow at 5pm",
      deepLink: "dashboard",
      tag: "notif-1",
      urgent: true,
    });
    // An urgent (class-imminent) notice gets the short TTL — a reminder that
    // arrives after the class has started is worse than none.
    expect((options as { TTL: number }).TTL).toBe(30 * 60);
    expect((options as { urgency: string }).urgency).toBe("high");
  });

  it.each([404, 410])(
    "classifies %i as permanently gone, not a retryable failure",
    async (code) => {
      sendNotification.mockRejectedValue(new FakeWebPushError(code));
      const client = createRealWebPushClient(VAPID);

      const result = await client.send({ subscriptions: [SUBS[0]], payload: PAYLOAD });

      expect(result.goneIds).toEqual(["s1"]);
      expect(result.failedIds).toEqual([]);
      expect(result.errorCodes).toEqual([`Gone:${code}`]);
    },
  );

  it.each([429, 500, 503])("classifies %i as a retryable failure, never as gone", async (code) => {
    // The important half of the distinction: a rate-limited or briefly-down
    // push service must not cost the recipient their subscription.
    sendNotification.mockRejectedValue(new FakeWebPushError(code));
    const client = createRealWebPushClient(VAPID);

    const result = await client.send({ subscriptions: [SUBS[0]], payload: PAYLOAD });

    expect(result.goneIds).toEqual([]);
    expect(result.failedIds).toEqual(["s1"]);
    expect(result.errorCodes).toEqual([`Http:${code}`]);
  });

  it("classifies a non-HTTP throw (network error) as retryable", async () => {
    sendNotification.mockRejectedValue(new Error("ECONNRESET"));
    const client = createRealWebPushClient(VAPID);

    const result = await client.send({ subscriptions: [SUBS[0]], payload: PAYLOAD });

    expect(result.failedIds).toEqual(["s1"]);
    expect(result.goneIds).toEqual([]);
    expect(result.errorCodes).toEqual(["Unknown"]);
  });

  it("one dead subscription does not stop the others from being delivered", async () => {
    sendNotification
      .mockRejectedValueOnce(new FakeWebPushError(410))
      .mockResolvedValueOnce({ statusCode: 201 });
    const client = createRealWebPushClient(VAPID);

    const result = await client.send({ subscriptions: SUBS, payload: PAYLOAD });

    expect(result.goneIds).toEqual(["s1"]);
    expect(result.deliveredIds).toEqual(["s2"]);
  });

  it("reports NotConfigured without revoking anything when VAPID is absent", async () => {
    const original = { ...process.env };
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    try {
      const client = createRealWebPushClient();
      const result = await client.send({ subscriptions: SUBS, payload: PAYLOAD });

      expect(result.failedIds).toEqual(["s1", "s2"]);
      // Critically NOT goneIds: an unconfigured server must never mass-revoke
      // perfectly good subscriptions that would work again once keys are set.
      expect(result.goneIds).toEqual([]);
      expect(result.errorCodes).toEqual(["NotConfigured"]);
      expect(sendNotification).not.toHaveBeenCalled();
    } finally {
      process.env = original;
    }
  });

  it("sends nothing and reports nothing for an empty subscription list", async () => {
    const client = createRealWebPushClient(VAPID);
    const result = await client.send({ subscriptions: [], payload: PAYLOAD });

    expect(result).toEqual({ deliveredIds: [], goneIds: [], failedIds: [], errorCodes: [] });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("createStubWebPushClient", () => {
  it("defaults every subscription to delivered and records the batch", async () => {
    const client = createStubWebPushClient();
    const result = await client.send({ subscriptions: SUBS, payload: PAYLOAD });

    expect(result.deliveredIds).toEqual(["s1", "s2"]);
    expect(client.sentBatches).toHaveLength(1);
  });

  it("honours a preloaded per-endpoint outcome", async () => {
    const client = createStubWebPushClient({ "https://push.example/1": "gone" });
    const result = await client.send({ subscriptions: SUBS, payload: PAYLOAD });

    expect(result.goneIds).toEqual(["s1"]);
    expect(result.deliveredIds).toEqual(["s2"]);
  });
});
