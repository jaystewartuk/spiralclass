#!/usr/bin/env node
/**
 * `turbo`, with one cache shared by every checkout on this machine (D-146).
 *
 * Turborepo's filesystem cache defaults to `.turbo/cache` INSIDE the repo. With
 * one checkout that is exactly right. With seven — the main clone plus a git
 * worktree per Claude Code session, which is how this repo is actually worked
 * on — it means seven caches that never see each other, so seven sessions each
 * pay full price for the identical `tsc --noEmit` over a package neither of
 * them touched.
 *
 * Turbo's cache key is a content hash (task, package contents, dependencies,
 * declared env), not a path, so the same inputs in a different directory are
 * the same entry. Measured on this machine: a cold `typecheck` of
 * @spiralclass/shared took 1.5s in one worktree and 302ms as FULL TURBO in a
 * different checkout at a different commit, from the cache the first one wrote.
 * Most branches differ from `main` in a handful of files, so most packages are
 * a hit in every other worktree the moment one of them builds it.
 *
 * This wrapper exists rather than a `cacheDir` in turbo.json because that field
 * is resolved relative to the repo root, and "the repo root" is a different
 * directory in each worktree — the one thing the shared cache must not depend
 * on. An exported TURBO_CACHE_DIR in a shell profile would work too, but only
 * for shells that sourced it, which excludes hooks and agent sessions.
 *
 * Set TURBO_CACHE_DIR yourself and this defers to it. In a container (the Fly
 * image build runs `pnpm build`) there may be no writable HOME; that is not an
 * error, it just means the default in-repo cache, which is correct there.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const env = { ...process.env };

if (!env.TURBO_CACHE_DIR) {
  try {
    const dir = resolve(homedir(), ".cache", "turbo", "spiralclass");
    mkdirSync(dir, { recursive: true });
    env.TURBO_CACHE_DIR = dir;
  } catch {
    // No writable home (container build). Fall through to turbo's own default.
  }
}

const child = spawn("turbo", process.argv.slice(2), { stdio: "inherit", env, shell: false });
child.on("error", (err) => {
  console.error(`turbo: ${err.message}`);
  process.exit(127);
});
child.on("close", (code) => process.exit(code ?? 1));
