import { describe, expect, it } from "vitest";
import {
  comparePersonal,
  declaredPeople,
  findIdentifiers,
  findPeople,
  loadBaseline,
  reflow,
  scanRepo,
} from "../../../../scripts/check-leaks.mjs";

// Runs the credential/personal-data scanner in the unit tier.
//
// The secrets half is absolute: a committed key is compromised on arrival, so
// there is no baseline and no grandfathering. The personal-data half is a
// ratchet — a real address reaches a repo through ordinary work, and a tooling
// check does not get to force the product decision about whether it stays. It
// only has to stop the pile growing. (The two real addresses the baseline was
// built around are gone: D-158 moved
// them to SEED_PILOT_TEACHER_EMAIL / SEED_OPERATOR_EMAIL. What the baseline
// still holds is six files of deliberate free-mail typo fixtures.)
//
// The scan walks several thousand files, so it runs ONCE here and every
// assertion reads the same result. Calling scanRepo() per test measurably
// slowed the whole unit suite — vitest runs files in parallel, and four extra
// full-tree walks were enough to push unrelated tests past their 5s timeout.

const { secrets, identifiers, people, personal, scanned } = scanRepo();
const baseline = loadBaseline();

describe("committed credentials", () => {
  it("no credential material anywhere in the repo", () => {
    expect(
      secrets,
      secrets.length
        ? `\nPossible credential(s) committed:\n\n` +
            secrets
              .map(
                ({ file, line, kind, snippet }) => `  ${kind}\n    ${file}:${line}\n    ${snippet}`,
              )
              .join("\n\n") +
            `\n\nRotate the key, then remove it from the source.\n`
        : "",
    ).toEqual([]);
  });
});

describe("people", () => {
  // Zero tolerance and a declared roster, because a name has no shape. Two
  // sweeps before this one reported the tree clean while a real teacher's name
  // and two real students' names were still in it — in comments, in a slug and
  // in test fixtures. What they had in common is the reason this gate reflows
  // the file before reading it.
  it("every person named in the repo is declared in fixture-personas.json", () => {
    expect(
      people,
      people.length
        ? `\nUndeclared person name(s):\n\n` +
            people.map(({ file, name }) => `  ${name}\n    ${file}`).join("\n\n") +
            `\n\nInvented? Add it to scripts/fixture-personas.json. Real? It does ` +
            `not belong in the tree.\n`
        : "",
    ).toEqual([]);
  });

  it("finds a name that a line break splits in two — the failure mode that got past every earlier sweep", () => {
    const wrapped = [
      "// ...the account belongs to Renata",
      "// Ocampo, who tests on preview.",
    ].join("\n");
    expect(reflow(wrapped)).toContain("Renata Ocampo");
    // Declared, so the gate is quiet about it...
    expect(findPeople("x.ts", wrapped)).toEqual([]);
    // ...and loud about the same shape carrying a name nobody declared.
    const undeclared = wrapped.replace("Renata", "Beatriz").replace("Ocampo", "Undeclarada");
    expect(findPeople("x.ts", undeclared)).toEqual([{ file: "x.ts", name: "Beatriz Undeclarada" }]);
  });

  it("reads a name through a comment marker on the continuation line", () => {
    for (const marker of ["//", "#", "*"]) {
      const src = `${marker} contact Beatriz\n${marker} Undeclarada about it`;
      expect(findPeople("x.ts", src).map((f) => f.name)).toEqual(["Beatriz Undeclarada"]);
    }
  });

  it("matches a first name through its accents, so `Inés` is not a hole", () => {
    expect(findPeople("x.ts", "Inés Undeclarada").map((f) => f.name)).toEqual(["Inés Undeclarada"]);
    // Decomposed (e + combining acute) has to read the same way.
    expect(findPeople("x.ts", "Ine\u0301s Undeclarada")).toHaveLength(1);
  });

  it("treats a possessive as the same person, not a new one", () => {
    expect(findPeople("x.ts", "Alicia Moreno's booking page")).toEqual([]);
    expect(findPeople("x.ts", "Alicia Moreno\u2019s booking page")).toEqual([]);
  });

  it("stays quiet on the capitalised pairs this codebase is full of", () => {
    // The reason the gate anchors on a known FIRST NAME rather than on any two
    // capitalised words: these are the same shape and there are hundreds.
    const noise =
      "Checkout Session, Customer Portal, Marketplace Ready, App Router, " +
      "Cloud Billing, Session Replay, Zero Trust, Access Key, Play Store";
    expect(findPeople("x.ts", noise)).toEqual([]);
  });

  it("reads a booking slug as the name it is, folded onto the same roster entry", () => {
    // A slug IS a person's name — it is what goes in a public URL — so
    // `/b/diego-marquez` has to resolve onto the declared `Diego Márquez`
    // rather than reading as a second, undeclared person.
    expect(findPeople("x.ts", "https://spiralclass.com/b/diego-marquez")).toEqual([]);
    expect(findPeople("x.ts", 'bookingSlug: "alicia-moreno"')).toEqual([]);
    expect(findPeople("x.ts", 'bookingSlug: "beatriz-undeclarada"').map((f) => f.name)).toEqual([
      "Beatriz Undeclarada",
    ]);
  });

  it("does not read kebab-case identifiers as people", () => {
    // Tried as a bare kebab-case rule and abandoned: `max-age`, `mark-read`,
    // `mark-sent`, `max-width` and thirty more are the same shape, and a gate
    // that reports those is one nobody keeps green.
    const code = "max-age, mark-read, mark-sent, max-width, grace-window, jean-paul";
    expect(findPeople("x.ts", code)).toEqual([]);
  });

  it("reports each undeclared name once per file, however often it appears", () => {
    const many = "Beatriz Undeclarada ".repeat(20);
    expect(findPeople("x.ts", many)).toHaveLength(1);
  });

  it("the roster is a declaration, so every not-a-name entry carries a reason", async () => {
    const { readFileSync } = await import("node:fs");
    const { PERSONAS_PATH } = await import("../../../../scripts/check-leaks.mjs");
    const roster = JSON.parse(readFileSync(PERSONAS_PATH, "utf8"));
    expect(Object.keys(roster.notPeople).length).toBeGreaterThan(0);
    for (const [name, reason] of Object.entries(roster.notPeople)) {
      expect(reason, `notPeople["${name}"] needs a reason`).toBeTruthy();
      expect(String(reason).length, `notPeople["${name}"]'s reason is too thin`).toBeGreaterThan(
        20,
      );
    }
    expect(declaredPeople().size).toBe(
      roster.personas.length + Object.keys(roster.notPeople).length,
    );
  });
});

describe("account identifiers", () => {
  // Zero tolerance and no baseline, unlike personal data. An identifier is not
  // a credential — nobody can use an OCID or a Stripe account id on its own —
  // which is exactly why they get committed without anyone flinching. This
  // repository is public, so they are the reconnaissance surface instead, and
  // they aggregate: the account, the box, the tenant and the region together
  // say more than any of them alone. D-158 says where each one lives.
  it("no account or tenant identifier anywhere in the repo", () => {
    expect(
      identifiers,
      identifiers.length
        ? `\nAccount identifier(s) committed:\n\n` +
            identifiers
              .map(
                ({ file, line, kind, snippet }) => `  ${kind}\n    ${file}:${line}\n    ${snippet}`,
              )
              .join("\n\n") +
            `\n\nReplace it with a placeholder and put the real value where D-158 says\n` +
            `it lives. If it is genuinely not ours, add a justified entry to\n` +
            `IDENTIFIER_ALLOWLIST in scripts/check-leaks.mjs.\n`
        : "",
    ).toEqual([]);
  });
});

describe("personal data ratchet", () => {
  it("no new personal data beyond the recorded baseline", () => {
    const { regressions } = comparePersonal(personal, baseline);

    expect(
      regressions,
      regressions.length
        ? `\nPersonal data added in ${regressions.length} file(s):\n\n` +
            regressions
              .map(
                ({ file, count, allowed }) =>
                  `  ${file}: ${count} hit(s), baseline allows ${allowed}`,
              )
              .join("\n") +
            `\n\nUse a fixture domain (@example.com, *.invalid) instead. If the address\n` +
            `genuinely belongs here, regenerate the baseline with\n` +
            `\`node scripts/check-leaks.mjs --generate\` and say why in the commit.\n`
        : "",
    ).toEqual([]);
  });

  it("the baseline describes files that still exist", () => {
    // A baseline entry for a file that no longer has any hits is stale. This is
    // reported, not failed, by the CLI — but if EVERY entry went stale the
    // ratchet would be silently protecting nothing, so assert the baseline is
    // still anchored to reality.
    const live = Object.keys(baseline).filter((file) => (personal[file] ?? 0) > 0);

    expect(
      live.length,
      "Every baseline entry is stale — the scanner is no longer finding what it recorded. " +
        "Either the scan roots/patterns broke, or the baseline needs regenerating.",
    ).toBeGreaterThan(0);
  });
});

describe("scanner integrity", () => {
  it("actually scans a meaningful amount of the repo", () => {
    // Guards against the scanner degrading into a no-op — a broken walk or a
    // regex that stops matching would make both assertions above trivially
    // pass.
    expect(Object.keys(baseline).length).toBeGreaterThan(5);
    expect(Object.keys(personal).length).toBeGreaterThan(5);
  });
});

describe("the identifier gate covers the database", () => {
  // Added 2026-09-06. The publication audit found three live Neon identifiers
  // committed — the production project, the preview project and the
  // organisation — and this scanner passed them, because the gate had patterns
  // for OCIDs, Stripe accounts, GCP projects and Cloudflare accounts and none
  // for the database. One of them sat in a README beside the words "real
  // student data".
  //
  // Asserting the tree is clean cannot catch that: a missing pattern makes the
  // clean assertion pass. So these drive the pattern directly.
  // The fixtures below are SYNTHETIC ids of the identical shape, never the real
  // ones. Using the real production project id here would put it straight back
  // in the tree — and this file is scanned like any other, so the gate says so.
  const at = (source: string) => findIdentifiers("infra/database/neon/README.md", source);

  it("catches a Neon project id", () => {
    expect(at("NEON_PROJECT_ID=quiet-meadow-19472063")).toHaveLength(1);
    expect(at("NEON_PROJECT_ID=quiet-meadow-19472063")[0].kind).toContain("Neon");
  });

  it("catches a Neon organisation id", () => {
    expect(at("neonctl projects list --org-id org-amber-harbor-58210394")).toHaveLength(1);
  });

  it("does not fire on this repo's own checkpoint branch names", () => {
    // neon-checkpoint.sh names branches `pre-deploy-<UTC timestamp>-<sha>`, and
    // `pre-deploy-20260906` has the identical shape. A gate that flagged the
    // repo's own documented branch scheme is one people learn to skip.
    expect(at("creates pre-deploy-20260906-a1b2c3d off production")).toEqual([]);
    expect(at("branch pre-deploy-20261231 and pre-deploy-20260101")).toEqual([]);
  });

  it("does not fire on ordinary hyphenated words", () => {
    expect(at('class="bg-slate-50 text-gray-500" data-testid="foo-bar-baz"')).toEqual([]);
    expect(at("see docs/decisions/D-158.md and the 20260906 sweep")).toEqual([]);
  });

  it("treats a placeholder as a placeholder", () => {
    expect(at("--project-id <project-id>")).toEqual([]);
    expect(at("NEON_PROJECT_ID=example-project-00000000")).toEqual([]);
  });
});

describe("scanner coverage", () => {
  // The scanner read seven named trees and sixteen extensions until
  // 2026-09-06, which left 368 tracked files — every root file, every dotdir,
  // all of prisma/migrations/, and eight file types — invisible to it. They
  // were clean. The point is that nothing was checking, and nothing would have
  // said so.
  const covers = (path: string) => scanned.includes(path);

  it("reads files at the repo root", () => {
    for (const f of ["CLAUDE.md", "README.md", "Dockerfile", "justfile", "wrangler.jsonc"]) {
      expect(covers(f), `${f} is tracked but unscanned`).toBe(true);
    }
  });

  it("reads the Fly configs, where a deploy target is named", () => {
    expect(covers("fly.production.toml")).toBe(true);
    expect(covers("fly.preview.toml")).toBe(true);
  });

  it("reads prisma/migrations, where a backfill would paste a real row", () => {
    expect(scanned.some((f) => f.startsWith("apps/web/prisma/migrations/"))).toBe(true);
    expect(covers("apps/web/prisma/schema.prisma")).toBe(true);
  });

  it("reads the import templates a real roster gets pasted into", () => {
    expect(covers("apps/web/scripts/import/templates/students.csv")).toBe(true);
  });

  it("reads the dotdirs that carry config", () => {
    expect(covers(".github/CODEOWNERS")).toBe(true);
    expect(covers(".githooks/pre-push")).toBe(true);
    // The agent configuration. It is prose and shell rather than application
    // code, which is exactly why it is worth scanning: a hook is where somebody
    // pastes a token to "just get it working", and .claude/ is the part of a
    // public repository a reader is most curious about and an author least
    // thinks of as published.
    expect(covers(".claude/settings.json")).toBe(true);
    expect(covers(".claude/hooks/guard-bash.sh")).toBe(true);
    expect(covers(".claude/agents/decision-scout.md")).toBe(true);
  });

  it("still skips gitignored working state rather than reading 688 MB of it", () => {
    expect(scanned.some((f) => f.startsWith("docs/design/gallery/"))).toBe(false);
    expect(scanned.some((f) => f.includes("node_modules/"))).toBe(false);
    expect(scanned.some((f) => f.startsWith(".claude/worktrees/"))).toBe(false);
  });
});
