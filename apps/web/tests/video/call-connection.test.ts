import { describe, it, expect, vi, afterEach } from "vitest";

import {
  callConnectionKey,
  withConnectTimeout,
  CallConnectTimeoutError,
  CALL_CONNECT_TIMEOUT_MS,
} from "@/lib/video/call-connection";

// Regression guard for the "teacher gets kicked out of the call when she presses
// Record" bug. The call page re-mints a fresh JWT on every server render, and a
// Server Action (Record) refreshes the route via revalidatePath — so <ClassCall>
// is constantly handed new grant.token strings. The connection key these tests
// pin must stay STABLE across token-only changes, or a live call reconnects (and
// drops video + the caption session) on every Record/Stop tap and route refresh.
describe("callConnectionKey", () => {
  const url = "wss://proj.livekit.cloud";

  it("is unchanged when only the token changes (no reconnect on a re-mint)", () => {
    const before = callConnectionKey({ url }, 0);
    const after = callConnectionKey({ url }, 0);
    // Same url + retry → identical key even though the JWT the caller holds differs.
    expect(after).toBe(before);
  });

  it("changes when the user explicitly retries", () => {
    expect(callConnectionKey({ url }, 1)).not.toBe(callConnectionKey({ url }, 0));
  });

  it("changes when the media-server URL changes (a genuinely different server)", () => {
    expect(callConnectionKey({ url: "wss://other.livekit.cloud" }, 0)).not.toBe(
      callConnectionKey({ url }, 0),
    );
  });

  it("never collides a url+retry with a different split of the same characters", () => {
    // The separator keeps `${url}` + `${retryKey}` from aliasing onto another pair.
    expect(callConnectionKey({ url: "a" }, 11)).not.toBe(callConnectionKey({ url: "a1" }, 1));
  });
});

// Regression guard for the "Connecting… forever" bug. PostHog has a real
// teacher session (2026-07-31 19:03:42) where `call_connection_started` fired
// and no terminal event EVER followed — `room.connect()` never settled, so
// ClassCall's `status` stayed "connecting". That branch renders a spinner with
// no Retry (Retry only exists on `status === "error"`), so she was stuck.
describe("withConnectTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a connect that succeeds in time straight through", async () => {
    await expect(withConnectTimeout(Promise.resolve("room"), 1000)).resolves.toBe("room");
  });

  it("preserves the original failure rather than masking it as a timeout", async () => {
    // A real connect error must keep its identity — the UI reports
    // reason:"error" vs reason:"timeout" off exactly this distinction.
    const boom = new Error("livekit refused the token");
    await expect(withConnectTimeout(Promise.reject(boom), 1000)).rejects.toBe(boom);
  });

  it("rejects a connect that never settles, instead of waiting forever", async () => {
    vi.useFakeTimers();
    // Never resolves, never rejects — the exact shape of the observed hang.
    const hung = withConnectTimeout(new Promise<string>(() => {}), CALL_CONNECT_TIMEOUT_MS);
    const assertion = expect(hung).rejects.toBeInstanceOf(CallConnectTimeoutError);
    await vi.advanceTimersByTimeAsync(CALL_CONNECT_TIMEOUT_MS);
    await assertion;
  });

  it("does not fire the timeout after the connect already resolved", async () => {
    // A stale timer must never knock a LIVE call into the error state.
    vi.useFakeTimers();
    const settled = withConnectTimeout(Promise.resolve("room"), 1000);
    await expect(settled).resolves.toBe("room");
    // Well past the deadline; nothing left to reject.
    await vi.advanceTimersByTimeAsync(5000);
    await expect(settled).resolves.toBe("room");
  });

  it("gives the connect the full window before giving up", async () => {
    vi.useFakeTimers();
    let resolve!: (v: string) => void;
    const slow = withConnectTimeout(
      new Promise<string>((r) => {
        resolve = r;
      }),
      1000,
    );
    // Just short of the deadline the connect is still allowed to win.
    await vi.advanceTimersByTimeAsync(999);
    resolve("room");
    await expect(slow).resolves.toBe("room");
  });
});
