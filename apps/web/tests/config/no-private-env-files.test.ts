import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Secrets come from Infisical. Non-secret config comes from the repo
// (config/env/). Nothing comes from a private file on one person's disk.
//
// Every command here used to be `dotenv -e .env.<something>.local -- <cmd>`,
// which required each developer to keep an uncommitted file of preview and
// production database URLs. That is the copy nobody rotates — invisible to
// every rotation, audit and offboarding Infisical exists to enable — and it
// diverges silently: `pnpm migrate:preview` failed in this repo purely because
// the file did not exist on that machine, while the Infisical-backed
// `seed:preview:live` beside it worked. Two commands, same database, one
// reachable by accident of local filesystem state.
//
// These guard the rule rather than the current spelling, so adding a script
// that reintroduces the pattern fails here instead of on someone else's laptop
// six weeks later.

const ROOT = join(process.cwd(), "..", "..");

function scriptsOf(pkgRelPath: string): Record<string, string> {
  const raw = readFileSync(join(ROOT, pkgRelPath), "utf8");
  return (JSON.parse(raw).scripts ?? {}) as Record<string, string>;
}

const PACKAGES = ["package.json", "apps/web/package.json", "packages/shared/package.json"];

// The shapes that mean "a private file on this machine": a dotfile env at a
// package root, with or without a `.local` suffix. `config/env/*.env` is
// deliberately NOT matched — it is committed, non-secret, and the intended
// replacement.
const PRIVATE_ENV = /(^|[\s=/])\.env(\.[A-Za-z0-9-]+)*(\s|$)/;

describe("no command reads a private env file", () => {
  for (const pkg of PACKAGES) {
    it(`${pkg} loads no .env file`, () => {
      const offenders = Object.entries(scriptsOf(pkg))
        .filter(([, cmd]) => PRIVATE_ENV.test(cmd))
        .map(([name, cmd]) => `${name}: ${cmd}`);

      expect(
        offenders,
        "these read a private env file; use infra/infisical/run.sh for secrets, " +
          "or config/env/<env>.runtime.env for non-secret config:\n" +
          offenders.join("\n"),
      ).toEqual([]);
    });
  }

  it("routes every preview and production command through Infisical", () => {
    // The deployed environments are the ones whose credentials are real. A
    // command naming one must not be able to get them from anywhere else.
    const web = scriptsOf("apps/web/package.json");
    const deployed = Object.entries(web).filter(([name]) =>
      /(:preview|:prod|:production)(:|$)/.test(name),
    );

    expect(deployed.length).toBeGreaterThan(0);
    for (const [name, cmd] of deployed) {
      expect(cmd, `${name} must get its secrets from Infisical`).toContain("infisical/run.sh");
    }
  });

  it("keeps the local config it replaced them with committed and non-secret", () => {
    // If this file is ever gitignored or filled with a real credential, the
    // rule above has been satisfied in letter and broken in spirit.
    const local = readFileSync(join(ROOT, "config/env/local.runtime.env"), "utf8");
    expect(local).toMatch(/localhost|127\.0\.0\.1/);
    // Nothing that looks like a managed database or a live key.
    expect(local).not.toMatch(/neon\.tech|amazonaws|sk_live|pk_live|rk_live/);
  });

  // The other half of the same rule, and the half nothing was holding.
  //
  // Everything above asks where a command must NOT get its values. Nothing
  // asked whether the commands that need them get them at all — and for two
  // years `pnpm dev` did not. It was bare `next dev --turbopack` while the
  // thirteen scripts around it carried `dotenv -e ../../config/env/…`, so a
  // fresh clone following the README's own quickstart died on boot with
  // `Invalid server environment: DATABASE_URL: Required`. Nothing failed: the
  // gate never runs the dev server, and every laptop that had ever exported a
  // DATABASE_URL kept working.
  //
  // The failure is invisible to the person who already has the value and fatal
  // to the person who does not, which is exactly the shape of the private-file
  // problem this file was written for — arrived at from the opposite side.
  it("gives every long-running local command the committed config", () => {
    const web = scriptsOf("apps/web/package.json");

    // `next dev` and `next start` boot the server, which parses the runtime
    // env contract in src/lib/env.ts before it serves anything. `next build`
    // is deliberately NOT here: it renders no dynamic page and needs no
    // database, which is why CI builds without one.
    const boots = Object.entries(web).filter(([, cmd]) => /\bnext (dev|start)\b/.test(cmd));

    expect(boots.length, "no next dev/start script found — has this been renamed?").toBeGreaterThan(
      0,
    );
    for (const [name, cmd] of boots) {
      expect(
        cmd,
        `pnpm --filter spiralclass-web ${name} boots the server without loading ` +
          "config/env/local.runtime.env, so DATABASE_URL, DIRECT_URL and " +
          "SESSION_SECRET are unset and src/lib/env.ts throws before the first request",
      ).toContain("config/env/local.runtime.env");
    }
  });
});
