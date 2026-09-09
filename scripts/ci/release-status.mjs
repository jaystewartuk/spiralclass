#!/usr/bin/env node
/**
 * What is actually live, and what is merely merged.
 *
 * Before D-120 this question had a mechanical answer: a push moved the
 * branch and CI shipped web and mobile from it, so "the branch" was the answer.
 * Now three things ship separately — preview web, production web, and mobile,
 * from a laptop — and nothing anywhere disagrees when one of them is skipped.
 * That is the whole risk those two decisions took on, and this is the smallest
 * thing that makes it visible.
 *
 *   pnpm release:status
 *
 * Sources, and what they can honestly tell you:
 *   - `origin/main` / `origin/production` — the git truth, always correct.
 *   - .gate/release.json — what THIS machine shipped (scripts/ci/lib.mjs). A
 *     promote run from another checkout or another machine leaves no entry, so
 *     a missing record prints as "no local record", never as "did not ship".
 *
 * Exits 1 when something is behind, so it can gate a script. It is a status
 * command with an opinion: on this repo, "web is live and mobile is three
 * commits back" is not information, it is a bug someone has to act on.
 */

import { capture, check, fmtMs, lastRelease, readLedger } from "./lib.mjs";

const short = (sha) => (sha ? sha.slice(0, 7) : "—");

// Best-effort: an offline run still reports from what it has rather than
// failing, it just says the refs may be stale.
const fetched = check("git", ["fetch", "--no-tags", "--quiet", "origin", "main", "production"]);

const mainSha = capture("git", ["rev-parse", "origin/main"]);
const prodSha = capture("git", ["rev-parse", "origin/production"]);

const behind = (from, to) => {
  if (!from || !to || from === to) return 0;
  const n = capture("git", ["rev-list", "--count", `${from}..${to}`]);
  return Number.parseInt(n || "0", 10);
};

const ageOf = (entry) =>
  entry?.at ? fmtMs(Date.now() - new Date(entry.at).getTime()) + " ago" : "";

/**
 * One line per shippable thing.
 * @returns {{label: string, live: string, target: string, drift: number, note: string}}
 */
function row(label, entry, targetSha, extra = "") {
  const liveSha = typeof entry?.sha === "string" ? entry.sha : "";
  const drift = liveSha ? behind(liveSha, targetSha) : -1;
  return {
    label,
    live: liveSha ? `${short(liveSha)} ${ageOf(entry)}` : "no local record",
    target: short(targetSha),
    drift,
    note: extra,
  };
}

const rows = [
  row("preview web", lastRelease({ kind: "web-deploy", env: "preview" }), mainSha),
  row("production web", lastRelease({ kind: "web-deploy", env: "production" }), prodSha),
];

for (const env of ["preview", "production"]) {
  // A generation is shipped by an OTA *or* by a build+install; the newest of
  // either is what devices on that channel can be running.
  const ota = lastRelease({ kind: "mobile-ota", env });
  const build = lastRelease({ kind: "mobile-build", env });
  const newest = !ota || (build && new Date(build.at) > new Date(ota.at)) ? (build ?? ota) : ota;
  rows.push(
    row(
      `${env} mobile`,
      newest,
      env === "preview" ? mainSha : prodSha,
      newest
        ? `${newest.kind === "mobile-ota" ? "OTA" : "build"} · rv ${newest.runtimeVersion ?? "?"}`
        : "",
    ),
  );
}

const width = Math.max(...rows.map((r) => r.label.length));
console.log(`\n  ${"".padEnd(width)}  shipped               target   drift`);
console.log(`  ${"─".repeat(width + 40)}`);
for (const r of rows) {
  const drift = r.drift < 0 ? "?" : r.drift === 0 ? "up to date" : `${r.drift} commit(s) behind`;
  console.log(
    `  ${r.label.padEnd(width)}  ${r.live.padEnd(20)}  ${r.target.padEnd(7)}  ${drift}${r.note ? `  (${r.note})` : ""}`,
  );
}

const stale = rows.filter((r) => r.drift > 0);
const unknown = rows.filter((r) => r.drift < 0);

if (!fetched) console.log("\n  (could not fetch origin — refs may be stale)");
if (unknown.length) {
  console.log(
    `\n  No local record for: ${unknown.map((r) => r.label).join(", ")}.` +
      "\n  This machine hasn't shipped them since the ledger existed — that is not" +
      "\n  the same as their not being live. Check Fly if it matters.",
  );
}
if (stale.length) {
  console.log(
    `\n  BEHIND: ${stale.map((r) => `${r.label} (${r.drift})`).join(", ")}\n` +
      "\n  Catch up:" +
      "\n    pnpm ship:preview                       # preview web + mobile" +
      "\n    pnpm promote                            # production web + mobile OTA\n",
  );
  process.exit(1);
}
console.log(
  `\n  Everything this machine ships is current.  (ledger: ${readLedger().entries.length} entries)\n`,
);
