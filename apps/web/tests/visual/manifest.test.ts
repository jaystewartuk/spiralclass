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
 * ONE baseline set, and it belongs to `ubuntu-latest` ([D-171]).
 *
 * Playwright suffixes a snapshot with `process.platform`, so [D-161] committed
 * each capture twice — `-darwin.png` for the laptop, `-linux.png` for the
 * runner — and this block existed to keep the two halves in lockstep. [D-162]
 * removed the macOS half's last consumer by making the runners, not a local
 * receipt, what certifies a release; D-171 deleted it and made
 * regression.spec.ts skip anywhere but Linux.
 *
 * WHAT THIS STILL CATCHES is the dangerous half of the old pair, and it is the
 * reason this block did not go with the set it was watching. Playwright
 * defaults to `updateSnapshots: 'missing'`: a capture with no committed image
 * gets one WRITTEN from whatever rendered, on a runner whose disk is thrown
 * away, and the leg reports green. A capture with no baseline is not partly
 * covered — it is uncovered, and it looks covered. This is the only thing that
 * says so, it runs in the FAST tier, and it fails within seconds of the push.
 *
 * Regenerating is a documented dispatch — see the header of
 * .github/workflows/heavy.yml.
 */
describe("visual baselines", () => {
  const SNAPSHOT_DIR = resolve(__dirname, "regression.spec.ts-snapshots");

  const files = () => readdirSync(SNAPSHOT_DIR);

  /** `landing-390-light-linux.png` -> `landing-390-light`. */
  const stems = () =>
    files()
      .filter((f) => f.endsWith("-linux.png"))
      .map((f) => f.slice(0, -"-linux.png".length))
      .sort();

  it("has a linux set at all", () => {
    // What a deleted snapshot directory looks like, asserted separately so the
    // per-route check below cannot pass vacuously.
    expect(stems().length, "no -linux.png baselines").toBeGreaterThan(0);
  });

  it("photographs every route the sweep actually captures", () => {
    // Mirrors regression.spec.ts's own selection, because that is the list the
    // images come from. A route added to the manifest and never photographed
    // fails here rather than teaching the runner to write its own.
    const committed = stems();
    const captured = capturable("public").filter((route) => route.portfolio);
    expect(captured.length, "the sweep captures no routes at all").toBeGreaterThan(0);
    for (const route of captured) {
      expect(
        committed.some((stem) => stem.startsWith(`${route.name}-`)),
        `the sweep captures "${route.name}" and no baseline photographs it. Regenerate: ` +
          `gh workflow run heavy.yml -f update_visual_baselines=${route.name} --ref <branch>`,
      ).toBe(true);
    }
  });

  it("keeps the second platform's set from growing back", () => {
    // D-171's own guard, retired in the same change as the thing it guards
    // would otherwise be — the mistake the mobile route tree taught. A
    // `-darwin.png` here means someone ran the suite on a Mac with the skip
    // removed or bypassed, and Playwright wrote a set nothing asserts and
    // nothing regenerates: the exact bookkeeping D-171 deleted, growing back
    // one image at a time.
    const strays = files().filter((f) => f.endsWith(".png") && !f.endsWith("-linux.png"));
    expect(
      strays,
      `Baselines for a platform that no longer asserts anything (D-171). The visual ` +
        `sweep runs on ubuntu-latest only; delete these rather than committing them:\n` +
        strays.join("\n"),
    ).toEqual([]);
  });
});
