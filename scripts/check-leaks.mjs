#!/usr/bin/env node
/**
 * Scan the repo for credential material and personal data.
 *
 * Two different problems live here, so there are two different gates.
 *
 * SECRETS — zero tolerance, no baseline.
 * A live key committed to git is compromised the moment it lands, and stays
 * compromised through every clone, fork and CI log after it. There is no such
 * thing as a grandfathered live key: the only remedy is rotation. So this half
 * fails on any match, and the patterns are tuned to be near-impossible to
 * trigger accidentally — a documented prefix (`sk_live_*` in a comment), a short
 * test fixture (`sk_live_abc`), or a regex literal (`/BEGIN PRIVATE KEY/`) must
 * NOT match, or the check becomes noise people learn to skip.
 *
 * ACCOUNT IDENTIFIERS — zero tolerance, no baseline.
 * Not credentials: an OCID, a Stripe account id, a GCP project, a box's public
 * address. None of them is usable on its own, which is exactly why they get
 * committed without anyone flinching. In a PUBLIC repository they are the
 * reconnaissance surface — they say which accounts, boxes and tenants the
 * operator owns, and they aggregate. D-158 settles where each one lives
 * instead; this half is what keeps that true after the day someone writes it
 * down. Patterns only, never values: a checker that lists the identifiers it
 * is looking for republishes them.
 *
 * PEOPLE — zero tolerance, declared roster.
 * A person's name has no shape. `Renata Ocampo` and a real student's name are
 * the same nine-ish characters, so no pattern can tell them apart and the two
 * sweeps before this one both missed real names that were sitting in comments
 * and fixtures. What CAN be checked is whether somebody said which it is: this
 * half finds full names by shape (a known first name followed by a capitalised
 * word), then fails on any that is not declared in scripts/fixture-personas.json.
 * Reading is done on a REFLOWED copy of each file, because the names that
 * survived every earlier sweep survived by having a line break in the middle.
 *
 * PERSONAL DATA — ratcheted against a baseline.
 * Real email addresses reach a repo through ordinary work: a seeded pilot
 * teacher, a debugging fixture built from a real roster, a support thread
 * pasted into a doc. (Phone numbers are deliberately out of scope — see the
 * note above PERSONAL_EMAIL.) This repo already contains some
 * on purpose (a tester's address as a seed fixture; the operator's own address
 * as the superadmin allowlist). Deleting those is a product decision,
 * not something a tooling check gets to force. So existing occurrences are
 * recorded in scripts/check-leaks.baseline.json and NEW ones fail — the same
 * ratchet the i18n guard uses, for the same reason: stop the bleeding without
 * blocking on a cleanup nobody scheduled.
 *
 *   node scripts/check-leaks.mjs             check (exit 1 on a violation)
 *   node scripts/check-leaks.mjs --generate  rewrite the personal-data baseline
 *
 * Regenerate the baseline ONLY when you have consciously added personal data
 * and decided it belongs there. Regenerating to make a red check go green is
 * exactly the failure this file exists to prevent.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
export const BASELINE_PATH = join(REPO_ROOT, "scripts", "check-leaks.baseline.json");

/**
 * Trees worth scanning. Everything else is generated, vendored or huge.
 *
 * `.` is here so REPO-ROOT files are covered — `Dockerfile`, `justfile`,
 * `fly.*.toml`, `wrangler.jsonc`, `CLAUDE.md`, `README.md`. A 2026-09-06
 * publication audit found 368 tracked files this scanner had never looked at,
 * and every one of them was either at the root, in a dotdir, under
 * `prisma/migrations/`, or carried an extension not in the list below. They
 * were clean — but a guarantee with a hole in it is not the guarantee anyone
 * thinks they have. The recursion below skips dotdirs it must not walk
 * (`.git`, `.next`, `.turbo`) by name, so adding `.` costs nothing.
 */
const SCAN_ROOTS = ["."];

const SCAN_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
  ".md",
  ".sh",
  ".example",
  ".tfvars",
  // config/env/*.env is the committed non-secret tier (D-85). It is the single
  // likeliest place for a real credential to be pasted by mistake — it already
  // looks like an env file and it is already committed — and until 2026-09 the
  // scanner did not look at it at all.
  ".env",
  // infra/*.hcl — partial backend configs. Same reasoning: committed on purpose,
  // sits beside the files that hold the credentials, so worth watching.
  ".hcl",
  // infra/*.tf — the OpenTofu itself. Added 2026-09-05 with the identifier
  // gate: a module names the resources it manages, so it is the single most
  // likely place for an OCID or a box address to be committed on purpose.
  ".tf",
  // Added 2026-09-06 with the root-tree widening above. Each is a file type
  // that was tracked, was committed on purpose, and was invisible to this
  // scanner: Fly/Prisma config (.toml), the docs-site Worker (.jsonc), the
  // cloud-init template that provisions a box (.tftpl), the import templates a
  // teacher's real roster gets pasted into (.csv), the schema (.prisma), and
  // brand/docs assets that an export tool can stamp with an author or a path
  // (.svg, .css, .txt).
  ".toml",
  ".jsonc",
  ".tftpl",
  ".csv",
  ".prisma",
  ".svg",
  ".css",
  ".txt",
];

/**
 * Extension-less files that are still source. Matched by exact basename,
 * because "no extension" alone would pull in every binary in the tree.
 */
const SCAN_BASENAMES = new Set(["Dockerfile", "Caddyfile", "justfile", "CODEOWNERS", "pre-push"]);

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".expo",
  ".turbo",
  "dist",
  "build",
  "coverage",
  ".git",
  "android",
  "ios",
  // Everything below is a consequence of SCAN_ROOTS becoming ".": these are
  // gitignored working state, not source, and walking them is slow rather than
  // wrong. `gitignoredPaths()` would exclude their contents from the REPORT
  // anyway — this stops us reading 688 MB of screenshots to reach that
  // conclusion.
  ".gate",
  ".venv-docs",
  "site",
  "playwright-report",
  "test-results",
  "worktrees",
]);

/**
 * ⚠️ `migrations` is NOT skipped any more. It was, on the reasoning that a
 * migration is generated SQL — but a data migration is hand-written, and a
 * backfill is exactly where a real row would be pasted. The 45 migrations here
 * are clean; the point is that nothing was checking.
 */

const SKIP_FILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "check-leaks.baseline.json",
  // This file lists the provider domains it searches for, so scanning it would
  // report the detector as its own first finding.
  "check-leaks.mjs",
  // Same reason, one level out: the detector's test drives each pattern with a
  // fixture OF THE SHAPE THE PATTERN MATCHES, so a scanned test file reports
  // every one of them. Allowlisting the fixture values instead does not work —
  // the allowlist is applied inside findIdentifiers(), so it would filter the
  // very assertions that prove the pattern fires.
  //
  // ⚠️ This is a blind spot, and a real id hidden here would not be reported.
  // It is two files wide, both of them the gate itself, and both get read line
  // by line whenever the gate is touched. The fixtures are invented values that
  // belong to nobody — never the real ones, which is what this whole mechanism
  // exists to keep out of the tree.
  "check-leaks.test.ts",
  // The people-gate's own data. `given-names.json` is a dictionary of first
  // names and `fixture-personas.json` is the roster itself — scanning either
  // reports the gate as its own finding.
  "given-names.json",
  "fixture-personas.json",
]);

/* ------------------------------------------------------------------ *
 * Secrets
 * ------------------------------------------------------------------ */

/**
 * Every pattern requires enough trailing entropy to distinguish a real key from
 * a prefix mentioned in prose or a short test stub.
 */
const SECRET_PATTERNS = [
  {
    name: "Stripe live secret/restricted key",
    // Real keys are ~100 chars. 20 is far above any fixture, far below real.
    pattern: /\b(sk|rk)_live_[A-Za-z0-9]{20,}/,
  },
  {
    name: "Stripe live publishable key",
    pattern: /\bpk_live_[A-Za-z0-9]{20,}/,
  },
  {
    name: "Stripe webhook signing secret",
    pattern: /\bwhsec_[A-Za-z0-9]{24,}/,
  },
  {
    name: "AWS access key id",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    name: "PEM private key block",
    // The full armour, not the bare words — `/BEGIN PRIVATE KEY/` as a regex
    // literal in a test is not a key.
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    name: "Postgres URL with an inline password",
    // Placeholder passwords (test, stub, password, xxx, ${VAR}) are excluded by
    // the value check below rather than by the pattern.
    pattern: /postgres(?:ql)?:\/\/[^:\s"']+:([^@\s"']+)@/,
  },
];

/**
 * Values that match a secret pattern but are provably not secrets.
 *
 * Each entry needs a reason. This list is a hole in the check; keep it small.
 */
const SECRET_ALLOWLIST = [
  {
    // AWS publishes this exact key in its SigV4 signing documentation; the
    // sigv4 tests use it so their expected signatures match AWS's worked
    // examples byte for byte.
    value: "AKIAIOSFODNN7EXAMPLE",
    reason: "AWS's canonical documentation example key",
  },
];

/**
 * Files exempt from a specific secret pattern, with justification.
 */
const SECRET_FILE_EXEMPTIONS = [
  // EMPTY, and it should stay that way. Entries have lived here and were
  // removed once the file they named stopped holding the value:
  //
  //   `config/env/production.build.env` — the Stripe publishable key, inlined
  //   into the client bundle at build time. It is the `__LOCAL__` sentinel now
  //   (D-158, docs/security.md), so nothing in that file can match.
  //
  // An exemption for a value that is no longer there is a hole nobody re-reads:
  // it silently permits the pattern in that exact file, which is where a block
  // of pasted dashboard output — `pk_live_` with the `sk_live_` beside it —
  // would land. Add one back only alongside a value that is actually present.
];

/** Placeholder DB passwords that are obviously not credentials. */
const PLACEHOLDER_PASSWORDS =
  /^(test|stub|password|pass|postgres|secret|changeme|x+|\$\{[^}]+\}|<[^>]+>|\*+)$/i;

/**
 * Below this length a connection-string password is a fixture, not a credential.
 * Every compose file, CI service and unit test writes things like
 * `postgresql://u:p@host/db`; none of them is a leak.
 */
const MIN_REAL_PASSWORD_LENGTH = 8;

export function findSecrets(relPath, source) {
  const findings = [];

  source.split("\n").forEach((line, index) => {
    for (const { name, pattern } of SECRET_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;

      if (SECRET_ALLOWLIST.some(({ value }) => match[0].includes(value))) continue;
      if (
        SECRET_FILE_EXEMPTIONS.some(
          (exemption) => exemption.file === relPath && exemption.patternName === name,
        )
      ) {
        continue;
      }
      // A connection string whose password is a placeholder or too short to be
      // real is config, not a credential — every CI workflow, compose file and
      // DB unit test has one.
      if (name.startsWith("Postgres")) {
        const password = match[1] ?? "";
        if (PLACEHOLDER_PASSWORDS.test(password)) continue;
        if (password.length < MIN_REAL_PASSWORD_LENGTH) continue;
      }

      findings.push({
        file: relPath,
        line: index + 1,
        kind: name,
        snippet: line.trim().slice(0, 120),
      });
    }
  });

  return findings;
}

/* ------------------------------------------------------------------ *
 * Account identifiers
 * ------------------------------------------------------------------ */

/**
 * Identifiers that name an account, a tenant or a box this operator owns.
 *
 * ⚠ Every pattern here is a SHAPE. None of them contains a real value, and none
 * of them may: this file is committed to a public repository, so a checker that
 * spelled out what it was looking for would publish exactly what it exists to
 * remove.
 *
 * `roots` narrows a pattern to the trees where a real one would live. It exists
 * for the address pattern alone: a routable IPv4 in `infra/` is a box, while in
 * `apps/` it is a bot-detection fixture or a request-header test, and a check
 * that cannot tell those apart becomes noise people learn to skip.
 */
const IDENTIFIER_PATTERNS = [
  {
    name: "OCI resource id (OCID)",
    // The opaque tail is what makes it real — `ocid1.instance.oc1.<region>.<redacted>`
    // is a placeholder and must not match.
    pattern: /\bocid1\.[a-z]+\.oc1\.[a-z0-9-]+\.[a-z0-9]{20,}/,
  },
  {
    name: "GCP project (via a service-account address)",
    pattern: /@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com/,
  },
  {
    name: "Google OAuth client id",
    pattern: /\b\d{10,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com\b/,
  },
  {
    name: "Stripe account, product or price id",
    pattern: /\b(?:acct|prod|price)_[A-Za-z0-9]{14,}\b/,
  },
  {
    name: "R2 public bucket URL",
    pattern: /\bpub-[a-f0-9]{16,}\.r2\.dev\b/,
  },
  {
    name: "Cloudflare account id",
    pattern: /account_id\s*=\s*"?[a-f0-9]{32}"?/,
  },
  {
    name: "PostHog project id",
    // In a dashboard/replay URL, or assigned to the variable that holds it.
    // The bare number is unmatchable — it is five to seven digits and so is
    // every price, timeout and line number in the repo.
    pattern: /posthog\.com\/project\/\d{4,}|POSTHOG_PROJECT_ID\s*[:=]\s*"?\d{4,}/,
  },
  {
    name: "Infisical project id",
    // Scoped to the two places it would be written: the CLI's link file and a
    // shell variable holding it. A bare UUID pattern would match every fixture
    // id in the test suite.
    pattern:
      /(?:"workspaceId"\s*:\s*"|INFISICAL_PROJECT(?:_ID)?\s*=\s*"?)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  },
  {
    name: "Neon project or organisation id",
    // Neon names a project `<adjective>-<noun>-<8 digits>` and an org the same
    // with an `org-` prefix. The digit run is what makes it unambiguous — a
    // hyphenated word pair is every CSS class and slug in the tree, but one
    // ending in exactly eight digits is a Neon id and nothing else.
    //
    // ⚠️ Added 2026-09-06, after a publication audit found THREE of them
    // committed — the production project, the preview project, and the
    // organisation — one of them annotated in a README as the project holding
    // real student data. The identifier gate already covered OCIDs, Stripe
    // accounts and GCP projects and would have caught any of those; it had no
    // pattern for the database. The scanner passed, and that is exactly the
    // failure a shape-based gate is supposed to make impossible.
    //
    // The negative lookahead excludes a real YYYYMMDD, because THIS repo names
    // its Neon checkpoint branches `pre-deploy-<UTC timestamp>-<sha>` — so
    // `pre-deploy-20260906` has the exact shape and is not an id. The hole that
    // opens is a Neon id whose eight random digits happen to spell a calendar
    // date in 2000-2099: 36,500 of 100,000,000, or 0.04%. Worth it to keep the
    // check quiet enough that nobody learns to skip it.
    pattern:
      /\b(?:org-)?[a-z]+-[a-z]+-(?!20\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\b)\d{8}\b/,
  },
  {
    name: "LiveKit API key",
    // Assignment context only. Bare /API[A-Za-z0-9]{10,}/ matches
    // `APIRequestContext` and every sha512 in a lockfile.
    pattern: /LIVEKIT_API_KEY\s*[:=]\s*["']?API[A-Za-z0-9]{10,}/,
  },
  {
    name: "Routable IPv4 address",
    // Everything reserved is excluded by the negative lookahead: this host,
    // private space, link-local, CGNAT/Tailscale (100.64/10), multicast, and
    // the three documentation ranges (192.0.2, 198.51.100, 203.0.113) that
    // placeholders in this repo are drawn from.
    pattern:
      /(?<![\d.])(?!0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/,
    roots: ["infra/", "config/", "scripts/", ".github/", "docs/deployment/", "docs/decisions/"],
  },
];

/**
 * Matches that are provably not this operator's accounts.
 *
 * Anything containing `example` is skipped before this list is consulted — the
 * placeholders every redaction leaves behind are all built that way on purpose,
 * so the common case needs no entries at all. Each entry below needs a reason.
 */
const IDENTIFIER_ALLOWLIST = [
  {
    value: "acct_1H2g3F4e5D6c7B8a",
    reason: "Sequential hand-typed fixture in a page-structure test, not an account",
  },
];

/** Placeholders left behind by a redaction. Never a real identifier. */
const IDENTIFIER_PLACEHOLDER = /example|redacted|<[a-z-]+>/i;

export function findIdentifiers(relPath, source) {
  const findings = [];

  source.split("\n").forEach((line, index) => {
    for (const { name, pattern, roots } of IDENTIFIER_PATTERNS) {
      if (roots && !roots.some((root) => relPath.startsWith(root))) continue;

      const match = line.match(pattern);
      if (!match) continue;
      if (IDENTIFIER_PLACEHOLDER.test(match[0])) continue;
      if (IDENTIFIER_ALLOWLIST.some(({ value }) => match[0].includes(value))) continue;

      findings.push({
        file: relPath,
        line: index + 1,
        kind: name,
        snippet: line.trim().slice(0, 120),
      });
    }
  });

  return findings;
}

/* ------------------------------------------------------------------ *
 * People
 * ------------------------------------------------------------------ */

export const GIVEN_NAMES_PATH = join(REPO_ROOT, "scripts", "given-names.json");
export const PERSONAS_PATH = join(REPO_ROOT, "scripts", "fixture-personas.json");

/** Strip diacritics so `Inés` matches the dictionary's `Ines`. */
function fold(word) {
  return word.normalize("NFD").replace(/\p{Mn}/gu, "");
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

let givenNames = null;
function knownGivenNames() {
  if (!givenNames) givenNames = new Set(loadJson(GIVEN_NAMES_PATH).names.map(fold));
  return givenNames;
}

let declaredNames = null;
export function declaredPeople() {
  if (!declaredNames) {
    const roster = loadJson(PERSONAS_PATH);
    declaredNames = new Set([...roster.personas, ...Object.keys(roster.notPeople)]);
  }
  return declaredNames;
}

/**
 * The roster is matched on a folded, lower-cased key.
 *
 * `Diego Márquez` in a comment and `diego-marquez` in a slug are one person,
 * and a roster that needed both spellings would drift the first time somebody
 * added only one.
 */
let declaredKeys = null;
function isDeclared(name) {
  if (!declaredKeys) {
    declaredKeys = new Set([...declaredPeople()].map((n) => fold(n).toLowerCase()));
  }
  return declaredKeys.has(fold(name).toLowerCase());
}

/**
 * A first name from the dictionary, followed by a capitalised word.
 *
 * Deliberately NOT a bare capitalised pair: `Checkout Session`, `Marketplace
 * Ready` and four hundred others are that shape, and a gate that reports them
 * is a gate people stop reading. Anchoring on the first name is what makes the
 * signal clean enough to be zero-tolerance.
 */
// `\p{M}` is in the class because a decomposed `é` is `e` + a combining
// acute, and without it the match stops at `Jos` and reports a name nobody
// declared — noise, from the one input this repository is full of.
const FULL_NAME = /\b([A-Z][\p{L}\p{M}'’-]{1,})\s+([A-Z][\p{L}\p{M}'’-]{1,})/gu;

/**
 * The same name written as a booking slug: `valentina-rios`, `mira-lopez`.
 *
 * A booking slug IS a person's name — it is what the product puts in a public
 * URL — so it has to resolve onto the same roster entry as the prose form.
 *
 * ⚠️ Anchored to the places a slug actually appears: the `/b/` path, and a
 * field whose name ends in `slug`. A bare kebab-case pattern is unusable here
 * and was tried: `max-age`, `mark-read`, `mark-sent`, `max-width` and thirty
 * more are the same shape, and a gate that reports those is a gate that gets
 * skipped.
 */
const SLUG_NAME = /(?:\/b\/|[Ss]lug["'`:=\s]{1,4})["'`]?([\p{L}\p{M}]{2,})-([\p{L}\p{M}]{2,})/gu;

/** `alicia` → `Alicia`, so a slug and a prose name share one roster entry. */
function titleCase(word) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** `Alicia Moreno's` and `Alicia Moreno’s` are the same person as `Alicia Moreno`. */
function withoutPossessive(word) {
  return word.replace(/[''’]s$/u, "");
}

/**
 * Reflow: join every line to its successor, dropping a comment marker at the
 * start of the continuation.
 *
 * This is the whole reason the gate exists in this form. `Ana\nLaura` in a
 * wrapped comment is invisible to `grep`, to a reviewer scanning a diff, and to
 * every sweep this repository ran before 2026-09-06 — and it is exactly how
 * six occurrences of one real name outlived a rename that was reported as
 * complete.
 */
export function reflow(source) {
  return source.replace(/\s*\n\s*(?:\/\/|#|\*)?\s*/g, " ");
}

export function findPeople(relPath, source) {
  const known = knownGivenNames();
  const findings = [];
  const seen = new Set();
  const flat = reflow(source);

  const record = (first, last) => {
    if (!known.has(fold(first))) return;
    const name = `${first} ${last}`;
    if (isDeclared(name) || seen.has(name)) return;
    seen.add(name);
    findings.push({ file: relPath, name });
  };

  for (const match of flat.matchAll(FULL_NAME)) {
    record(withoutPossessive(match[1]), withoutPossessive(match[2]));
  }

  for (const match of flat.matchAll(SLUG_NAME)) {
    record(titleCase(match[1]), titleCase(match[2]));
  }

  return findings;
}

/* ------------------------------------------------------------------ *
 * Personal data
 * ------------------------------------------------------------------ */

/**
 * Domains that cannot belong to a real person: reserved test TLDs, this repo's
 * own synthetic fixtures, and the company's own role addresses.
 */
const NON_PERSONAL_EMAIL = [
  /@example\.(com|org|net)$/i,
  /@(test|invalid|localhost|local)$/i,
  /\.(test|invalid|example|local)$/i,
  /@spiralclass\.com$/i, // role addresses (soporte@, hola@) — not a person
  /@[a-z0-9-]*sentry\.io$/i,
  /@e2e\.test$/i,
];

/**
 * A free-mail address is the strongest available signal that a string is a real
 * person's contact detail rather than a fixture. Nobody writes
 * `maria@gmail.com` as a placeholder when `maria@example.com` exists for
 * exactly that purpose — so the consumer domain is the discriminator.
 *
 * Phone numbers are deliberately NOT scanned. A real Mexican mobile and a
 * fixture one are the same shape (`+52 55 1234 5678`), so any pattern that
 * catches the real one flags every phone-validation test in the repo too —
 * measured at 52 files, almost all synthetic. A check that cannot separate the
 * thing it is looking for from the thing it is not is not a check; it is a
 * source of baseline churn that teaches people to regenerate without reading.
 * Better to cover emails precisely than phones uselessly.
 */
const PERSONAL_EMAIL =
  /\b[a-zA-Z0-9._%+-]+@(?:gmail|googlemail|hotmail|outlook|yahoo|protonmail|proton|icloud|live|aol|yandex|gmx)\.[a-z.]{2,}\b/gi;

function findPersonalData(source) {
  const hits = [];

  for (const match of source.matchAll(PERSONAL_EMAIL)) {
    const value = match[0];
    if (NON_PERSONAL_EMAIL.some((re) => re.test(value))) continue;
    hits.push(value);
  }

  return hits;
}

/* ------------------------------------------------------------------ *
 * Walk
 * ------------------------------------------------------------------ */

/**
 * Paths git is deliberately not tracking. This scanner walks the filesystem
 * rather than `git ls-files`, which is right — it should catch a credential
 * sitting in the tree before anyone commits it. But a GITIGNORED file is the
 * one place a real value is SUPPOSED to live (config/env/*.local.env,
 * infra/backend.hcl), so reporting those is a false positive that would fire
 * on every run. ⚠ A check that cries wolf gets switched off, which costs more
 * than the finding it was guarding.
 *
 * One batched `git check-ignore` call, because per-file would be thousands.
 */
function gitignoredPaths(files) {
  if (files.length === 0) return new Set();
  const res = spawnSync("git", ["check-ignore", "--stdin"], {
    cwd: REPO_ROOT,
    input: files.join("\n"),
    encoding: "utf8",
  });
  // Exit 1 means "nothing ignored", which is a normal answer, not a failure.
  // Anything else (git missing, not a repo) leaves the set empty, so the
  // scanner falls back to reporting everything rather than silently skipping.
  if (res.status !== 0 && res.status !== 1) return new Set();
  return new Set((res.stdout || "").split("\n").filter(Boolean));
}

function* scannableFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry)) continue;
      yield* scannableFiles(full);
      continue;
    }

    if (SKIP_FILES.has(entry)) continue;
    if (!SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext)) && !SCAN_BASENAMES.has(entry)) continue;
    yield full;
  }
}

/**
 * Scan the repo once, returning both categories plus the paths actually read.
 *
 * `scanned` exists so a test can assert COVERAGE rather than only findings. A
 * walk that silently stopped reaching a tree would make every "nothing found"
 * assertion pass — which is how 368 files went unscanned until 2026-09-06.
 */
export function scanRepo() {
  const secrets = [];
  const identifiers = [];
  const people = [];
  /** @type {string[]} */
  const scanned = [];
  /** @type {Record<string, number>} */
  const personal = {};

  /** @type {string[]} */
  const allFiles = [];
  for (const root of SCAN_ROOTS) {
    const absolute = join(REPO_ROOT, root);
    if (!existsSync(absolute)) continue;
    for (const f of scannableFiles(absolute)) allFiles.push(f);
  }
  const ignored = gitignoredPaths(allFiles.map((f) => relative(REPO_ROOT, f)));

  for (const root of SCAN_ROOTS) {
    const absolute = join(REPO_ROOT, root);
    if (!existsSync(absolute)) continue;

    for (const file of scannableFiles(absolute)) {
      const relPath = relative(REPO_ROOT, file).split("\\").join("/");
      if (ignored.has(relPath)) continue;
      scanned.push(relPath);
      const source = readFileSync(file, "utf8");

      secrets.push(...findSecrets(relPath, source));
      identifiers.push(...findIdentifiers(relPath, source));
      people.push(...findPeople(relPath, source));

      const hits = findPersonalData(source);
      if (hits.length > 0) personal[relPath] = hits.length;
    }
  }

  return { secrets, identifiers, people, personal, scanned };
}

export function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

/**
 * Compare the current personal-data counts against the baseline.
 *
 * Only regressions fail: a new file, or more hits in a known file. A file that
 * improved is reported so the baseline can be tightened, but never fails.
 */
export function comparePersonal(current, baseline) {
  const regressions = [];
  const improvements = [];

  for (const [file, count] of Object.entries(current)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) regressions.push({ file, count, allowed });
  }

  for (const [file, allowed] of Object.entries(baseline)) {
    const count = current[file] ?? 0;
    if (count < allowed) improvements.push({ file, count, allowed });
  }

  return { regressions, improvements };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  const { secrets, identifiers, people, personal } = scanRepo();

  if (process.argv.includes("--generate")) {
    const sorted = Object.fromEntries(
      Object.entries(personal).sort(([a], [b]) => a.localeCompare(b)),
    );
    writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(
      `Wrote ${relative(REPO_ROOT, BASELINE_PATH)} with ${Object.keys(sorted).length} entries.`,
    );
    process.exit(0);
  }

  let failed = false;

  if (secrets.length > 0) {
    failed = true;
    console.error(`\n${secrets.length} possible credential(s) committed:\n`);
    for (const { file, line, kind, snippet } of secrets) {
      console.error(`::error file=${file},line=${line}::${kind}`);
      console.error(`    ${snippet}`);
    }
    console.error(
      "\nA committed key is compromised — rotate it, then remove it from the source.\n" +
        "If this is genuinely not a secret, add a justified entry to SECRET_ALLOWLIST\n" +
        "or SECRET_FILE_EXEMPTIONS in scripts/check-leaks.mjs.\n",
    );
  }

  if (identifiers.length > 0) {
    failed = true;
    console.error(`\n${identifiers.length} account identifier(s) committed:\n`);
    for (const { file, line, kind, snippet } of identifiers) {
      console.error(`::error file=${file},line=${line}::${kind}`);
      console.error(`    ${snippet}`);
    }
    console.error(
      "\nThis repository is public. An identifier names an account, a tenant or a\n" +
        "box — replace it with a placeholder and put the real value where D-158\n" +
        "says it lives (Infisical, a gitignored overlay, or Tofu state). If the\n" +
        "match is genuinely not one of ours, add a justified entry to\n" +
        "IDENTIFIER_ALLOWLIST in scripts/check-leaks.mjs.\n",
    );
  }

  if (people.length > 0) {
    failed = true;
    const byName = new Map();
    for (const { name, file } of people) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(file);
    }
    console.error(`\n${byName.size} undeclared person name(s):\n`);
    for (const [name, files] of byName) {
      console.error(`::error file=${files[0]}::undeclared person name "${name}"`);
      console.error(`    ${files.slice(0, 4).join(", ")}${files.length > 4 ? ", …" : ""}`);
    }
    console.error(
      "\nThis repository is public and a name is not a shape, so every person in\n" +
        "it is declared instead. If this is an INVENTED fixture, add it to\n" +
        "scripts/fixture-personas.json under `personas`. If it is not a name at\n" +
        "all, add it under `notPeople` WITH A REASON.\n\n" +
        "If it is a real person: it does not belong in the tree. Replace it with\n" +
        "a fixture, or read it from the environment the way seed.ts reads the two\n" +
        "addresses it needs.\n",
    );
  }

  const { regressions, improvements } = comparePersonal(personal, loadBaseline());

  if (regressions.length > 0) {
    failed = true;
    console.error(`\nPersonal data added in ${regressions.length} file(s):\n`);
    for (const { file, count, allowed } of regressions) {
      console.error(
        `::error file=${file}::${count} personal-data hit(s), baseline allows ${allowed}`,
      );
    }
    console.error(
      "\nA real person's email address should not enter the repo. Use a fixture\n" +
        "domain (@example.com, *.invalid) instead — they exist for this. If the\n" +
        "address genuinely belongs here (a seeded pilot account, an admin\n" +
        "allowlist), run `node scripts/check-leaks.mjs --generate` and say why in\n" +
        "the commit message.\n",
    );
  }

  if (improvements.length > 0) {
    console.log(`\n${improvements.length} file(s) improved — consider regenerating the baseline:`);
    for (const { file, count, allowed } of improvements) {
      console.log(`  ${file}: ${allowed} -> ${count}`);
    }
  }

  if (failed) process.exit(1);

  console.log(
    `check-leaks: no credentials and no account identifiers found; every person ` +
      `named is declared (${declaredPeople().size}); personal data within ` +
      `baseline (${Object.keys(personal).length} file(s) tracked).`,
  );
}
