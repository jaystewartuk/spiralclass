#!/usr/bin/env node
// The Vercel failover's RUNTIME environment, as a derived copy of the three
// places Fly's comes from ([D-177]).
//
// Fly assembles a running app's environment from three sources, and the
// failover has to be handed the same three or it is not the same app:
//
//   1. Infisical `production` at `/`, NOT recursive — what
//      infra/gcp/push-cloudrun-env.sh puts in Cloud Run's secret. `/config` (build
//      values) and `/deploy` (the deploy's own credentials) are excluded for the
//      reasons D-163's addendum gives, and they are excluded here too.
//   2. The production R2 buckets' credentials from infra/cloudflare-r2's Tofu
//      state, through r2Entries() below (D-65).
//   3. config/env/production.runtime.env — committed, non-secret, and sourced by
//      scripts/docker-entrypoint.sh at boot, where a container value for the
//      same key WINS over the file.
//
// Vercel has no entrypoint, so all three have to become project environment
// variables. The first two are secrets and change when an operator rotates
// them; the third is public and changes with the commit. So they are written
// by two different callers, and this file is both:
//
//   push            the operator, from infra/infisical/push-vercel-env.sh, with
//                   sources 1 and 2 on stdin. Every value is `sensitive`, which
//                   Vercel will not decrypt for anyone — not the dashboard, and
//                   not the VERCEL_TOKEN the deploy job holds.
//   sync-committed  the deploy, from scripts/vercel-deploy.sh, with source 3 read
//                   from the commit being deployed — so a changed flag reaches
//                   the failover in the release that changes it, not whenever
//                   someone next remembers a push.
//
// WHO OWNS AN ENTRY is written on the entry, in Vercel's `comment` field, and
// that is what lets two writers share one store without either deleting the
// other's work or a hand-kept list of names. The deploy never touches an entry
// the push owns, and a pushed value for a committed key wins — the same
// precedence the entrypoint gives a Fly secret over the file. An entry nobody
// owns is the dashboard's, and it is reported rather than trusted: the deploy
// refuses to shadow the commit with one, and the push lists it as stale.
//
// ⚠️ VALUES NEVER REACH ARGV OR STDOUT. They arrive on stdin or from a file in
// the commit, leave in an HTTPS body, and every line this prints names keys
// only. An API error is reported by status and Vercel's error code, never by
// echoing the response, in case a future error body quotes what it rejected.
//
// Usage:
//   <sources JSON> | node scripts/vercel-env.mjs push [--delete-stale]
//   node scripts/vercel-env.mjs sync-committed
// Both read VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID from the
// environment, as the Vercel CLI does.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { LOCAL_SENTINEL, envFilePath, parseEnvFile } from "./env-config.mjs";

/** The one environment this target has. Preview is not Vercel's (D-150). */
export const ENVIRONMENT = "production";

/** Who wrote an entry. Changing a string here orphans every entry it wrote. */
export const OWNER = {
  infisical: "spiralclass: pushed from Infisical production /",
  r2: "spiralclass: pushed from infra/cloudflare-r2",
  committed: "spiralclass: synced from config/env/production.runtime.env",
};

const PUSHED = new Set([OWNER.infisical, OWNER.r2]);

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const targetsOf = (entry) =>
  Array.isArray(entry.target) ? entry.target : entry.target ? [entry.target] : [];

/** An entry the production deployment would read. */
const reachesProduction = (entry) => targetsOf(entry).includes(ENVIRONMENT);

/** Exactly production, and no branch. The only shape either writer creates. */
const productionOnly = (entry) => {
  const targets = targetsOf(entry);
  return targets.length === 1 && targets[0] === ENVIRONMENT && !entry.gitBranch;
};

/**
 * `tofu output -json buckets` → five names per PRODUCTION bucket, spelled the
 * way the app reads them (`<env_prefix>_BUCKET`, `_ENDPOINT`, `_REGION`,
 * `_ACCESS_KEY`, `_SECRET`). scripts/cloudrun-env.mjs reuses this for the
 * Cloud Run secret, so both targets get the same names. A null field
 * is a bucket still mid-adoption (see that module's outputs.tf), and pushing it
 * would set a credential to the string "null".
 */
export function r2Entries(buckets) {
  const entries = [];
  for (const [name, bucket] of Object.entries(buckets ?? {})) {
    if (bucket?.environment !== ENVIRONMENT) continue;
    const fields = {
      BUCKET: bucket.bucket,
      ENDPOINT: bucket.endpoint,
      REGION: bucket.region,
      ACCESS_KEY: bucket.access_key_id,
      SECRET: bucket.secret_access_key,
    };
    for (const [suffix, value] of Object.entries(fields)) {
      if (typeof value !== "string" || value === "") {
        throw new Error(`tofu output: bucket ${name} has no ${suffix.toLowerCase()} yet`);
      }
      entries.push({ key: `${bucket.env_prefix}_${suffix}`, value });
    }
  }
  if (entries.length === 0) {
    throw new Error("tofu output: no production buckets — is this infra/cloudflare-r2's state?");
  }
  return entries;
}

/**
 * Everything the push owns, keyed by name. One name arriving from both sources
 * is refused: which one Fly ends up with depends on which script ran last, and
 * copying that ambiguity here would make the failover disagree with Fly by
 * accident.
 */
export function pushedEntries({ infisical, r2 }) {
  if (!Array.isArray(infisical) || infisical.length === 0) {
    throw new Error("Infisical production / returned no secrets — refusing an empty push");
  }
  const desired = new Map();
  const add = (key, value, owner) => {
    if (typeof key !== "string" || !NAME.test(key)) {
      throw new Error(`${owner}: not an environment variable name: ${String(key)}`);
    }
    if (typeof value !== "string") throw new Error(`${owner}: ${key} has no string value`);
    if (desired.has(key)) {
      throw new Error(`${key} comes from both ${desired.get(key).owner} and ${owner}`);
    }
    desired.set(key, { value, owner });
  };
  for (const { key, value } of infisical) add(key, value, OWNER.infisical);
  for (const { key, value } of r2Entries(r2)) add(key, value, OWNER.r2);
  return desired;
}

/** The committed runtime keys. The deploy owns an entry only while its key is here. */
const committedEntries = () => parseEnvFile(envFilePath(ENVIRONMENT, "runtime")).entries;

/**
 * What a push does to the store. Pure: `existing` is Vercel's list, and the
 * result is the writes.
 *
 * An entry for a pushed name that is not already production-only and sensitive
 * is REMOVED rather than edited — Vercel will not hold two production entries
 * for one key, and a type cannot be changed in place. Removing it is not a
 * judgement about stale data; it is making room for the value that replaces it.
 */
export function planPush(
  existing,
  desired,
  { deleteStale = false, committed = committedEntries() } = {},
) {
  const committedKeys = new Set(committed.map((e) => e.key));
  const update = [];
  const create = [];
  const replace = [];
  const stale = [];
  const accounted = new Set();

  for (const [key, { value, owner }] of desired) {
    const same = existing.filter((e) => e.key === key);
    const keep = same.find((e) => productionOnly(e) && e.type === "sensitive");
    for (const entry of same) {
      if (entry === keep || !reachesProduction(entry)) continue;
      replace.push(entry);
      accounted.add(entry.id);
    }
    if (keep) {
      update.push({ id: keep.id, key, value, comment: owner });
      accounted.add(keep.id);
    } else {
      create.push({ key, value, comment: owner });
    }
  }

  for (const entry of existing) {
    if (accounted.has(entry.id)) continue;
    // The deploy's, while the commit still declares the key. Not this push's to judge.
    if (entry.comment === OWNER.committed && committedKeys.has(entry.key)) continue;
    stale.push(entry);
  }

  return { update, create, replace, stale, remove: deleteStale ? stale : [] };
}

/** Pushed names Vercel does not hold in the shape the push writes. */
export function missingPushed(existing, desired) {
  return [...desired.keys()].filter(
    (key) => !existing.some((e) => e.key === key && productionOnly(e) && e.type === "sensitive"),
  );
}

/**
 * What a deploy does to the store, or why it refuses. Pure, like planPush.
 *
 *   * A `__LOCAL__` key must already be there from the push. Its value is not in
 *     git, so the deploy has nothing to write — and booting without it breaks
 *     sign-in or checkout with nothing red, which is why the Cloud Run
 *     entrypoint refuses to boot in the same case.
 *   * A key the push also holds is left alone: Infisical wins, as a Fly secret
 *     wins over the file.
 *   * A production entry nobody owns is refused. It is a dashboard value that
 *     would shadow the commit, and the only honest options are the operator's:
 *     move it to Infisical, or delete it with the push's --delete-stale.
 */
export function planCommitted(existing, committed = committedEntries()) {
  const keys = new Set(committed.map((e) => e.key));
  const update = [];
  const create = [];
  const remove = [];
  const unpushed = [];
  const unowned = [];
  const overridden = [];

  for (const { key, value } of committed) {
    const production = existing.filter((e) => e.key === key && reachesProduction(e));
    const pushed = production.some((e) => PUSHED.has(e.comment));

    if (value === LOCAL_SENTINEL) {
      if (!pushed) unpushed.push(key);
      continue;
    }
    if (pushed) {
      overridden.push(key);
      continue;
    }
    if (production.some((e) => e.comment !== OWNER.committed)) {
      unowned.push(key);
      continue;
    }
    const keep = production.find((e) => productionOnly(e) && e.type === "encrypted");
    for (const entry of production) if (entry !== keep) remove.push(entry);
    if (keep) update.push({ id: keep.id, key, value, comment: OWNER.committed });
    else create.push({ key, value, comment: OWNER.committed });
  }

  // A key that left the file takes its entry with it.
  for (const entry of existing) {
    if (entry.comment === OWNER.committed && !keys.has(entry.key)) remove.push(entry);
  }

  return { update, create, remove, unpushed, unowned, overridden };
}

/**
 * The four calls this needs, against one project. `fetch` is injectable so the
 * tests can hold a store in memory; nothing else about the client changes.
 */
export function vercelClient({ token, teamId, projectId, fetch = globalThis.fetch }) {
  const base = `https://api.vercel.com`;
  const project = encodeURIComponent(projectId);
  const team = `teamId=${encodeURIComponent(teamId)}`;

  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Reported by status below.
    }
    if (!response.ok) {
      const code = json?.error?.code ? ` (${json.error.code})` : "";
      // The status rides on the error so a caller that polls can tell a
      // transient 5xx from a refusal it will never get past.
      throw Object.assign(
        new Error(`Vercel API ${method} ${path.split("?")[0]}: HTTP ${response.status}${code}`),
        { status: response.status },
      );
    }
    return json;
  };

  return {
    async list() {
      const json = await call("GET", `/v10/projects/${project}/env?${team}`);
      if (!Array.isArray(json?.envs))
        throw new Error("Vercel API: the env list has no `envs` array");
      return json.envs;
    },
    async create(entries, type) {
      if (entries.length === 0) return;
      const json = await call(
        "POST",
        `/v10/projects/${project}/env?${team}`,
        entries.map(({ key, value, comment }) => ({
          key,
          value,
          comment,
          type,
          target: [ENVIRONMENT],
        })),
      );
      const failed = Array.isArray(json?.failed) ? json.failed : [];
      if (failed.length > 0) {
        const names = failed.map((f) => f?.error?.key ?? f?.error?.envVarKey ?? "?").join(", ");
        throw new Error(`Vercel refused to create: ${names}`);
      }
    },
    async update({ id, value, comment }) {
      await call("PATCH", `/v9/projects/${project}/env/${encodeURIComponent(id)}?${team}`, {
        value,
        comment,
      });
    },
    async remove({ id }) {
      await call("DELETE", `/v9/projects/${project}/env/${encodeURIComponent(id)}?${team}`);
    },
    /** One deployment, by id or by its hostname — scripts/vercel-await.mjs polls this. */
    async deployment(idOrHost) {
      return call("GET", `/v13/deployments/${encodeURIComponent(idOrHost)}?${team}`);
    },
  };
}

/** The three values the Vercel CLI reads from the environment, or a throw naming the absent ones. */
export const credentials = (env) => {
  const missing = ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"].filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`missing ${missing.join(" ")}`);
  return { token: env.VERCEL_TOKEN, teamId: env.VERCEL_ORG_ID, projectId: env.VERCEL_PROJECT_ID };
};

const names = (list) => list.map((e) => (typeof e === "string" ? e : e.key));
const indent = (list) =>
  names(list)
    .map((n) => `    ${n}`)
    .join("\n");

/** The operator's push. Resolves to an exit code; `log` receives names only. */
export async function runPush({
  sources,
  deleteStale,
  client,
  log,
  committed = committedEntries(),
}) {
  const desired = pushedEntries(sources);
  const plan = planPush(await client.list(), desired, { deleteStale, committed });

  log(`› Pushing ${desired.size} value(s) to the production environment as sensitive…`);
  for (const entry of plan.replace) await client.remove(entry);
  for (const entry of plan.update) await client.update(entry);
  await client.create(plan.create, "sensitive");
  if (plan.replace.length > 0) {
    log(
      `    replaced ${plan.replace.length} entry(ies) that were not production-only and sensitive`,
    );
  }

  // Re-read rather than trust the responses: what Vercel lists is the only
  // evidence of what it holds.
  log("› Verifying against what Vercel now holds…");
  let held = await client.list();
  const missing = missingPushed(held, desired);
  if (missing.length > 0) {
    log(`  Pushed, but Vercel does not hold, production-only and sensitive:\n${indent(missing)}`);
    return 1;
  }

  if (plan.stale.length > 0) {
    log(
      `\n  On the project, and neither pushed nor declared in config/env/production.runtime.env:`,
    );
    log(indent([...new Set(names(plan.stale))].sort()));
    if (!deleteStale) {
      log("\n  Nothing was deleted. The deploy refuses to shadow a committed key with one of");
      log("  these, and any of them reaches the running failover. Re-run with --delete-stale.");
    } else {
      for (const entry of plan.remove) await client.remove(entry);
      held = await client.list();
      const remaining = plan.remove.filter((r) => held.some((e) => e.id === r.id));
      if (remaining.length > 0) {
        log(`  Deleted, but Vercel still lists:\n${indent(remaining)}`);
        return 1;
      }
      log(`    deleted ${plan.remove.length} entry(ies)`);
    }
  }

  log(`\nDone. ${desired.size} value(s) on the failover's production environment.`);
  log("⚠️ Re-run this after ANY rotation in Infisical or in Tofu — nothing can read a");
  log("   sensitive value back to notice it has gone stale.");
  return 0;
}

/** The deploy's sync. Refuses before writing anything if it would have to guess. */
export async function runSyncCommitted({ client, log, committed = committedEntries() }) {
  const plan = planCommitted(await client.list(), committed);

  if (plan.unpushed.length > 0 || plan.unowned.length > 0) {
    if (plan.unpushed.length > 0) {
      log(`  __LOCAL__ in config/env/production.runtime.env, and not pushed to the project:`);
      log(indent(plan.unpushed));
      log("  Booting without these breaks sign-in or checkout with nothing red. Add them to");
      log("  Infisical production at / and run infra/infisical/push-vercel-env.sh.");
    }
    if (plan.unowned.length > 0) {
      log(`  Committed runtime keys that also have a dashboard value nobody owns:`);
      log(indent(plan.unowned));
      log("  That value would shadow the commit. Move it to Infisical if it is an override,");
      log("  or run infra/infisical/push-vercel-env.sh --delete-stale if it is not.");
    }
    log("  Refusing to deploy. Nothing on the project was changed.");
    return 1;
  }

  for (const entry of plan.remove) await client.remove(entry);
  for (const entry of plan.update) await client.update(entry);
  await client.create(plan.create, "encrypted");

  log(
    `› Synced ${plan.update.length + plan.create.length} committed runtime value(s)` +
      (plan.remove.length > 0 ? `, removed ${plan.remove.length}` : "") +
      ".",
  );
  if (plan.overridden.length > 0) {
    log(`  Left to the value pushed from Infisical, as Fly does:\n${indent(plan.overridden)}`);
  }
  return 0;
}

async function main(argv, env) {
  const [command, ...flags] = argv;
  const log = (line) => process.stderr.write(`${line}\n`);
  const usage = "usage: vercel-env.mjs push [--delete-stale] | sync-committed";

  if (command === "push") {
    const unknown = flags.filter((f) => f !== "--delete-stale");
    if (unknown.length > 0) {
      log(`unknown argument: ${unknown[0]}\n${usage}`);
      return 1;
    }
    const client = vercelClient(credentials(env));
    let sources;
    try {
      sources = JSON.parse(readFileSync(0, "utf8"));
    } catch {
      // Not the parser's message: it quotes the text around the error, which is
      // a secret value.
      log("vercel-env: stdin is not valid JSON");
      return 1;
    }
    return runPush({ sources, deleteStale: flags.includes("--delete-stale"), client, log });
  }
  if (command === "sync-committed" && flags.length === 0) {
    return runSyncCommitted({ client: vercelClient(credentials(env)), log });
  }
  log(usage);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`vercel-env: ${error.message}\n`);
      process.exit(1);
    },
  );
}
