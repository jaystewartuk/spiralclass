import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { REPO_ROOT } from "./_tree";

/**
 * `scripts/local/synthetic.sh` is the one probe that runs against the LIVE site.
 * Every other place a booking slug appears — the seed, the E2E and a11y suites,
 * the unit fixtures — runs against a database the seed built.
 *
 * The publication sweep replaced the production teacher's slug everywhere,
 * including here, with the seed's pseudonym `alicia-moreno`. That is right for
 * every other file and wrong for this one: production has no such teacher. The
 * first deploy from this repository (2026-09-13) shipped cleanly, then went red
 * on four probes, all against a 404. Nothing checked, because the probe only
 * runs after a deploy.
 *
 * This cannot ask production which slugs exist. What it can hold is the
 * mistake that happened: the probe's teacher must never be one the seed
 * creates.
 */

const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

/** `TEACHER_SLUG="${TEACHER_SLUG:-<default>}"` — the slug a bare run probes. */
function probeSlug(): string {
  const match = /^TEACHER_SLUG="\$\{TEACHER_SLUG:-([a-z0-9-]+)\}"$/m.exec(
    read("scripts", "local", "synthetic.sh"),
  );
  expect(
    match,
    "synthetic.sh no longer defaults TEACHER_SLUG in the shape this reads",
  ).not.toBeNull();
  return match![1];
}

/** Every booking slug the seed writes: `bookingSlug: "…"` and each hero's `slug: "…"`. */
function seedSlugs(): Set<string> {
  const seed = read("apps", "web", "scripts", "seed.ts");
  const slugs = [...seed.matchAll(/\b(?:bookingSlug|slug):\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
  return new Set(slugs);
}

describe("the production probe targets a real teacher, not a seed fixture", () => {
  it("reads the seed's slugs, so the check below is not vacuous", () => {
    const slugs = seedSlugs();
    expect(slugs.size).toBeGreaterThan(5);
    expect(slugs).toContain("alicia-moreno");
  });

  it("probes a slug the seed does not create", () => {
    const slug = probeSlug();
    expect(
      seedSlugs().has(slug),
      `synthetic.sh probes /b/${slug}, which apps/web/scripts/seed.ts creates. Production has no ` +
        "seed teachers, so every booking-page probe would fail against a 404 after a good deploy.",
    ).toBe(false);
  });
});

/**
 * The 2026-09-13 deploy of #98 shipped, then went red on "rendered no
 * purchasable package" while the live booking page carried ten such links. The
 * body was 134KB and the first link sat at byte 16,700. `printf "$body" |
 * grep -q` under `pipefail`: grep exits on that first match, printf is still
 * writing past the pipe buffer, takes EPIPE, and the pipeline fails — so the
 * probe reported the marker missing precisely because it found it early.
 *
 * So these run the real script against a local server whose pages are larger
 * than any pipe buffer, with each marker near the top.
 *
 * ⚠️ macOS's BSD grep drains its input before exiting, so on a laptop the bug
 * cannot show; GNU grep on the deploy runner stops reading at the match. The
 * `grep` put first on PATH here stops reading early on every machine, so the
 * test fails wherever the script pipes a page into grep, not only on Linux.
 */
const SLUG = "probe";
const PADDING = "x".repeat(1024 * 1024);

/** A grep that reads only the first 4KB of stdin, as GNU grep -q does once it has matched. */
function earlyExitGrep(): string {
  const realGrep = execFileSync("sh", ["-c", "command -v grep"], { encoding: "utf8" }).trim();
  const dir = mkdtempSync(join(tmpdir(), "early-exit-grep-"));
  writeFileSync(join(dir, "grep"), `#!/bin/sh\nhead -c 4096 | ${realGrep} "$@"\n`, {
    mode: 0o755,
  });
  return dir;
}

type Pages = Record<string, { status?: number; body: string }>;

function pages(overrides: Pages = {}): Pages {
  return {
    "GET /": { body: `<a href="/sign-up"></a><a href="/sign-in"></a>${PADDING}` },
    "GET /api/health": { body: '{"status":"ok","db":"ok"}' },
    [`GET /b/${SLUG}`]: { body: `<a href="/b/${SLUG}/buy?package=p1"></a>${PADDING}` },
    [`GET /b/${SLUG}/buy`]: {
      body: `self.__next_f.push([1,"{\\"stripeReady\\":true}"])${PADDING}`,
    },
    "GET /sitemap.xml": { body: `<url><loc>https://x/b/${SLUG}</loc></url>${PADDING}` },
    [`GET /b/${SLUG}/opengraph-image`]: { body: "i".repeat(70_000) },
    "POST /api/stripe/webhook": { status: 401, body: "" },
    ...overrides,
  };
}

let server: Server | undefined;
afterEach(async () => {
  await new Promise((done) => (server ? server.close(done) : done(undefined)));
  server = undefined;
});

async function probe(served: Pages): Promise<string> {
  server = createServer((req, res) => {
    const page = served[`${req.method} ${req.url}`];
    res.writeHead(page?.status ?? (page ? 200 : 404));
    res.end(page?.body ?? "");
  });
  await new Promise<void>((ready) => server!.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;

  // Async, not spawnSync: the server answering the script lives on this event loop.
  const run = await promisify(execFile)("bash", [join(REPO_ROOT, "scripts/local/synthetic.sh")], {
    env: {
      ...process.env,
      PATH: `${earlyExitGrep()}:${process.env.PATH}`,
      BASE_URL: `http://127.0.0.1:${port}`,
      TEACHER_SLUG: SLUG,
      // Nothing listens on 127.0.0.1:443, so that one probe fails fast; it is not under test.
      LIVEKIT_ORIGIN_IP: "127.0.0.1",
    },
    maxBuffer: 16 * 1024 * 1024,
  }).catch((error: { stdout: string; stderr: string }) => error);
  return `${run.stdout}${run.stderr}`;
}

describe("the production probe reads a large page correctly", () => {
  it("passes every body-marked probe when the marker is near the top of a large page", async () => {
    const output = await probe(pages());
    for (const passed of [
      "✓ homepage",
      "✓ /api/health",
      `✓ /b/${SLUG}\n`,
      `✓ /b/${SLUG}/buy`,
      `✓ sitemap lists /b/${SLUG}`,
    ]) {
      expect(output).toContain(passed);
    }
    expect(output).not.toContain("Broken pipe");
  }, 30_000);

  it("still fails a large page that carries no purchasable package", async () => {
    const output = await probe(pages({ [`GET /b/${SLUG}`]: { body: PADDING } }));
    expect(output).toContain(`✗ /b/${SLUG} rendered no purchasable package`);
  }, 30_000);
});
