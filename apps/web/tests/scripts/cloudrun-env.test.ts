import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { SOURCE, pushedEntries, r2Entries } from "../../../../scripts/cloudrun-env.mjs";
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

/**
 * scripts/cloudrun-env.mjs decides what the production runtime secret holds:
 * Infisical `production` at `/`, plus the production R2 buckets' credentials
 * from infra/cloudflare-r2's Tofu state (D-65). The env-file it writes is
 * covered by apps/web/tests/config/cloudrun-deploy.test.ts; this covers the set.
 */

const bucket = (
  prefix: string,
  environment: string,
  secret = `secret-${prefix}-${environment}`,
) => ({
  bucket: `agendaprofe-${environment}-${prefix.toLowerCase()}`,
  endpoint: "https://stub.r2.cloudflarestorage.com",
  region: "auto",
  access_key_id: `key-${prefix}-${environment}`,
  secret_access_key: secret,
  env_prefix: prefix,
  environment,
  public: false,
});

const SOURCES = {
  infisical: [
    { key: "STRIPE_SECRET_KEY", value: "sk_live_stub_value" },
    { key: "GOOGLE_CLIENT_ID", value: "stub-google-client" },
  ],
  r2: {
    "agendaprofe-production-chat-audio": bucket("CHAT_AUDIO_R2", "production"),
    "agendaprofe-preview-chat-audio": bucket("CHAT_AUDIO_R2", "preview", "preview-only-secret"),
  },
};

describe("the R2 credentials are the production buckets', spelled as the app reads them", () => {
  it("emits five names per production bucket and nothing for preview", () => {
    const entries = r2Entries(SOURCES.r2);
    expect(entries.map((e) => e.key).sort()).toEqual([
      "CHAT_AUDIO_R2_ACCESS_KEY",
      "CHAT_AUDIO_R2_BUCKET",
      "CHAT_AUDIO_R2_ENDPOINT",
      "CHAT_AUDIO_R2_REGION",
      "CHAT_AUDIO_R2_SECRET",
    ]);
    expect(entries.map((e) => e.value)).not.toContain("preview-only-secret");
  });

  it("emits only names the app actually reads", () => {
    // A name the app does not read is a credential that silently does nothing.
    for (const { key } of r2Entries(SOURCES.r2)) {
      const readers = execFileSync(
        "git",
        ["grep", "-l", `process.env.${key}`, "--", "apps/web/src"],
        { cwd: REPO_ROOT, encoding: "utf8" },
      ).trim();
      expect(readers, `nothing in apps/web/src reads ${key}`).not.toBe("");
    }
  });

  it("refuses a bucket still mid-adoption rather than write the string null", () => {
    const adopting = { ...bucket("CHAT_AUDIO_R2", "production"), access_key_id: null };
    expect(() => r2Entries({ adopting })).toThrow("has no access_key yet");
  });

  it("refuses a state with no production bucket at all", () => {
    expect(() => r2Entries({ p: bucket("CHAT_AUDIO_R2", "preview") })).toThrow(
      "no production buckets",
    );
  });
});

describe("the secret set is exactly what the two sources hold", () => {
  it("takes every Infisical value and every production R2 name, marked with its source", () => {
    const desired = pushedEntries(SOURCES);
    expect(desired.get("STRIPE_SECRET_KEY")).toEqual({
      value: "sk_live_stub_value",
      owner: SOURCE.infisical,
    });
    expect(desired.get("CHAT_AUDIO_R2_SECRET")?.owner).toBe(SOURCE.r2);
    expect(desired.size).toBe(SOURCES.infisical.length + 5);
  });

  it("refuses an empty Infisical read", () => {
    expect(() => pushedEntries({ infisical: [], r2: SOURCES.r2 })).toThrow(
      "refusing an empty push",
    );
  });

  it("refuses one name arriving from both sources", () => {
    const clash = { infisical: [{ key: "CHAT_AUDIO_R2_SECRET", value: "x" }], r2: SOURCES.r2 };
    expect(() => pushedEntries(clash)).toThrow("comes from both");
  });

  it("refuses a key that is not an environment variable name", () => {
    const bad = { infisical: [{ key: "NOT-A-NAME", value: "x" }], r2: SOURCES.r2 };
    expect(() => pushedEntries(bad)).toThrow("not an environment variable name");
  });
});
