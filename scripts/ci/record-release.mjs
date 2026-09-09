#!/usr/bin/env node
/**
 * Write one entry into the release ledger (.gate/release.json) from a shell
 * script. The ledger's readers are Node; its most important writer is
 * scripts/fly-deploy.sh, which is bash — this is the seam between them.
 *
 * It lives at the END of the deploy rather than in promote.mjs on purpose: a
 * deploy re-run by hand after a failed promote (`./scripts/fly-deploy.sh
 * production --gate-already-passed`) is exactly the case where the ledger would
 * otherwise be wrong, and it is also the case where someone is most likely to
 * be relying on it.
 *
 *   node scripts/ci/record-release.mjs --kind web-deploy --env production
 */

import { git, recordRelease } from "./lib.mjs";

const argv = process.argv.slice(2);
const valueOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const kind = valueOf("--kind");
const env = valueOf("--env");
if (!kind || !env) {
  console.error("usage: record-release.mjs --kind <kind> --env <preview|production>");
  process.exit(1);
}

recordRelease({ kind, env, sha: valueOf("--sha") ?? git.sha() });
