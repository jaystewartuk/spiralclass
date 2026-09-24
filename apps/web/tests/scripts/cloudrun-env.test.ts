import { execFileSync, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  APP_SOURCE_DIRS,
  RUNTIME_BUILT_PREFIXES,
  SOURCE,
  appSourceNames,
  partitionByUse,
  pushedEntries,
  r2Entries,
} from "../../../../scripts/cloudrun-env.mjs";
import { SERVER_ENV_KEYS } from "@/lib/env";
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

/**
 * `/` is the running app's environment (D-163), and everything in it used to
 * reach every instance. On 2026-09-24 that was 73 names, four of which nothing
 * in the app reads.
 */
describe("the secret carries only names the app reads", () => {
  const readable = new Set(["STRIPE_SECRET_KEY", "GOOGLE_CLIENT_ID"]);

  it("keeps a name the app's source names and leaves out one it never does", () => {
    const { kept, omitted } = partitionByUse(
      [...SOURCES.infisical, { key: "SEED_ONLY_VALUE", value: "x" }],
      readable,
    );
    expect(kept.map((e) => e.key)).toEqual(["STRIPE_SECRET_KEY", "GOOGLE_CLIENT_ID"]);
    expect(omitted).toEqual(["SEED_ONLY_VALUE"]);
  });

  it("keeps a family the app builds at run time", () => {
    const { kept } = partitionByUse([{ key: "RATE_LIMIT_SIGN_IN_EMAIL", value: "5" }], readable);
    expect(kept).toHaveLength(1);
  });

  it("finds every name env.ts parses in the app's source", async () => {
    const names = await appSourceNames(REPO_ROOT);
    const missing = SERVER_ENV_KEYS.filter((k) => !names.has(k));
    expect(missing).toEqual([]);
    // Read with process.env directly rather than through the schema.
    expect(names.has("COMMISSION_RATE_PERCENT")).toBe(true);
  });

  it("accounts for every env name the app builds at run time", () => {
    // A template-built read names no variable a scan can find. Each family must
    // be the R2 set (from the Tofu source, `${prefix}_…`), a build-time
    // NEXT_PUBLIC_ value (never in this secret), or declared in
    // RUNTIME_BUILT_PREFIXES — or the push would silently drop it.
    const reads = execFileSync(
      "git",
      ["grep", "-hoE", "process\\.env\\[`[^`]*`\\]", "--", ...APP_SOURCE_DIRS],
      { cwd: REPO_ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(reads.length).toBeGreaterThan(0);
    const unaccounted = reads.filter((read) => {
      const template = read.slice("process.env[`".length);
      return !(
        template.startsWith("${") ||
        template.startsWith("NEXT_PUBLIC_") ||
        RUNTIME_BUILT_PREFIXES.some((p) => template.startsWith(p))
      );
    });
    expect(unaccounted).toEqual([]);
  });

  it("leaves an unread name out of the file and says so, without refusing the push", () => {
    const sources = {
      ...SOURCES,
      infisical: [...SOURCES.infisical, { key: "stray_unread_credential", value: "do-not-ship" }],
    };
    const r = spawnSync("node", ["scripts/cloudrun-env.mjs", "compose"], {
      cwd: REPO_ROOT,
      input: JSON.stringify(sources),
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("STRIPE_SECRET_KEY=");
    expect(r.stdout).not.toContain("do-not-ship");
    expect(r.stderr).toContain("LEFT OUT 1, which no app source reads: stray_unread_credential");
  });

  it("still refuses one name from both sources, R2-shaped names counting as read", () => {
    const clash = { ...SOURCES, infisical: [{ key: "CHAT_AUDIO_R2_SECRET", value: "x" }] };
    const r = spawnSync("node", ["scripts/cloudrun-env.mjs", "compose"], {
      cwd: REPO_ROOT,
      input: JSON.stringify(clash),
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("comes from both");
  });
});
