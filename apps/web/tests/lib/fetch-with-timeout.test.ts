import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  fetchWithTimeout,
  REQUEST_TIMEOUT_MS,
  RequestTimeoutError,
} from "@/lib/fetch-with-timeout";

// Browser fetch has no default timeout, so a stalled request never settles and
// any client component that flipped a `loading` flag before awaiting it stays
// on its spinner permanently — no error, no retry. Web mostly escapes this by
// loading through React Server Components, but the client components that do
// fetch (in-call library browser, package details sheet, admin panels) have
// exactly the shape that hung the mobile student class-detail screen (#791).

// Never settles on its own; only ever rejects via the abort signal. Must
// handle an ALREADY-aborted signal — a caller can abort before fetch is
// reached, and `addEventListener` never fires for an abort that already
// happened.
function stallingFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, init: RequestInit = {}) =>
      new Promise<Response>((_resolve, reject) => {
        const fail = () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (init.signal?.aborted) return fail();
        init.signal?.addEventListener("abort", fail);
      }),
  );
}

describe("fetchWithTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts a stalled request instead of hanging forever", async () => {
    vi.stubGlobal("fetch", stallingFetch());

    const pending = fetchWithTimeout("/api/packages/pk_1").catch((e) => e);

    // Must not fire early on a merely slow request.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1000);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBeInstanceOf(RequestTimeoutError);
  });

  it("does not fire for a request that completes in time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );

    const pending = fetchWithTimeout("/api/packages/pk_1");
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1000);
    const res = await pending;
    expect(res.status).toBe(200);
  });

  it("lets a caller-supplied abort win, and reports it as AbortError not a timeout", async () => {
    vi.stubGlobal("fetch", stallingFetch());

    const controller = new AbortController();
    const pending = fetchWithTimeout("/api/admin/search?q=x", {
      signal: controller.signal,
    }).catch((e) => e);
    controller.abort();

    const result = await pending;
    expect((result as Error).name).toBe("AbortError");
    expect(result).not.toBeInstanceOf(RequestTimeoutError);
  });

  it("clears its timer so a completed request leaves nothing pending", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    await fetchWithTimeout("/api/packages/pk_1");
    // A leaked timer would keep the event loop busy and, worse, abort a later
    // reuse of the same controller.
    expect(vi.getTimerCount()).toBe(0);
  });
});
