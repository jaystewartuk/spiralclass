import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PostHog server-side capture — closes the gap that the dispatcher
// has zero coverage. Asserts:
//
//   1. NODE_ENV='test' is a hard no-op (the wrapper never reaches
//      posthog-node when we're inside vitest), so the entire test suite
//      stays clean of analytics writes by default.
//   2. With POSTHOG_KEY missing it falls back to console.log so a dev
//      sees what would have shipped.
//   3. With POSTHOG_KEY set it forwards distinctId + event name + a
//      copy of the properties to posthog-node.
//   4. flushAnalytics drains the client cleanly; safe when no client.
//
// We can't assert the event-shape *type* at runtime (TS-only). Per-emit
// shape assertions live in the call-site tests (override-actions,
// cancel-handler, etc.) where we spy on trackServerEvent directly.

const captureMock = vi.fn();
const identifyMock = vi.fn();
const aliasMock = vi.fn();
const shutdownMock = vi.fn(async () => {});

// posthog-node's PostHog ctor is what the wrapper instantiates. Replace
// it with a recordable test double so we can verify what got passed.
vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(
      public key: string,
      public opts: unknown,
    ) {}
    capture = captureMock;
    identify = identifyMock;
    alias = aliasMock;
    shutdown = shutdownMock;
  },
}));

async function importFresh() {
  vi.resetModules();
  return await import("@/lib/analytics/posthog");
}

beforeEach(() => {
  captureMock.mockClear();
  identifyMock.mockClear();
  aliasMock.mockClear();
  shutdownMock.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("trackServerEvent — no-op in test mode", () => {
  it("never instantiates the PostHog client when NODE_ENV='test', even if a key is set", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("POSTHOG_KEY", "phc-shouldbe-ignored");
    const { trackServerEvent } = await importFresh();
    trackServerEvent({
      name: "teacher_signup_completed",
      distinctId: "t-1",
      properties: { teacherId: "t-1" },
    });
    expect(captureMock).not.toHaveBeenCalled();
  });
});

describe("trackServerEvent — POSTHOG_KEY missing", () => {
  it("falls back to console.log without crashing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "");
    // The structured logger fallback emits one JSON line via console.info.
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const { trackServerEvent } = await importFresh();
    trackServerEvent({
      name: "booking_created",
      distinctId: "t-2",
      properties: {
        teacherId: "t-2",
        bookingId: "b-1",
        packageId: "p-1",
        via: "via_link",
      },
    });
    expect(captureMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0]![0] as string);
    expect(line).toMatchObject({
      level: "info",
      surface: "analytics",
      msg: "booking_created",
      distinctId: "t-2",
      teacherId: "t-2",
      via: "via_link",
    });
    log.mockRestore();
  });
});

describe("trackServerEvent — POSTHOG_KEY set", () => {
  it("forwards (distinctId, event-name, properties-copy + environment) to posthog-node", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    // Pin the deployment environment so the stamped property is deterministic
    // (sentryEnvironment derives it from APP_URL post-D-89).
    vi.stubEnv("APP_URL", "https://spiralclass.com");
    const { trackServerEvent } = await importFresh();

    trackServerEvent({
      name: "booking_canceled",
      distinctId: "s-1",
      properties: {
        actor: "student",
        timing: "lt24h",
        bookingId: "b-1",
        teacherId: "t-1",
      },
    });

    expect(captureMock).toHaveBeenCalledTimes(1);
    // The event is keyed by the student (distinctId s-1) but also carries
    // the teacher group, so teacher-level analytics span both identity
    // domains (student-keyed booking/payment events + teacher-keyed
    // lifecycle events). Every server event is also stamped with the
    // deployment `environment` so preview traffic is separable from prod.
    expect(captureMock).toHaveBeenCalledWith({
      distinctId: "s-1",
      event: "booking_canceled",
      properties: {
        actor: "student",
        timing: "lt24h",
        bookingId: "b-1",
        teacherId: "t-1",
        environment: "production",
        platform: "web",
      },
      groups: { teacher: "t-1" },
    });
  });

  it("stamps platform=web on every server event — server events always come from the apps/web backend, whatever the request came from", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    const { trackServerEvent } = await importFresh();
    trackServerEvent({
      name: "override_applied",
      distinctId: "t-1",
      properties: {
        teacherId: "t-1",
        action: "mark_complete",
        targetType: "booking",
        targetId: "b-1",
      },
    });
    const captured = captureMock.mock.calls[0]![0] as { properties: { platform: string } };
    expect(captured.properties.platform).toBe("web");
  });

  it("stamps environment=preview on a preview deployment (separable from prod)", async () => {
    vi.stubEnv("NODE_ENV", "production"); // a preview build is also NODE_ENV=production
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    vi.stubEnv("APP_URL", "https://preview.spiralclass.com");
    const { trackServerEvent } = await importFresh();
    trackServerEvent({
      name: "payment_received",
      distinctId: "t-1",
      properties: {
        teacherId: "t-1",
        packageId: "p-1",
        paymentId: "pay-1",
        kind: "prepaid",
        amountMinorUnits: 1,
        currency: "MXN",
      },
    });
    const captured = captureMock.mock.calls[0]![0] as {
      properties: { environment: string };
    };
    expect(captured.properties.environment).toBe("preview");
  });

  it("caches the client across calls (constructs only once)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    const { trackServerEvent } = await importFresh();

    trackServerEvent({
      name: "override_applied",
      distinctId: "t-1",
      properties: {
        teacherId: "t-1",
        action: "mark_complete",
        targetType: "booking",
        targetId: "b-1",
      },
    });
    trackServerEvent({
      name: "override_applied",
      distinctId: "t-1",
      properties: {
        teacherId: "t-1",
        action: "restore_class",
        targetType: "booking",
        targetId: "b-2",
      },
    });
    expect(captureMock).toHaveBeenCalledTimes(2);
    // Both events must have distinct override actions — a regression
    // where we flatten the union into one shape would surface here.
    const actions = captureMock.mock.calls.map(
      (c) => (c[0] as { properties: { action: string } }).properties.action,
    );
    expect(actions).toEqual(["mark_complete", "restore_class"]);
  });

  it("passes a copy of properties — caller mutating their object after emit doesn't bleed into capture", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    const { trackServerEvent } = await importFresh();

    const props = {
      teacherId: "t-1",
      packageId: "p-1",
      paymentId: "pay-1",
      kind: "prepaid" as const,
      amountMinorUnits: 50000,
      currency: "MXN",
    };
    trackServerEvent({
      name: "payment_received",
      distinctId: "t-1",
      properties: props,
    });
    // Caller mutates after emit — must not affect the captured properties.
    (props as { kind: string }).kind = "post";
    const captured = captureMock.mock.calls[0][0] as {
      properties: { kind: string };
    };
    expect(captured.properties.kind).toBe("prepaid");
  });
});

describe("identifyServerUser", () => {
  it("is a hard no-op in test mode", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("POSTHOG_KEY", "phc-shouldbe-ignored");
    const { identifyServerUser } = await importFresh();
    identifyServerUser("t-1", { email: "a@b.co", role: "teacher" });
    expect(identifyMock).not.toHaveBeenCalled();
  });

  it("forwards distinctId + email + role to posthog-node.identify when POSTHOG_KEY is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    const { identifyServerUser } = await importFresh();
    identifyServerUser("t-1", { email: "mira@example.com", role: "teacher" });
    expect(identifyMock).toHaveBeenCalledTimes(1);
    expect(identifyMock).toHaveBeenCalledWith({
      distinctId: "t-1",
      properties: { role: "teacher", email: "mira@example.com" },
    });
  });

  it("omits email from the person properties when it's null or empty", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    const { identifyServerUser } = await importFresh();
    identifyServerUser("s-1", { email: null, role: "student" });
    expect(identifyMock).toHaveBeenCalledWith({
      distinctId: "s-1",
      properties: { role: "student" },
    });
  });

  it("dedupes per-process — repeat identifies for the same distinctId are dropped", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    const { identifyServerUser } = await importFresh();
    identifyServerUser("t-1", { email: "a@b.co", role: "teacher" });
    identifyServerUser("t-1", { email: "a@b.co", role: "teacher" });
    identifyServerUser("t-1", { email: "a@b.co", role: "teacher" });
    expect(identifyMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to console.log when POSTHOG_KEY is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "");
    // The structured logger fallback emits one JSON line via console.info.
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const { identifyServerUser } = await importFresh();
    identifyServerUser("t-2", { email: "a@b.co", role: "admin" });
    expect(identifyMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(log.mock.calls[0]![0] as string);
    expect(line).toMatchObject({
      level: "info",
      surface: "analytics",
      msg: "identify",
      distinctId: "t-2",
      role: "admin",
      email: "a@b.co",
    });
    log.mockRestore();
  });
});

describe("flushAnalytics", () => {
  it("calls shutdown on the cached client and clears it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    const { trackServerEvent, flushAnalytics } = await importFresh();
    trackServerEvent({
      name: "email_opt_out",
      distinctId: "s-1",
      properties: { teacherId: "t-1", studentId: "s-1", idempotent: false },
    });
    await flushAnalytics();
    expect(shutdownMock).toHaveBeenCalledTimes(1);
    // After flush the cached client is cleared; calling again is a no-op.
    await flushAnalytics();
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it("is safe when no client was ever constructed (no key set)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "");
    const { flushAnalytics } = await importFresh();
    await expect(flushAnalytics()).resolves.toBeUndefined();
    expect(shutdownMock).not.toHaveBeenCalled();
  });

  it("swallows shutdown errors silently — analytics never blocks the request path", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    shutdownMock.mockImplementationOnce(async () => {
      throw new Error("posthog network blip");
    });
    const { trackServerEvent, flushAnalytics } = await importFresh();
    trackServerEvent({
      name: "availability_configured",
      distinctId: "t-1",
      properties: { teacherId: "t-1", rangesCount: 5 },
    });
    await expect(flushAnalytics()).resolves.toBeUndefined();
  });
});

// Merges the anonymous browsing identity into the buyer's at checkout. Without
// it the public funnel spans two PostHog persons — browser events on
// posthog-js's anonymous id, purchase events on student.id — and since funnels
// group by person it reads as 100% drop-off after the page view. The
// 2026-07-29 production test purchase produced exactly that: `019fafae…`
// browsing, `e0fda820…` buying, nothing joining them.
describe("aliasServerUser", () => {
  it("merges the anonymous id into the real one", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    const { aliasServerUser } = await importFresh();
    aliasServerUser("student-1", "anon-browser-1");
    expect(aliasMock).toHaveBeenCalledWith({
      distinctId: "student-1",
      alias: "anon-browser-1",
    });
  });

  it("is a hard no-op under NODE_ENV=test, like every other helper here", async () => {
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    const { aliasServerUser } = await importFresh();
    aliasServerUser("student-1", "anon-browser-1");
    expect(aliasMock).not.toHaveBeenCalled();
  });

  it("refuses a self-alias, which PostHog rejects", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    const { aliasServerUser } = await importFresh();
    aliasServerUser("same-id", "same-id");
    expect(aliasMock).not.toHaveBeenCalled();
  });

  it("ignores an empty anonymous id (no PostHog cookie on a first-ever visit)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    const { aliasServerUser } = await importFresh();
    aliasServerUser("student-1", "");
    expect(aliasMock).not.toHaveBeenCalled();
  });

  it("sends each pair once per process — the merge is idempotent, the noise isn't", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    const { aliasServerUser } = await importFresh();
    aliasServerUser("student-1", "anon-1");
    aliasServerUser("student-1", "anon-1");
    expect(aliasMock).toHaveBeenCalledTimes(1);
    // A genuinely different device/browser for the same buyer still merges.
    aliasServerUser("student-1", "anon-2");
    expect(aliasMock).toHaveBeenCalledTimes(2);
  });

  it("never lets an analytics failure reach the purchase path", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTHOG_KEY", "phc-real-key");
    aliasMock.mockImplementationOnce(() => {
      throw new Error("posthog network blip");
    });
    const { aliasServerUser } = await importFresh();
    expect(() => aliasServerUser("student-1", "anon-1")).not.toThrow();
  });
});
