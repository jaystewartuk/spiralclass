import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_ROUTES, capturable } from "./routes";
import { ADMIN_STEPUP_COOKIE } from "./session";

/**
 * Keeps the visual-baseline manifest honest.
 *
 * The manifest (tests/visual/routes.ts) is hand-maintained on purpose — a
 * filesystem crawl cannot know which routes need a live LiveKit room or
 * consume a single-use token. But a hand-maintained list rots the moment
 * someone adds a route, and a baseline that silently stops covering a screen
 * is worse than no baseline, because it still reports green.
 *
 * So the list is hand-written and this test is the sync check: every page
 * route on disk must appear, and every manifest entry must exist on disk. A
 * new route fails here until someone decides how it gets captured — which is
 * the decision the manifest exists to record.
 */

const APP_DIR = resolve(__dirname, "../../src/app");

/** Every `page.tsx` under src/app, as a URL path with route groups removed. */
function routesOnDisk(dir = APP_DIR, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      // Route groups — `(app)`, `(auth)` — organise files without adding a
      // URL segment, so they contribute nothing to the path.
      const isGroup = entry.startsWith("(") && entry.endsWith(")");
      out.push(...routesOnDisk(full, isGroup ? prefix : `${prefix}/${entry}`));
    } else if (entry === "page.tsx") {
      out.push(prefix === "" ? "/" : prefix);
    }
  }
  return out;
}

/** Manifest paths use `:param`; the filesystem uses `[param]`. */
function toDiskShape(path: string): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "[$1]");
}

describe("visual baseline manifest", () => {
  const onDisk = routesOnDisk().sort();

  // Manifest paths carry real values where the filesystem carries a
  // parameter name, so compare by shape: `/b/alicia-moreno` matches `/b/[slug]`.
  const manifestShapes = ALL_ROUTES.map((r) => toDiskShape(r.path));

  const matchesDiskRoute = (diskRoute: string): boolean => {
    const diskParts = diskRoute.split("/");
    return manifestShapes.some((shape) => {
      const parts = shape.split("/");
      if (parts.length !== diskParts.length) return false;
      return parts.every((part, i) => {
        const disk = diskParts[i];
        // A `[param]` segment on disk accepts any concrete value.
        if (disk.startsWith("[") && disk.endsWith("]")) return true;
        return part === disk;
      });
    });
  };

  it("covers every page route on disk", () => {
    const missing = onDisk.filter((route) => !matchesDiskRoute(route));
    expect(
      missing,
      `These routes exist but are not in tests/visual/routes.ts. Add each one ` +
        `with its tier, or with an \`excluded\` reason saying why it cannot be ` +
        `captured:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("has no manifest entry for a route that no longer exists", () => {
    const diskSet = new Set(onDisk);
    const stale = ALL_ROUTES.map((r) => r.path)
      .filter((path) => {
        const shape = toDiskShape(path);
        if (diskSet.has(shape)) return false;
        // A concrete value in place of a parameter still has to match some
        // real route.
        return !onDisk.some((route) => {
          const a = route.split("/");
          const b = shape.split("/");
          if (a.length !== b.length) return false;
          return a.every((seg, i) =>
            seg.startsWith("[") && seg.endsWith("]") ? true : seg === b[i],
          );
        });
      })
      .sort();
    expect(
      stale,
      `These manifest entries point at routes that no longer exist:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  it("gives every excluded route a reason", () => {
    const unexplained = ALL_ROUTES.filter((r) => r.excluded !== undefined && !r.excluded).map(
      (r) => r.path,
    );
    expect(unexplained).toEqual([]);
  });

  it("uses a unique name per route, since the name is the screenshot filename", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const route of ALL_ROUTES) {
      const previous = seen.get(route.name);
      if (previous) collisions.push(`${route.name}: ${previous} and ${route.path}`);
      seen.set(route.name, route.path);
    }
    expect(collisions).toEqual([]);
  });

  it("declares a resolver for every parameterised route it intends to capture", () => {
    const unresolved = capturable()
      .filter((r) => r.path.includes(":") && !r.resolve)
      .map((r) => r.path);
    expect(
      unresolved,
      `These routes carry a parameter but no \`resolve\` key, so the capture ` +
        `spec cannot fill it:\n${unresolved.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the duplicated admin step-up cookie name in sync with the app", async () => {
    // session.ts re-declares this constant because Playwright's test loader
    // cannot import the app's ESM lib wrappers. Vitest can, so the check lives
    // here — a rename in the app would otherwise leave the visual harness
    // silently unable to prove it satisfied the MFA gate.
    const app = await import("../../src/lib/auth/admin-stepup");
    expect(ADMIN_STEPUP_COOKIE).toBe(app.ADMIN_STEPUP_COOKIE);
  });

  it("captures the whole public surface a stranger can reach", () => {
    // The portfolio case rests on these specifically, so they are asserted by
    // name rather than left to the disk comparison — a refactor that moved one
    // out of the manifest would otherwise pass.
    const names = new Set(capturable("public").map((r) => r.name));
    for (const required of ["landing", "features", "pricing", "about", "booking", "sign-in"]) {
      expect(names.has(required), `${required} must be in the public capture set`).toBe(true);
    }
  });
});

/**
 * The two baseline sets, kept in lockstep ([D-161]).
 *
 * Playwright suffixes a snapshot with `process.platform`, so a repository whose
 * browser suites run on two operating systems commits two images per capture:
 * `<route>-<viewport>-<theme>-darwin.png` for the laptop and `-linux.png` for
 * `ubuntu-latest`. Before D-161 there was one set and the suites were
 * laptop-only; D-157 named exactly that as the single blocker to moving them.
 *
 * WHAT THIS CATCHES, and it is not hypothetical — it is the standing cost of
 * having two sets at all. `VISUAL_UPDATE_SNAPSHOTS=all bash scripts/ci/e2e.sh`
 * rewrites the set belonging to whichever machine it runs on and CANNOT see the
 * other. So the natural mistake is: restyle a page, regenerate on the laptop,
 * review the diffs, merge — and the runner goes red on exactly the routes just
 * fixed, because nothing regenerated its half.
 *
 * The other direction is worse, because it is silent. Add a route, get a darwin
 * baseline from a local run, and the runner finds no linux baseline, WRITES one
 * from whatever the page rendered that day, and reports green. A capture with
 * one baseline is not half-covered; it is uncovered, and it looks covered.
 *
 * Regenerating the Linux half is a documented one-liner — see the header of
 * .github/workflows/heavy.yml.
 */
describe("visual baselines cover both platforms", () => {
  const SNAPSHOT_DIR = resolve(__dirname, "regression.spec.ts-snapshots");

  /** `landing-390-light-darwin.png` -> `landing-390-light`. */
  const stems = (platform: string) => {
    const suffix = `-${platform}.png`;
    return readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.endsWith(suffix))
      .map((f) => f.slice(0, -suffix.length))
      .sort();
  };

  it("has a darwin set and a linux set", () => {
    // Non-empty on both counts, so the equality below cannot pass by both being
    // empty — which is what a deleted snapshot directory looks like.
    expect(stems("darwin").length, "no -darwin.png baselines").toBeGreaterThan(0);
    expect(stems("linux").length, "no -linux.png baselines").toBeGreaterThan(0);
  });

  it("names exactly the same captures in each", () => {
    const darwin = stems("darwin");
    const linux = stems("linux");
    const onlyDarwin = darwin.filter((s) => !linux.includes(s));
    const onlyLinux = linux.filter((s) => !darwin.includes(s));

    expect(
      onlyDarwin,
      `${onlyDarwin.length} capture(s) have a macOS baseline and no Linux one, so the ` +
        "runner will write its own on first sight and assert nothing. Regenerate with: " +
        "gh workflow run heavy.yml -f update_visual_baselines=all --ref <branch>",
    ).toEqual([]);
    expect(
      onlyLinux,
      `${onlyLinux.length} capture(s) have a Linux baseline and no macOS one, so ` +
        "pnpm gate:full on the laptop will assert nothing. Regenerate with: " +
        "VISUAL_UPDATE_SNAPSHOTS=all bash scripts/ci/e2e.sh",
    ).toEqual([]);
  });

  it("photographs every route the sweep actually captures", () => {
    // The two tests above only prove the sets AGREE, which two equally stale
    // sets also do. This is the one that notices a route was added to the
    // manifest and never photographed. Mirrors regression.spec.ts's own
    // selection, because that is the list the images come from.
    const darwin = stems("darwin");
    const captured = capturable("public").filter((route) => route.portfolio);
    expect(captured.length, "the sweep captures no routes at all").toBeGreaterThan(0);
    for (const route of captured) {
      expect(
        darwin.some((stem) => stem.startsWith(`${route.name}-`)),
        `the sweep captures "${route.name}" and no baseline photographs it`,
      ).toBe(true);
    }
  });
});
