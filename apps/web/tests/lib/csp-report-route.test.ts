import { describe, it, expect, vi } from "vitest";

// The CSP violation sink (/api/csp-report). It is unauthenticated and must never
// throw — whatever a browser (or an abuser) posts, it logs at most once and
// returns 204. We assert it parses both report shapes, tolerates garbage, and
// drops oversized bodies without parsing.

const warn = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: () => ({ warn, info: vi.fn(), error: vi.fn() }) }));

const { POST } = await import("@/app/api/csp-report/route");

function post(body: string): Promise<Response> {
  return POST(new Request("http://test.local/api/csp-report", { method: "POST", body }));
}

describe("POST /api/csp-report", () => {
  it("logs a legacy { 'csp-report': {...} } violation and returns 204", async () => {
    warn.mockClear();
    const res = await post(
      JSON.stringify({
        "csp-report": {
          "violated-directive": "script-src",
          "blocked-uri": "https://evil.example/x.js",
          "document-uri": "https://spiralclass.com/dashboard",
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledWith(
      "csp violation",
      expect.objectContaining({
        violatedDirective: "script-src",
        blockedURI: "https://evil.example/x.js",
      }),
    );
  });

  it("logs a Reporting-API [{ body }] violation", async () => {
    warn.mockClear();
    const res = await post(
      JSON.stringify([
        {
          type: "csp-violation",
          body: { effectiveDirective: "img-src", blockedURL: "https://evil.example/p.png" },
        },
      ]),
    );
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledWith(
      "csp violation",
      expect.objectContaining({
        violatedDirective: "img-src",
        blockedURI: "https://evil.example/p.png",
      }),
    );
  });

  it("returns 204 without logging on unparseable garbage", async () => {
    warn.mockClear();
    const res = await post("}{not json");
    expect(res.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops an oversized body without parsing", async () => {
    warn.mockClear();
    const res = await post("x".repeat(20_000));
    expect(res.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });
});
