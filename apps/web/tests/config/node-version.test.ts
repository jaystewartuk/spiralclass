import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./_tree";

/**
 * One Node major, named in three places, and only one of them is the source.
 *
 * `gate.yml` already gets this right and says why: it reads the major out of
 * the Dockerfile's `FROM` line "because that is what production runs — not from
 * `engines.node`, which is a floor". Nothing held the files that cannot derive
 * it to the same answer, and by 2026-09 they disagreed three ways:
 *
 *   Dockerfile                26   ← production, and what CI derives
 *   .nvmrc                    24
 *   the devcontainer image    22   ← below the engines floor entirely
 *
 * The devcontainer was the expensive one: Node 22 does not satisfy
 * `engines.node >= 24.15.0`, so it could not have run `pnpm install` at all —
 * while its own comment asserted the opposite, "to match every CI job … all pin
 * node 22", which no job had done since the Dockerfile moved off 22. D-170
 * deleted that path rather than repairing it, on the ground that nobody used
 * it. `.nvmrc` was the same drift without the second failure.
 *
 * This does not make them derive; a `.nvmrc` is a literal. It makes a bump that
 * forgets one of them fail here, naming the file to change.
 */

const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

/**
 * The major from the Dockerfile's first `FROM node:<major>-slim`. Read with the
 * same expression `gate.yml` uses, so the two cannot disagree about what the
 * source says even if the line's shape changes.
 */
function dockerfileMajor(): number {
  const match = /^FROM node:(\d+)-slim/m.exec(read("Dockerfile"));
  expect(
    match,
    "no `FROM node:<major>-slim` in the Dockerfile — gate.yml reads the same line and would fail too",
  ).not.toBeNull();
  return Number(match![1]);
}

describe("the Node major is stated once and followed everywhere", () => {
  const major = dockerfileMajor();

  it("is a plausible major", () => {
    // Guards the guard: a regex that silently matched nothing would make every
    // assertion below compare two zeroes.
    expect(major).toBeGreaterThanOrEqual(20);
  });

  it(".nvmrc names the major production runs", () => {
    expect(
      read(".nvmrc").trim(),
      "`.nvmrc` disagrees with the Dockerfile. `nvm use` would put a local shell on a " +
        "major that has never built this image.",
    ).toBe(String(major));
  });

  it("engines.node is a floor at or below it, never above", () => {
    // `engines` is deliberately a range and not the source — but a floor ABOVE
    // the image would mean production itself does not satisfy the manifest.
    const engines = JSON.parse(read("package.json")).engines.node as string;
    const floor = Number(/(\d+)/.exec(engines)?.[1]);

    expect(floor, `engines.node is "${engines}", unreadable as a major`).toBeGreaterThan(0);
    expect(
      floor,
      `engines.node floors at ${floor} while the image ships ${major}: production ` +
        "would not satisfy the package manifest it runs.",
    ).toBeLessThanOrEqual(major);
  });
});

/**
 * Whether the image can be built and run at that major at all.
 *
 * On 2026-09-13 the first production deploy from this repository failed in its
 * Docker build. The Dockerfile read `node:26-slim` and still ran
 * `corepack enable`, and Node 26 ships no Corepack (#100). Gate and Heavy were
 * green, because neither builds the image; they run on whatever major the
 * Dockerfile names, and pnpm reaches them another way. Every install on that
 * runner also carried Prisma's own warning that 26 is not a line it supports
 * (#102). Nothing checked either, so both were first found by a deploy against
 * production.
 */
describe("the image's Node major can build the image and run Prisma", () => {
  const major = dockerfileMajor();

  /**
   * The last Node major whose official image ships a `corepack` binary.
   * Checked 2026-09-13: `node:24-slim` has Corepack 0.36.0; `node:25-slim` and
   * `node:26-slim` have none. A literal, because nothing in the tree can ask
   * Docker Hub.
   */
  const LAST_MAJOR_WITH_COREPACK = 24;

  it("does not rely on a bundled Corepack on a major that has none", () => {
    const executable = read("Dockerfile")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    if (!/\bcorepack\b/.test(executable)) return;

    // Installing Corepack from npm is the other way to move past 24, and it
    // would pass here rather than being mistaken for the bundled one.
    const installsCorepack = /npm (?:install|i) (?:-g|--global) corepack/.test(executable);
    expect(
      installsCorepack || major <= LAST_MAJOR_WITH_COREPACK,
      `The Dockerfile runs corepack on node:${major}-slim, which ships none — the image ` +
        `cannot build (#100). Stay on ${LAST_MAJOR_WITH_COREPACK}, or install Corepack ` +
        "explicitly with `npm install -g corepack@<version>` before enabling it.",
    ).toBe(true);
  });

  it("is a Node line Prisma's own install check supports", () => {
    // Prisma's `engines.node` (">=24.0") would admit any later major; its
    // preinstall does not. The preinstall compares the running major against a
    // table of supported lines and prints a warning for anything else, and that
    // table is what this reads. It is minified, so the read fails loudly
    // rather than guessing if the table's shape ever changes.
    const prismaDir = dirname(
      createRequire(join(REPO_ROOT, "apps", "web", "package.json")).resolve("prisma/package.json"),
    );
    const preinstall = readFileSync(join(prismaDir, "preinstall", "index.js"), "utf8");
    const table =
      /\{((?:\d+:\d+,)*\d+:\d+)\},\w+=\w+\[\w+\];if\(!\(typeof \w+<"u"&&\w+>=\w+\)\)/.exec(
        preinstall,
      );
    expect(
      table,
      "Could not find the supported-Node table in prisma/preinstall/index.js. Prisma changed " +
        "how it checks; re-read its system requirements for the Dockerfile's major and update " +
        "this test rather than deleting it.",
    ).not.toBeNull();

    const supported = table![1].split(",").map((pair) => Number(pair.split(":")[0]));
    expect(
      supported,
      `Prisma's preinstall supports Node ${supported.join(", ")}; the image ships ${major} (#102).`,
    ).toContain(major);
  });
});
