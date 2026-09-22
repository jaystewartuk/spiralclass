import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sentryEnvironment } from "@/lib/sentry-environment";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("sentryEnvironment", () => {
  describe("server / edge (no window)", () => {
    beforeEach(() => {
      vi.stubGlobal("window", undefined);
    });

    it("derives the environment from APP_URL", () => {
      // Vercel's VERCEL_ENV is gone (D-89); APP_URL is the sole server signal.
      vi.stubEnv("APP_URL", "https://preview.spiralclass.com");
      expect(sentryEnvironment()).toBe("preview");
      vi.stubEnv("APP_URL", "https://spiralclass.com");
      expect(sentryEnvironment()).toBe("production");
      vi.stubEnv("APP_URL", "http://localhost:3000");
      expect(sentryEnvironment()).toBe("development");
    });

    it("defaults to production when APP_URL is unset", () => {
      vi.stubEnv("APP_URL", "");
      expect(sentryEnvironment()).toBe("production");
    });
  });

  describe("client (browser)", () => {
    it("derives from window.location.hostname, ignoring env", () => {
      vi.stubEnv("APP_URL", "https://spiralclass.com"); // must NOT win on the client
      vi.stubGlobal("window", { location: { hostname: "preview.spiralclass.com" } });
      expect(sentryEnvironment()).toBe("preview");
      vi.stubGlobal("window", { location: { hostname: "spiralclass.com" } });
      expect(sentryEnvironment()).toBe("production");
      vi.stubGlobal("window", { location: { hostname: "localhost" } });
      expect(sentryEnvironment()).toBe("development");
      vi.stubGlobal("window", { location: { hostname: "127.0.0.1" } });
      expect(sentryEnvironment()).toBe("development");
    });
  });
});
