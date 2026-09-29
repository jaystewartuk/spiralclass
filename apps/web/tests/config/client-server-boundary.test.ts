import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../../scripts/env-config.mjs";

// No Client Component may reach server-only code through its imports.
//
// `serverEnv()` parses the server env schema and throws when DATABASE_URL,
// SESSION_SECRET and the rest are absent — which, in a browser, they always
// are. A `"use client"` file that imports a helper that calls it type-checks,
// lints, builds and deploys; the page then throws "Invalid server environment"
// on the first render that reaches the helper. That is AGENDAPROFE-2A:
// /admin/payments imported `stripePaymentIntentUrl`, whose dashboard base is
// picked from the secret key's mode, into its client table.
//
// `import "server-only"` catches the same mistake at build time, but only in
// the modules that remember to carry it. This walks the import graph from
// every Client Component instead, so a helper that calls `serverEnv()` without
// the marker is still caught.
//
// The walk stops at a `"use server"` module: a Client Component importing a
// Server Action gets an RPC stub, not the module, so what that module imports
// never reaches the browser.

const SRC = resolve(REPO_ROOT, "apps/web/src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

const sources = new Map<string, string>();
function source(file: string): string {
  let text = sources.get(file);
  if (text === undefined) {
    text = readFileSync(file, "utf8");
    sources.set(file, text);
  }
  return text;
}

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Runtime imports only — `import type` is erased and ships nothing. */
function runtimeImports(file: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\bfrom\s+)?["']([^"']+)["']/gm;
  for (const match of source(file).matchAll(re)) {
    if (match[1]) continue;
    const resolved = resolveImport(file, match[2]!);
    if (resolved) out.push(resolved);
  }
  return out;
}

const directive = (file: string, name: string) =>
  new RegExp(`^\\s*["']use ${name}["']`).test(source(file));

const ENV_MODULE = join(SRC, "lib/env.ts");

/** Why a module must not run in the browser, or null if it may. */
function serverOnlyReason(file: string): string | null {
  const text = source(file);
  if (/^import\s+["']server-only["']/m.test(text)) return 'imports "server-only"';
  if (file !== ENV_MODULE && /\bserverEnv\(/.test(text)) return "calls serverEnv()";
  return null;
}

/** Each import chain from a Client Component to a server-only module. */
function violations(): string[] {
  const found: string[] = [];
  for (const client of walk(SRC).filter((f) => directive(f, "client"))) {
    const parent = new Map<string, string | null>([[client, null]]);
    const queue = [client];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const dep of runtimeImports(current)) {
        if (parent.has(dep) || directive(dep, "server")) continue;
        parent.set(dep, current);
        queue.push(dep);
      }
    }
    for (const reached of parent.keys()) {
      const reason = reached === client ? null : serverOnlyReason(reached);
      if (!reason) continue;
      const chain: string[] = [];
      for (let at: string | null = reached; at; at = parent.get(at) ?? null) {
        chain.unshift(relative(SRC, at));
      }
      found.push(`${chain.join(" → ")} (${reason})`);
    }
  }
  return found;
}

describe("client/server import boundary", () => {
  it("no Client Component imports a module that must stay on the server", () => {
    expect(
      violations(),
      "A Client Component reaches server-only code. In the browser serverEnv() throws " +
        '"Invalid server environment". Compute the value in the Server Component and ' +
        "pass it down as a prop.",
    ).toEqual([]);
  });
});
