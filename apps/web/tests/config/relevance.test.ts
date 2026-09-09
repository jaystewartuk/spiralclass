import { describe, expect, it } from "vitest";

import { changedTargets } from "../../../../scripts/ci/relevance.mjs";

// What `pnpm ship:preview` uses to skip a deploy this commit cannot have
// changed. The asymmetry is the point: an unrecognised path must count as
// affecting the deploy, because a redundant one costs 20 minutes and a skipped
// one silently ships nothing.
//
// It answered for two halves until one of them was deleted; that half was the
// other and is deleted. The object shape stayed, so these read `{ web }`.

describe("changedTargets", () => {
  it("routes web app changes to the deploy", () => {
    expect(changedTargets(["apps/web/src/app/page.tsx"])).toEqual({ web: true });
  });

  it("treats packages/* as affecting the deploy", () => {
    // packages/shared holds the business rules the app imports; a change there
    // reaches the bundle.
    expect(changedTargets(["packages/shared/src/money.ts"])).toEqual({ web: true });
  });

  it("treats anything at the root as affecting the deploy", () => {
    for (const file of ["pnpm-lock.yaml", "Dockerfile", "fly.preview.toml", "turbo.json"]) {
      expect(changedTargets([file]), file).toEqual({ web: true });
    }
  });

  it("defaults an unrecognised path to shipping, not to skipping", () => {
    // The failure direction that matters: a new top-level thing nobody taught
    // this function about must not silently cancel a deploy.
    expect(changedTargets(["some-new-toolchain-config.yaml"])).toEqual({ web: true });
  });

  it("ignores paths that cannot reach a built artifact", () => {
    expect(
      changedTargets([
        "docs/deployment/LOCAL_AUTOMATION.md",
        "README.md",
        ".github/dependabot.yml",
        ".githooks/pre-push",
        "infra/database/scripts/neon-checkpoint.sh",
        "scripts/ci/ship.mjs",
        "justfile",
      ]),
    ).toEqual({ web: false });
  });

  it("ignores tests and e2e specs", () => {
    // None of these are in the Next standalone output, so a test-only commit
    // ships nothing — which is the common shape of a commit that fixes a flaky
    // test.
    expect(
      changedTargets([
        "apps/web/tests/config/local-gate.test.ts",
        "apps/web/src/lib/money.test.ts",
        "apps/web/e2e/booking.spec.ts",
      ]),
    ).toEqual({ web: false });
  });

  it("still ships when a real change rides along with ignored ones", () => {
    expect(
      changedTargets(["docs/x.md", "apps/web/src/lib/money.ts", "apps/web/src/lib/money.test.ts"]),
    ).toEqual({ web: true });
  });

  it("survives empty and malformed input", () => {
    expect(changedTargets([])).toEqual({ web: false });
    expect(changedTargets(null as unknown as string[])).toEqual({ web: false });
  });
});
