import { describe, expect, it } from "vitest";

import { LOCAL_SENTINEL } from "../../../../scripts/env-config.mjs";
import {
  OWNER,
  planCommitted,
  pushedEntries,
  r2Entries,
  runPush,
  runSyncCommitted,
  vercelClient,
} from "../../../../scripts/vercel-env.mjs";

/**
 * scripts/vercel-env.mjs keeps the Vercel failover's runtime environment a
 * derived copy of the three places Fly's comes from ([D-177]). The project had
 * never deployed, and its dashboard held a July copy of production secrets that
 * nothing refreshed — including names for platforms since decommissioned. A
 * deploy that went green against that store would have served on stale
 * credentials with nothing red.
 *
 * Every case runs against an in-memory Vercel: the module takes `fetch` as a
 * parameter, so the client, the plans and the two runs are all exercised
 * end-to-end without a network or a real token.
 */

type Entry = {
  id: string;
  key: string;
  value: string;
  type: string;
  target: string[];
  comment?: string;
  gitBranch?: string;
};

/** A project env store that answers the four calls the module makes. */
function fakeVercel(initial: Omit<Entry, "id">[] = [], { dropCreates = false } = {}) {
  let next = 0;
  const store: Entry[] = initial.map((e) => ({ id: `env_${next++}`, ...e }));
  const requests: { method: string; url: string; body?: string; auth?: string }[] = [];

  const fetch = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : undefined;
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
    requests.push({ method, url, body, auth });
    const { pathname } = new URL(url);
    const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });

    if (method === "GET" && /^\/v10\/projects\/[^/]+\/env$/.test(pathname)) {
      // Vercel never returns a sensitive value; neither does this.
      return reply(200, {
        envs: store.map(({ value, ...rest }) =>
          rest.type === "sensitive" ? rest : { ...rest, value },
        ),
      });
    }
    if (method === "POST" && /^\/v10\/projects\/[^/]+\/env$/.test(pathname)) {
      const created = JSON.parse(body ?? "[]") as Omit<Entry, "id">[];
      if (!dropCreates) for (const e of created) store.push({ id: `env_${next++}`, ...e });
      return reply(201, { created, failed: [] });
    }
    const one = /^\/v9\/projects\/[^/]+\/env\/([^/]+)$/.exec(pathname);
    if (one && method === "PATCH") {
      const entry = store.find((e) => e.id === one[1]);
      if (!entry) return reply(404, { error: { code: "not_found" } });
      Object.assign(entry, JSON.parse(body ?? "{}"));
      return reply(200, entry);
    }
    if (one && method === "DELETE") {
      const at = store.findIndex((e) => e.id === one[1]);
      if (at === -1) return reply(404, { error: { code: "not_found" } });
      store.splice(at, 1);
      return reply(200, {});
    }
    return reply(400, { error: { code: "unexpected_call" } });
  };

  const client = vercelClient({
    token: "stub-token",
    teamId: "team_stub",
    projectId: "prj_stub",
    fetch: fetch as typeof globalThis.fetch,
  });
  return { store, requests, client };
}

const logger = () => {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line), text: () => lines.join("\n") };
};

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
    { key: "CSP_ENFORCE", value: "0" },
  ],
  r2: {
    "agendaprofe-production-chat-audio": bucket("CHAT_AUDIO_R2", "production"),
    "agendaprofe-preview-chat-audio": bucket("CHAT_AUDIO_R2", "preview", "preview-only-secret"),
  },
};

/**
 * Every secret the sources hold, so a log can be checked against all of them.
 * CSP_ENFORCE's "0" is left out: a one-character value is a substring of any URL.
 */
const SECRET_VALUES = [
  ...SOURCES.infisical.map((e) => e.value).filter((value) => value.length > 1),
  ...Object.values(SOURCES.r2).flatMap((b) => [b.access_key_id, b.secret_access_key]),
];

/** A small committed runtime file: one public value, one __LOCAL__, one Infisical overrides. */
const COMMITTED = [
  { key: "APP_URL", value: "https://spiralclass.com" },
  { key: "GOOGLE_CLIENT_ID", value: LOCAL_SENTINEL },
  { key: "CSP_ENFORCE", value: "1" },
];

const PRODUCTION_ONLY = ["production"];

describe("the R2 credentials are the production buckets', spelled as Fly gets them", () => {
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

  it("matches the names infra/cloudflare-r2/push-fly-secrets.sh writes", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { REPO_ROOT } = await import("../../../../scripts/env-config.mjs");
    const fly = readFileSync(
      join(REPO_ROOT, "infra", "cloudflare-r2", "push-fly-secrets.sh"),
      "utf8",
    );
    for (const suffix of ["BUCKET", "ENDPOINT", "REGION", "ACCESS_KEY", "SECRET"]) {
      expect(fly, `Fly gets no _${suffix}, so the failover must not either`).toContain(
        `$cfg.env_prefix)_${suffix}=`,
      );
    }
  });

  it("refuses a bucket still mid-adoption rather than push the string null", () => {
    const adopting = { ...bucket("CHAT_AUDIO_R2", "production"), access_key_id: null };
    expect(() => r2Entries({ adopting })).toThrow("has no access_key yet");
  });

  it("refuses a state with no production bucket at all", () => {
    expect(() => r2Entries({ p: bucket("CHAT_AUDIO_R2", "preview") })).toThrow(
      "no production buckets",
    );
  });
});

describe("the push owns exactly what it was handed", () => {
  it("refuses an empty Infisical read", () => {
    expect(() => pushedEntries({ infisical: [], r2: SOURCES.r2 })).toThrow(
      "refusing an empty push",
    );
  });

  it("refuses one name arriving from both sources", () => {
    const clash = { infisical: [{ key: "CHAT_AUDIO_R2_SECRET", value: "x" }], r2: SOURCES.r2 };
    expect(() => pushedEntries(clash)).toThrow("comes from both");
  });

  it("creates every value production-only and sensitive, marked with its source", async () => {
    const vercel = fakeVercel();
    const { log } = logger();
    const code = await runPush({
      sources: SOURCES,
      deleteStale: false,
      client: vercel.client,
      log,
    });

    expect(code).toBe(0);
    expect(vercel.store).toHaveLength(3 + 5);
    for (const entry of vercel.store) {
      expect(entry.type, entry.key).toBe("sensitive");
      expect(entry.target, entry.key).toEqual(PRODUCTION_ONLY);
    }
    expect(vercel.store.find((e) => e.key === "STRIPE_SECRET_KEY")?.comment).toBe(OWNER.infisical);
    expect(vercel.store.find((e) => e.key === "CHAT_AUDIO_R2_SECRET")?.comment).toBe(OWNER.r2);
  });

  it("replaces a dashboard entry that also reached preview, or was not sensitive", async () => {
    // The shape the July dashboard actually held: "Production and Preview", encrypted.
    const vercel = fakeVercel([
      {
        key: "STRIPE_SECRET_KEY",
        value: "sk_live_old",
        type: "encrypted",
        target: ["production", "preview"],
      },
    ]);
    const code = await runPush({
      sources: SOURCES,
      deleteStale: false,
      client: vercel.client,
      log: () => {},
    });

    expect(code).toBe(0);
    const stripe = vercel.store.filter((e) => e.key === "STRIPE_SECRET_KEY");
    expect(stripe).toHaveLength(1);
    expect(stripe[0]).toMatchObject({
      value: "sk_live_stub_value",
      type: "sensitive",
      target: PRODUCTION_ONLY,
      comment: OWNER.infisical,
    });
  });

  it("updates an entry already in the right shape in place, so a re-run duplicates nothing", async () => {
    const vercel = fakeVercel();
    await runPush({ sources: SOURCES, deleteStale: false, client: vercel.client, log: () => {} });
    const id = vercel.store.find((e) => e.key === "STRIPE_SECRET_KEY")?.id;

    const rotated = {
      ...SOURCES,
      infisical: SOURCES.infisical.map((e) =>
        e.key === "STRIPE_SECRET_KEY" ? { ...e, value: "sk_live_rotated" } : e,
      ),
    };
    await runPush({ sources: rotated, deleteStale: false, client: vercel.client, log: () => {} });

    expect(vercel.store).toHaveLength(8);
    expect(vercel.store.find((e) => e.key === "STRIPE_SECRET_KEY")).toMatchObject({
      id,
      value: "sk_live_rotated",
    });
  });

  it("fails when Vercel does not hold what it was sent", async () => {
    const vercel = fakeVercel([], { dropCreates: true });
    const out = logger();
    const code = await runPush({
      sources: SOURCES,
      deleteStale: false,
      client: vercel.client,
      log: out.log,
    });
    expect(code).toBe(1);
    expect(out.text()).toContain("Vercel does not hold");
    expect(out.text()).toContain("STRIPE_SECRET_KEY");
  });
});

describe("the push reports what nothing owns, and deletes it only when told", () => {
  const leftovers = () =>
    fakeVercel([
      // A decommissioned platform's secret, from the July copy.
      { key: "SUPABASE_JWT_SECRET", value: "old", type: "encrypted", target: ["preview"] },
      // The deploy's own entry for a key the commit still declares: not stale.
      {
        key: "APP_URL",
        value: "https://spiralclass.com",
        type: "encrypted",
        target: PRODUCTION_ONLY,
        comment: OWNER.committed,
      },
      // The deploy's entry for a key the commit no longer declares: stale.
      {
        key: "RETIRED_FLAG",
        value: "1",
        type: "encrypted",
        target: PRODUCTION_ONLY,
        comment: OWNER.committed,
      },
    ]);

  const reportedStale = (text: string) =>
    [...text.matchAll(/^ {4}([A-Za-z0-9_]+)$/gm)].map((m) => m[1]);

  const push = (
    vercel: ReturnType<typeof fakeVercel>,
    log: (line: string) => void,
    deleteStale: boolean,
  ) => runPush({ sources: SOURCES, deleteStale, client: vercel.client, log, committed: COMMITTED });

  it("without --delete-stale, reports and deletes nothing", async () => {
    const vercel = leftovers();
    const out = logger();
    const code = await push(vercel, out.log, false);

    expect(code).toBe(0);
    expect(reportedStale(out.text())).toEqual(["RETIRED_FLAG", "SUPABASE_JWT_SECRET"]);
    expect(out.text()).toContain("Nothing was deleted");
    expect(vercel.store.map((e) => e.key)).toContain("SUPABASE_JWT_SECRET");
    expect(vercel.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
  });

  it("with --delete-stale, deletes exactly those, and never the deploy's live entries", async () => {
    const vercel = leftovers();
    const code = await push(vercel, () => {}, true);

    expect(code).toBe(0);
    const keys = vercel.store.map((e) => e.key);
    expect(keys).not.toContain("SUPABASE_JWT_SECRET");
    expect(keys).not.toContain("RETIRED_FLAG");
    expect(keys).toContain("APP_URL");
    expect(keys).toContain("STRIPE_SECRET_KEY");
  });
});

describe("the deploy syncs the commit's runtime config, and refuses rather than guess", () => {
  const pushed = (key: string, owner = OWNER.infisical) => ({
    key,
    value: "pushed",
    type: "sensitive",
    target: PRODUCTION_ONLY,
    comment: owner,
  });

  it("refuses, writing nothing, when a __LOCAL__ key was never pushed", async () => {
    const vercel = fakeVercel();
    const out = logger();
    const code = await runSyncCommitted({
      client: vercel.client,
      log: out.log,
      committed: COMMITTED,
    });

    expect(code).toBe(1);
    expect(out.text()).toContain("GOOGLE_CLIENT_ID");
    expect(out.text()).toContain("Nothing on the project was changed");
    expect(vercel.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  it("refuses, writing nothing, when a dashboard value nobody owns would shadow the commit", async () => {
    const vercel = fakeVercel([
      pushed("GOOGLE_CLIENT_ID"),
      {
        key: "APP_URL",
        value: "https://stale.example",
        type: "encrypted",
        target: ["production", "preview"],
      },
    ]);
    const out = logger();
    const code = await runSyncCommitted({
      client: vercel.client,
      log: out.log,
      committed: COMMITTED,
    });

    expect(code).toBe(1);
    expect(out.text()).toContain("dashboard value nobody owns");
    expect(out.text()).toContain("APP_URL");
    expect(vercel.requests.filter((r) => r.method !== "GET")).toHaveLength(0);
  });

  it("writes committed values encrypted and production-only, and leaves a pushed override alone", async () => {
    const vercel = fakeVercel([pushed("GOOGLE_CLIENT_ID"), pushed("CSP_ENFORCE")]);
    const out = logger();
    const code = await runSyncCommitted({
      client: vercel.client,
      log: out.log,
      committed: COMMITTED,
    });

    expect(code).toBe(0);
    expect(vercel.store.find((e) => e.key === "APP_URL")).toMatchObject({
      value: "https://spiralclass.com",
      type: "encrypted",
      target: PRODUCTION_ONLY,
      comment: OWNER.committed,
    });
    // Infisical's value wins, as a Fly secret wins over the file at boot.
    const csp = vercel.store.filter((e) => e.key === "CSP_ENFORCE");
    expect(csp).toHaveLength(1);
    expect(csp[0].comment).toBe(OWNER.infisical);
    expect(out.text()).toContain("CSP_ENFORCE");
    // The __LOCAL__ key's pushed entry is untouched.
    expect(vercel.store.find((e) => e.key === "GOOGLE_CLIENT_ID")?.comment).toBe(OWNER.infisical);
  });

  it("updates its own entry on the next release, and removes one whose key left the file", async () => {
    const vercel = fakeVercel([pushed("GOOGLE_CLIENT_ID"), pushed("CSP_ENFORCE")]);
    await runSyncCommitted({ client: vercel.client, log: () => {}, committed: COMMITTED });
    const id = vercel.store.find((e) => e.key === "APP_URL")?.id;

    const nextRelease = [{ key: "APP_URL", value: "https://next.example" }, COMMITTED[1]];
    vercel.store.push({
      id: "env_retired",
      key: "RETIRED_FLAG",
      value: "1",
      type: "encrypted",
      target: PRODUCTION_ONLY,
      comment: OWNER.committed,
    });
    const code = await runSyncCommitted({
      client: vercel.client,
      log: () => {},
      committed: nextRelease,
    });

    expect(code).toBe(0);
    expect(vercel.store.filter((e) => e.key === "APP_URL")).toEqual([
      expect.objectContaining({ id, value: "https://next.example" }),
    ]);
    expect(vercel.store.map((e) => e.key)).not.toContain("RETIRED_FLAG");
    // A pushed entry for a key the commit dropped is the push's, not the deploy's.
    expect(vercel.store.map((e) => e.key)).toContain("CSP_ENFORCE");
  });

  it("against the real committed file, names every __LOCAL__ runtime key when nothing was pushed", async () => {
    const { parseEnvFile, envFilePath } = await import("../../../../scripts/env-config.mjs");
    const local = parseEnvFile(envFilePath("production", "runtime"))
      .entries.filter((e: { value: string }) => e.value === LOCAL_SENTINEL)
      .map((e: { key: string }) => e.key);
    expect(local.length).toBeGreaterThan(0);

    const plan = planCommitted([]);
    expect(plan.unpushed.sort()).toEqual([...local].sort());
  });
});

describe("no value leaves by a door that is logged or addressed", () => {
  it("names keys only, and puts values in bodies — never in a URL", async () => {
    const vercel = fakeVercel([
      { key: "SUPABASE_JWT_SECRET", value: "old", type: "encrypted", target: ["preview"] },
    ]);
    const out = logger();
    await runPush({ sources: SOURCES, deleteStale: true, client: vercel.client, log: out.log });

    for (const value of SECRET_VALUES) {
      expect(out.text(), "a value reached the log").not.toContain(value);
      for (const request of vercel.requests) {
        expect(request.url, "a value reached a URL").not.toContain(value);
      }
    }
  });

  it("authenticates every call with the token as a bearer header, scoped to the team", async () => {
    const vercel = fakeVercel();
    await runPush({ sources: SOURCES, deleteStale: false, client: vercel.client, log: () => {} });
    expect(vercel.requests.length).toBeGreaterThan(0);
    for (const request of vercel.requests) {
      expect(request.url.startsWith("https://api.vercel.com/")).toBe(true);
      expect(request.url).toContain("teamId=team_stub");
      expect(request.url).not.toContain("stub-token");
      expect(request.auth).toBe("Bearer stub-token");
    }
  });

  it("reports an API error by status and code, not by echoing the response", async () => {
    const client = vercelClient({
      token: "t",
      teamId: "team",
      projectId: "prj",
      fetch: (async () =>
        new Response(
          JSON.stringify({ error: { code: "forbidden", message: "value sk_live_echo rejected" } }),
          {
            status: 403,
          },
        )) as typeof globalThis.fetch,
    });
    await expect(client.list()).rejects.toThrow("HTTP 403 (forbidden)");
    await expect(client.list()).rejects.not.toThrow("sk_live_echo");
  });
});
