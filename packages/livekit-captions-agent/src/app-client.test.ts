import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logEvent = vi.fn();
vi.mock("./log", () => ({ logEvent }));

const { AppClient } = await import("./app-client");

const client = new AppClient("https://app.example", "secret");

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function stubFetch(impl: () => Promise<unknown>) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

describe("AppClient.roomConfig", () => {
  it("returns the config on a successful response", async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => ({ ok: true, enabled: true, bookingId: "b1" }),
    }));
    await expect(client.roomConfig("class-b1")).resolves.toMatchObject({
      enabled: true,
      bookingId: "b1",
    });
  });

  it("returns null on a non-ok HTTP status", async () => {
    stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(client.roomConfig("class-b1")).resolves.toBeNull();
    expect(logEvent).toHaveBeenCalledWith(
      "app_request_failed",
      expect.objectContaining({ status: 503 }),
    );
  });

  it("returns null when the app says the room is not captionable", async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({ ok: false }) }));
    await expect(client.roomConfig("class-b1")).resolves.toBeNull();
  });

  // The regression this file exists for. Production 2026-07-29: the Agent
  // died twice within a minute mid-class because a rejected fetch propagated
  // out of a fire-and-forget caller and Node 22 killed the process. The box
  // has no IPv6 route and the app host publishes AAAA records, so ENETUNREACH
  // is a routine outcome here — it must never be able to take the Agent down.
  it("returns null instead of rejecting when the network is unreachable", async () => {
    stubFetch(async () => {
      throw Object.assign(new TypeError("fetch failed"), { code: "ENETUNREACH" });
    });
    await expect(client.roomConfig("class-b1")).resolves.toBeNull();
    expect(logEvent).toHaveBeenCalledWith(
      "app_request_error",
      expect.objectContaining({ error: expect.stringContaining("fetch failed") }),
    );
  });

  it("returns null instead of rejecting when the response body is not JSON", async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }));
    await expect(client.roomConfig("class-b1")).resolves.toBeNull();
  });
});
