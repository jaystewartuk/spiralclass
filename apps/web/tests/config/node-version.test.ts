import { readFileSync } from "node:fs";
import { join } from "node:path";
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
