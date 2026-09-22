import { beforeEach, describe, expect, it, vi } from "vitest";

// publicUrl/toPublicOrigin exist because self-hosted Next (standalone server)
// derives request URLs from the container's BIND address rather than the proxied
// Host header, so anything built off the request origin ships
// https://0.0.0.0:3000 to the browser. See lib/public-url.ts for the mechanism.

const envState = { appUrl: "https://preview.spiralclass.com" };
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ APP_URL: envState.appUrl }) }));

const { publicUrl, toPublicOrigin } = await import("@/lib/public-url");

beforeEach(() => {
  envState.appUrl = "https://preview.spiralclass.com";
});

describe("publicUrl", () => {
  it("resolves an internal path against APP_URL", () => {
    expect(publicUrl("/dashboard").toString()).toBe("https://preview.spiralclass.com/dashboard");
  });

  it("keeps a query string intact", () => {
    expect(publicUrl("/sign-in?next=%2Fdashboard").toString()).toBe(
      "https://preview.spiralclass.com/sign-in?next=%2Fdashboard",
    );
  });

  it("follows APP_URL rather than pinning one environment", () => {
    envState.appUrl = "https://spiralclass.com";
    expect(publicUrl("/dashboard").origin).toBe("https://spiralclass.com");
  });

  // APP_URL is operator-set (fly.toml [env]); a trailing slash there must not
  // produce a double-slashed path.
  it("tolerates a trailing slash on APP_URL", () => {
    envState.appUrl = "https://preview.spiralclass.com/";
    expect(publicUrl("/dashboard").toString()).toBe("https://preview.spiralclass.com/dashboard");
  });
});

describe("toPublicOrigin", () => {
  // The bind-address origin a real proxied request carries self-hosted.
  it("re-bases a bind-address URL onto APP_URL, keeping path and query", () => {
    const fromRequest = new URL("https://0.0.0.0:3000/sign-in?next=%2Fdashboard");
    expect(toPublicOrigin(fromRequest).toString()).toBe(
      "https://preview.spiralclass.com/sign-in?next=%2Fdashboard",
    );
  });

  it("drops the bind port rather than carrying :3000 across", () => {
    const url = toPublicOrigin(new URL("https://0.0.0.0:3000/dashboard"));
    expect(url.port).toBe("");
    expect(url.host).toBe("preview.spiralclass.com");
  });
});
