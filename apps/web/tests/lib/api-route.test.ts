import { describe, expect, it, vi } from "vitest";

// `lib/api/route.ts` — the JSON wrapper for route handlers that take a plain
// `Request`. It lost two exports when the routes that used them were deleted:
// `json()` had no callers, and `localeFromRequest()` read a `?locale=` only
// those routes appended (this file used to test exactly that, and nothing
// else).
//
// What is worth pinning about what remains is the error contract, because it is
// the reason the module exists at all: an `ApiAuthError` must come back as its
// own status with a machine-readable reason, and any OTHER throw must come back
// as a generic 500. A handler that leaked `err.message` would hand an
// unauthenticated caller Prisma/Postgres internals — useful for enumeration and
// recon, and impossible to notice from the outside once it regresses.

vi.mock("@/lib/analytics/posthog", () => ({ flushAnalytics: vi.fn(async () => {}) }));
const logError = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: () => ({ error: logError, info: vi.fn(), warn: vi.fn() }),
}));

const { handle, errorResponse, readJsonBody } = await import("@/lib/api/route");
const { ApiAuthError } = await import("@/lib/api/auth");
const { z } = await import("zod");

describe("handle", () => {
  it("returns a plain result as a 200 JSON body", async () => {
    const res = await handle(async () => ({ ok: true, id: "x" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: "x" });
  });

  it("gives an ApiAuthError its own status, reason and extra fields", async () => {
    const res = await handle(async () => {
      throw new ApiAuthError(429, "rate-limited", { retryAfterMs: 5000 });
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      ok: false,
      reason: "rate-limited",
      message: "rate-limited",
      retryAfterMs: 5000,
    });
  });

  it("turns a zod failure into a 400 naming the bad fields", async () => {
    const res = await handle(async () => {
      z.object({ name: z.string() }).parse({ name: 42 });
      return { unreachable: true };
    });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("invalid-body");
  });

  it("never leaks a thrown Error's message to the caller", async () => {
    const res = await handle(async () => {
      throw new Error('relation "teachers" does not exist at character 42');
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ ok: false, reason: "internal-error", message: "internal-error" });
    expect(JSON.stringify(body)).not.toContain("teachers");
    // …but it is still logged server-side, or the 500 is unattributable.
    expect(logError).toHaveBeenCalled();
  });

  it("answers a non-Error throw with the same generic 500", async () => {
    const res = await handle(async () => {
      throw "a string, not an Error";
    });
    expect(res.status).toBe(500);
    expect((await res.json()).reason).toBe("internal-error");
  });
});

describe("errorResponse", () => {
  it("defaults message to reason, and merges extras", async () => {
    const res = errorResponse(403, "forbidden", undefined, { scope: "teacher" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      ok: false,
      reason: "forbidden",
      message: "forbidden",
      scope: "teacher",
    });
  });
});

describe("readJsonBody", () => {
  const schema = z.object({ name: z.string() });

  it("parses and validates a JSON body", async () => {
    const req = new Request("https://x.test/api", {
      method: "POST",
      body: JSON.stringify({ name: "Mira" }),
    });
    await expect(readJsonBody(req, schema)).resolves.toEqual({ name: "Mira" });
  });

  it("throws a zod error on malformed JSON rather than a parse crash", async () => {
    // The `.catch(() => null)` matters: without it a truncated body throws a
    // SyntaxError, which handle() reports as a 500 rather than the 400 a
    // client-supplied body deserves.
    const req = new Request("https://x.test/api", { method: "POST", body: "{not json" });
    await expect(readJsonBody(req, schema)).rejects.toBeInstanceOf(z.ZodError);
  });
});
