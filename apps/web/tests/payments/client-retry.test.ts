import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchStripeClient,
  isStripeConnectNotEnabledError,
  StripeApiError,
} from "@/lib/stripe/client";

// Covers the retry-with-backoff behavior of fetchStripeClient, now backed by
// the official `stripe` SDK's own retry logic (RequestSender._shouldRetry)
// rather than our hand-rolled loop. All tests inject a fake `fetchImpl` via
// the SDK's `httpClient` seam so we control responses; fake timers replace
// the SDK's internal real setTimeout-based backoff so the suite doesn't
// actually wait between retries.
//
// The SDK's retry decision (see node_modules/stripe/cjs/RequestSender.js):
// always retry on a connection error or a 409/5xx response; a 429 is only
// retried when the response carries `Stripe-Should-Retry: true` (which the
// real Stripe API sets on real 429s) — our fixtures set that header
// explicitly to match.

type FakeResponse = Response | Error;

function makeFetch(queue: FakeResponse[]): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string>; method: string }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; method: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    // The SDK's fetch HTTP client passes `init.headers` as an array of
    // [key, value] tuples (see node_modules/stripe/cjs/utils.js's
    // parseHeadersForFetch), not a plain object — Object.entries() on that
    // array indexes by position ("0", "1", ...), silently capturing nothing
    // useful. Normalize through the Headers constructor, which accepts a
    // plain object, an array of tuples, or a Headers instance uniformly.
    if (init?.headers) {
      for (const [k, v] of new Headers(init.headers as HeadersInit).entries()) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({ url, method, headers });
    const next = queue.shift();
    if (!next) throw new Error("fake fetch ran out of responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(
  status: number,
  body: object,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const ACCOUNT_OK = {
  id: "acct_FAKE",
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
};

// Runs `fn()` while flushing every pending timer (the SDK's retry backoff)
// so the retry loop resolves without any real wall-clock delay.
async function withFakeTimers<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const promise = fn();
    // Attach a handler synchronously so a promise that rejects before
    // `vi.runAllTimersAsync()` resolves is never briefly unhandled — Node
    // flags that even though `await promise` below does eventually handle
    // it, since the flag is a point-in-time check. The real
    // rejection/resolution still propagates via the awaited return.
    promise.catch(() => {});
    await vi.runAllTimersAsync();
    return await promise;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("fetchStripeClient — retry behavior", () => {
  it("retries on 503 then succeeds; surfaces the second response", async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse(503, { error: { message: "service unavailable" } }),
      jsonResponse(200, ACCOUNT_OK),
    ]);
    const client = fetchStripeClient({ secretKey: "sk_test_x", fetchImpl });

    const result = await withFakeTimers(() => client.getConnectedAccount("acct_FAKE"));
    expect(result.id).toBe("acct_FAKE");
    expect(calls).toHaveLength(2);
  });

  it("retries on 429 (rate limit) then succeeds", async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse(
        429,
        { error: { message: "too many requests" } },
        { "Stripe-Should-Retry": "true" },
      ),
      jsonResponse(200, ACCOUNT_OK),
    ]);
    const client = fetchStripeClient({ secretKey: "sk_test_x", fetchImpl });

    await withFakeTimers(() => client.getConnectedAccount("acct_FAKE"));
    expect(calls).toHaveLength(2);
  });

  it("retries on network failure (fetch throws) then succeeds", async () => {
    const { fetchImpl, calls } = makeFetch([
      new Error("ECONNRESET"),
      jsonResponse(200, ACCOUNT_OK),
    ]);
    const client = fetchStripeClient({ secretKey: "sk_test_x", fetchImpl });

    await withFakeTimers(() => client.getConnectedAccount("acct_FAKE"));
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry on 4xx other than 429 (those are caller errors)", async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse(404, { error: { message: "not found" } }),
    ]);
    const client = fetchStripeClient({ secretKey: "sk_test_x", fetchImpl });

    await expect(
      withFakeTimers(() => client.getConnectedAccount("acct_GONE")),
    ).rejects.toBeInstanceOf(StripeApiError);
    expect(calls).toHaveLength(1);
  });

  it("gives up after exhausting maxRetries and re-throws the last error", async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse(503, { error: { message: "down" } }),
      jsonResponse(503, { error: { message: "still down" } }),
      jsonResponse(503, { error: { message: "still down" } }),
    ]);
    const client = fetchStripeClient({ secretKey: "sk_test_x", fetchImpl });

    await expect(
      withFakeTimers(() => client.getConnectedAccount("acct_FAKE")),
    ).rejects.toBeInstanceOf(StripeApiError);
    expect(calls).toHaveLength(3); // 1 initial + 2 retries (default maxRetries)
  });

  it("synthesizes an Idempotency-Key for POSTs that didn't pass one + reuses it across retries", async () => {
    // Since D-143 createConnectedAccount is TWO requests: POST /v2/core/accounts
    // to create, then GET /v1/accounts/{id} to hand back the v1 shape every
    // caller is written against. The retry under test is on the first.
    const { fetchImpl, calls } = makeFetch([
      jsonResponse(503, { error: { message: "down" } }),
      jsonResponse(200, { id: "acct_NEW", object: "v2.core.account" }),
      jsonResponse(200, {
        id: "acct_NEW",
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
      }),
    ]);
    const client = fetchStripeClient({
      secretKey: "sk_test_x",
      fetchImpl,
      randomUUID: () => "deadbeef-1234",
    });

    await withFakeTimers(() =>
      client.createConnectedAccount({ email: "teacher@e2e.test", country: "MX", currency: "MXN" }),
    );
    expect(calls).toHaveLength(3);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["idempotency-key"]).toBe("deadbeef-1234");
    expect(calls[1]?.headers["idempotency-key"]).toBe("deadbeef-1234"); // stable across retries
  });

  it("preserves an explicit Idempotency-Key from the caller across retries", async () => {
    const { fetchImpl, calls } = makeFetch([
      jsonResponse(502, { error: { message: "bad gateway" } }),
      jsonResponse(200, { id: "re_OK", status: "succeeded", payment_intent: "pi_SAME" }),
    ]);
    const client = fetchStripeClient({ secretKey: "sk_test_x", fetchImpl });

    await withFakeTimers(() => client.createRefund({ paymentIntentId: "pi_SAME" }));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers["idempotency-key"]).toBe("refund-pi_SAME");
    expect(calls[1]?.headers["idempotency-key"]).toBe("refund-pi_SAME");
  });

  it("does NOT attach an Idempotency-Key to GET requests", async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse(200, ACCOUNT_OK)]);
    const client = fetchStripeClient({ secretKey: "sk_test_x", fetchImpl });
    await withFakeTimers(() => client.getConnectedAccount("acct_FAKE"));
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("recognizes the 'platform hasn't signed up for Connect' 400 as a distinct error", async () => {
    const body = JSON.stringify({
      error: {
        message:
          "You can only create new accounts if you've signed up for Connect, which you can do at https://dashboard.stripe.com/connect.",
      },
    });
    const { fetchImpl } = makeFetch([
      new Response(body, { status: 400, headers: { "Content-Type": "application/json" } }),
    ]);
    const client = fetchStripeClient({ secretKey: "sk_test_x", fetchImpl });
    const err = await withFakeTimers(() =>
      client
        .createConnectedAccount({ email: "t@e2e.test", country: "MX", currency: "MXN" })
        .catch((e) => e),
    );
    expect(err).toBeInstanceOf(StripeApiError);
    expect(isStripeConnectNotEnabledError(err)).toBe(true);
    expect(isStripeConnectNotEnabledError(new Error("other"))).toBe(false);
    expect(isStripeConnectNotEnabledError(new StripeApiError(404, "{}", "/v1/accounts"))).toBe(
      false,
    );
  });

  it("maxRetries=0 disables retry entirely", async () => {
    const { fetchImpl, calls } = makeFetch([jsonResponse(503, { error: { message: "down" } })]);
    const client = fetchStripeClient({ secretKey: "sk_test_x", fetchImpl, maxRetries: 0 });
    await expect(
      withFakeTimers(() => client.getConnectedAccount("acct_FAKE")),
    ).rejects.toBeInstanceOf(StripeApiError);
    expect(calls).toHaveLength(1);
  });
});
