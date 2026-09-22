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

async function probe(served: Pages, extraEnv: Record<string, string> = {}): Promise<string> {
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
      ...extraEnv,
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

describe("the LiveKit origin check follows where production's video actually is", () => {
  /**
   * [D-182] moved production video to LiveKit Cloud on 2026-09-19. The origin
   * certificate check is about the self-hosted BOX, so from that moment it was
   * a guard whose subject production no longer used — and it went red on every
   * release, reading as "production is broken" while production was fine.
   *
   * It is now derived from config/env/production.runtime.env, so it returns by
   * itself the day that file points at the box again. These two tests are the
   * pair: one holds the skip while D-182 stands, the other proves the check has
   * not simply been deleted.
   */
  const livekitUrl = () =>
    /^LIVEKIT_URL=(.+)$/m.exec(read("config", "env", "production.runtime.env"))?.[1]?.trim();

  it("reads a LIVEKIT_URL from the committed config, so the checks below are not vacuous", () => {
    expect(livekitUrl(), "production.runtime.env names no LIVEKIT_URL").toBeTruthy();
  });

  /** The host production dials — parsed, never matched as a substring. */
  const livekitHost = () => {
    const url = livekitUrl();
    return url ? new URL(url).hostname : undefined;
  };

  it("skips the origin cert while production dials LiveKit Cloud, and says why", async () => {
    // Guarded on the real config: if D-182 is ever reversed this expectation
    // stops applying, and the next test is the one that must hold instead.
    //
    // ⚠️ Compared as a HOST. The first version asked whether the URL *contained*
    // "livekit.spiralclass.com", which CodeQL failed as incomplete URL
    // sanitization and was right to — that substring can sit anywhere in a URL,
    // including in a query string or in front of another domain. The script had
    // the same bug and is fixed in the same commit; this is the test that would
    // otherwise have gone on agreeing with it.
    if (livekitHost() === "livekit.spiralclass.com") return;
    const output = await probe(pages());
    expect(output).toContain("– LiveKit origin cert");
    expect(output).toContain("D-182");
    expect(output, "a skipped check was counted as a failure").not.toContain(
      "could not read a certificate",
    );
  }, 30_000);

  it("runs the origin cert check when the config does point at the box", async () => {
    // The half that stops this being a deletion. LIVEKIT_HOST is overridden to
    // whatever the config currently names, which makes the script take the
    // self-hosted branch; nothing listens on 127.0.0.1:443, so it fails there —
    // and failing is the proof that the branch was entered at all.
    const host = livekitHost()!;
    const output = await probe(pages(), { LIVEKIT_HOST: host, LIVEKIT_ORIGIN_IP: "127.0.0.1" });
    expect(output).toContain("could not read a certificate from the LiveKit origin");
    expect(output).not.toContain("– LiveKit origin cert");
  }, 30_000);

  it("refuses to start when the box is production's host and no origin address was given", async () => {
    const host = livekitHost()!;
    const output = await probe(pages(), { LIVEKIT_HOST: host, LIVEKIT_ORIGIN_IP: "" });
    expect(output).toContain("LIVEKIT_ORIGIN_IP is unset");
  }, 30_000);
});
