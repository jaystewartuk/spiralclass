import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isServerActionVersionSkew, recoverFromServerActionSkew } from "./server-action-recovery";

const SKEW_MESSAGE =
  'Failed to find Server Action "009cd0e84a3223c9ec0063f01692a027482c78a5be". This request might be from an older or newer deployment.';

// The E394 variant: a server-action POST that returned a non-RSC 200, surfaced
// to the user as "An unexpected response was received from the server."
const UNEXPECTED_RESPONSE_MESSAGE = "An unexpected response was received from the server.";

// Attaches the non-enumerable __NEXT_ERROR_CODE that Next stamps on these,
// mirroring how the framework builds them.
function withNextCode(error: Error, code: string): Error {
  Object.defineProperty(error, "__NEXT_ERROR_CODE", {
    value: code,
    enumerable: false,
    configurable: true,
  });
  return error;
}

describe("isServerActionVersionSkew", () => {
  it("matches the Next.js skew error (Error instance)", () => {
    expect(isServerActionVersionSkew(new Error(SKEW_MESSAGE))).toBe(true);
  });

  it("matches when given the raw message string", () => {
    expect(isServerActionVersionSkew(SKEW_MESSAGE)).toBe(true);
  });

  it("is case-insensitive on the leading phrase", () => {
    expect(isServerActionVersionSkew("failed to find server action foo")).toBe(true);
  });

  it("matches the 'unexpected response' (E394) skew variant by message", () => {
    expect(isServerActionVersionSkew(new Error(UNEXPECTED_RESPONSE_MESSAGE))).toBe(true);
    expect(isServerActionVersionSkew(UNEXPECTED_RESPONSE_MESSAGE)).toBe(true);
  });

  it("matches by Next error code even when the message has drifted", () => {
    // E394 = unexpected response; E715 = action not found. Both are skew.
    expect(isServerActionVersionSkew(withNextCode(new Error("totally new wording"), "E394"))).toBe(
      true,
    );
    expect(
      isServerActionVersionSkew(
        withNextCode(new Error('Server Action "abc" was not found on the server.'), "E715"),
      ),
    ).toBe(true);
  });

  it("matches webpack chunk-load skew (ChunkLoadError name + message)", () => {
    const err = new Error("Loading chunk 4875 failed.\n(error: …/4875-34d0.js)");
    err.name = "ChunkLoadError";
    expect(isServerActionVersionSkew(err)).toBe(true);
    // Name match alone, even if the message wording changes.
    const renamed = new Error("could not load");
    renamed.name = "ChunkLoadError";
    expect(isServerActionVersionSkew(renamed)).toBe(true);
  });

  it("matches a failed CSS chunk load (message + code)", () => {
    expect(isServerActionVersionSkew(new Error("Loading CSS chunk 12 failed."))).toBe(true);
    const err = new Error("css load failed") as Error & { code?: string };
    err.code = "CSS_CHUNK_LOAD_FAILED";
    expect(isServerActionVersionSkew(err)).toBe(true);
  });

  // The real production message from AGENDAPROFE-3B: Turbopack's runtime throws
  // a PLAIN Error here — no ChunkLoadError name, no code — so only the message
  // can identify it. The webpack patterns above never matched it.
  it("matches Turbopack's chunk-load skew (plain Error, no name or code)", () => {
    const err = new Error(
      "Failed to load chunk /_next/static/chunks/03d74e75f9d610cd.js from module 964893",
    );
    expect(err.name).toBe("Error");
    expect(isServerActionVersionSkew(err)).toBe(true);
  });

  it("matches every Turbopack chunk-load reason clause", () => {
    // The leading phrase is fixed; the trailing "why" clause varies per call
    // site in the Turbopack runtime. All four are the same skew.
    const url = "/_next/static/chunks/03d74e75f9d610cd.js";
    for (const reason of [
      "from module 964893",
      "as a runtime dependency of chunk static/chunks/main.js",
      "from an HMR update",
      "from runtime for chunk static/chunks/page.js",
    ]) {
      expect(isServerActionVersionSkew(new Error(`Failed to load chunk ${url} ${reason}`))).toBe(
        true,
      );
    }
    // Turbopack appends the underlying cause when it has one.
    expect(
      isServerActionVersionSkew(
        new Error(`Failed to load chunk ${url} from module 964893: TypeError: Failed to fetch`),
      ),
    ).toBe(true);
  });

  it("matches a Turbopack chunk-load failure given the raw message string", () => {
    expect(
      isServerActionVersionSkew("Failed to load chunk /_next/static/chunks/a.js from module 1"),
    ).toBe(true);
  });

  it("does not match unrelated application errors", () => {
    expect(isServerActionVersionSkew(new Error("Database timeout"))).toBe(false);
    expect(isServerActionVersionSkew("Something went wrong")).toBe(false);
    expect(isServerActionVersionSkew(withNextCode(new Error("boom"), "E123"))).toBe(false);
    // The Turbopack pattern is word-bounded on "chunk" so an app error about
    // chunked anything is not mistaken for a deploy skew and silently reloaded.
    expect(isServerActionVersionSkew(new Error("Failed to load chunked upload"))).toBe(false);
  });

  it("does not match non-error values", () => {
    expect(isServerActionVersionSkew(null)).toBe(false);
    expect(isServerActionVersionSkew(undefined)).toBe(false);
    expect(isServerActionVersionSkew({ message: SKEW_MESSAGE })).toBe(false);
  });
});

describe("recoverFromServerActionSkew", () => {
  // Minimal Map-backed sessionStorage stand-in.
  function makeStorage(): Storage {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    } as Storage;
  }

  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reload = vi.fn();
    vi.stubGlobal("window", {
      location: { reload },
      sessionStorage: makeStorage(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false and does not reload on the server (no window)", () => {
    vi.stubGlobal("window", undefined);
    expect(recoverFromServerActionSkew(new Error(SKEW_MESSAGE))).toBe(false);
  });

  it("returns false and does not reload for non-skew errors", () => {
    expect(recoverFromServerActionSkew(new Error("boom"))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads once for a skew error and reports recovery", () => {
    expect(recoverFromServerActionSkew(new Error(SKEW_MESSAGE))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads for the 'unexpected response' (E394) skew variant", () => {
    expect(recoverFromServerActionSkew(new Error(UNEXPECTED_RESPONSE_MESSAGE))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads for a webpack ChunkLoadError", () => {
    const err = new Error("Loading chunk 4875 failed.");
    err.name = "ChunkLoadError";
    expect(recoverFromServerActionSkew(err)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads for a Turbopack chunk-load failure", () => {
    const err = new Error(
      "Failed to load chunk /_next/static/chunks/03d74e75f9d610cd.js from module 964893",
    );
    expect(recoverFromServerActionSkew(err)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload again within the cooldown window (loop guard)", () => {
    expect(recoverFromServerActionSkew(new Error(SKEW_MESSAGE))).toBe(true);
    expect(recoverFromServerActionSkew(new Error(SKEW_MESSAGE))).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The return value is not just a convenience — useSkewRecoveryOrReport keys
  // BOTH decisions off it: `true` means a reload is running and the error is
  // noise, `false` means the user is looking at an error screen and Sentry
  // should hear about it. So the cooldown case returning `false` is what makes
  // a permanently-missing chunk (a build that shipped broken) reportable, while
  // a chunk missing because a deploy moved it (recovered on the first try) stays
  // quiet. Changing either return value silently changes what gets reported.
  it("reports the second skew error in a row as unrecovered (false), not noise", () => {
    const chunkError = () =>
      new Error("Failed to load chunk /_next/static/chunks/03d74e75f9d610cd.js from module 964893");

    // First: recovered — reload started, nothing to report.
    expect(recoverFromServerActionSkew(chunkError())).toBe(true);
    // Second, inside the cooldown: the reload did not fix it, so the boundary
    // renders the error screen AND the caller reports it.
    expect(recoverFromServerActionSkew(chunkError())).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("still reloads when sessionStorage is unavailable", () => {
    vi.stubGlobal("window", {
      location: { reload },
      get sessionStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(recoverFromServerActionSkew(new Error(SKEW_MESSAGE))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
