// Browser `fetch` has no default timeout. A request that stalls — a dead
// connection, a proxy that accepts and never answers — simply never settles,
// so any client component that flips a `loading` flag before awaiting it stays
// on its spinner permanently, with no error state and no retry. The user sees
// a frozen panel.
//
// The same bug was fixed once before in #791, where it presented as a student
// class-detail screen hanging forever. Web escapes the worst of it because
// almost all data loading is React Server Components, but the handful of
// client components that fetch (in-call library browser, package details
// sheet, admin panels) have exactly the same shape.
//
// 20s sits well above any legitimately slow route, so it only ever fires on a
// genuine stall.
export const REQUEST_TIMEOUT_MS = 20_000;

export class RequestTimeoutError extends Error {
  constructor(url: string) {
    super(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`);
    this.name = "RequestTimeoutError";
  }
}

/**
 * `fetch` that always settles.
 *
 * Drop-in for a client-side `fetch()` call. A caller-supplied `signal` still
 * wins and still surfaces as an `AbortError`, so a deliberate cancel (the
 * component unmounted, a newer keystroke superseded this request) stays
 * distinguishable from a stall in both Sentry and retry logic.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onCallerAbort);
  if (init.signal?.aborted) controller.abort();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new RequestTimeoutError(String(input));
    throw err;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onCallerAbort);
  }
}
