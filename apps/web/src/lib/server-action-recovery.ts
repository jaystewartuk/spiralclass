// Recovery for the Next.js deploy-skew error family.
//
// Each build bakes content hashes into its asset URLs and Server Action IDs.
// When a browser still running an OLD deployment talks to a NEWER one (a tab
// left open across a deploy), it can fail in several related ways — all rooted
// in the old client referencing names the new deployment has renamed, and all
// fixed the same way: reload once to pull the current deployment's HTML, fresh
// action IDs, and chunk URLs. The known variants:
//
//   1. Server Action ID isn't in the new deployment's manifest:
//        Failed to find Server Action "…". This request might be from an older
//        or newer deployment.   (Next error code E715)
//      https://nextjs.org/docs/messages/failed-to-find-server-action
//
//   2. The action POST gets a 200 whose body isn't an RSC flight payload and
//      carries no redirect header — an older deployment or an intermediary
//      returned an HTML document instead of executing the action:
//        An unexpected response was received from the server.   (Next code E394)
//      (See node_modules/next/.../reducers/server-action-reducer.js.)
//
//   3. A lazy-loaded JS/CSS chunk the page references no longer exists because
//      the new deploy renamed it — webpack throws a `ChunkLoadError`:
//        Loading chunk 4875 failed.   (name "ChunkLoadError"; CSS variant has
//        code "CSS_CHUNK_LOAD_FAILED")
//      This is the asset-skew half the `?dpl=` stamping in next.config.ts is
//      meant to blunt; this is the client-side net for when it still slips
//      through.
//
//   4. The same asset skew under TURBOPACK — which is what actually builds this
//      app (`next build --turbopack`), so this, not variant 3, is the shape
//      production throws. Turbopack's runtime wraps the failed fetch in a plain
//      `Error`: no `ChunkLoadError` name, no `code`, nothing but the message.
//        Failed to load chunk /_next/static/chunks/03d74e75f9d610cd.js from
//        module 964893
//      The trailing clause says why the chunk was wanted and varies by call
//      site ("from module <id>", "as a runtime dependency of chunk <path>",
//      "from an HMR update", and "from runtime for chunk <path>" in the Node
//      runtime), so only the leading phrase is matched. CSS chunks go through
//      the same loader and throw the same message — Turbopack has no analogue
//      of webpack's CSS_CHUNK_LOAD_FAILED.
//      Missing this variant is what left AGENDAPROFE-3B reporting a dead-end
//      error screen on /b/[slug] instead of quietly reloading: the predicate
//      below still only knew webpack's wording, so every chunk skew since the
//      Turbopack build fell straight through it.
//
// New skew symptoms should be ADDED here rather than handled ad hoc, so the one
// reload-and-recover policy keeps covering the whole family. Keep the predicate
// narrow to genuine deploy-skew signals, though — a real application error
// (thrown inside an action, etc.) arrives as a normal RSC response with a
// `digest` and MUST still surface to the user and Sentry.
//
// There is no Skew Protection sitting in front of this any more. It used to be
// the primary defense — Vercel's deployment routing pinned each browser session
// to the deployment that served its HTML, so names always resolved — but Vercel
// is decommissioned (D-89) and the app runs on Fly, where every request lands on
// whatever release is current. What remains in front of this is Next's
// `deploymentId` stamping in next.config.ts — which was itself inert until
// 2026-09-03, reading a NEXT_DEPLOYMENT_ID nothing set, and now carries the
// deployed commit. That catches a stale client on a NAVIGATION, by forcing a
// hard one. It cannot catch a document already rendering, which is where this
// module earns its place: for a client holding a build the deploy has replaced,
// it IS the recovery, not a backstop behind something better. We detect a skew error and reload once, instead of surfacing a
// dead-end error screen. The reload guard below stops a persistent, non-skew
// variant of these from looping — after one reload it falls through to the
// normal error UI.

// Stable leading phrases of the skew errors above. Kept loose (no trailing
// hint / chunk id) so they survive wording tweaks across Next, webpack and
// Turbopack versions.
const SKEW_PATTERNS = [
  /Failed to find Server Action/i,
  /An unexpected response was received from the server/i,
  /Loading( CSS)? chunk [\w./-]+ failed/i,
  // Turbopack's chunk-load failure (variant 4). Anchored to the leading phrase
  // only: the chunk URL and the trailing "why" clause both vary, and matching
  // the whole sentence would go stale the next time a call site is added.
  /Failed to load chunk\b/i,
];

// Next/webpack stamp a stable `__NEXT_ERROR_CODE` / `code` on some of these even
// when the human-readable message drifts between versions (e.g. the E715 text
// became "Server Action … was not found on the server."), so we match on the
// code first and fall back to the message patterns.
//  - E394 / E715: the two server-action skew errors above.
//  - CSS_CHUNK_LOAD_FAILED: webpack's code for a failed CSS chunk load.
const SKEW_ERROR_CODES = new Set(["E394", "E715", "CSS_CHUNK_LOAD_FAILED"]);

// Some skew errors are identified by their constructor name rather than a code —
// webpack's failed JS chunk load throws a `ChunkLoadError`.
const SKEW_ERROR_NAMES = new Set(["ChunkLoadError"]);

function errorCodeOf(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    // Next uses `__NEXT_ERROR_CODE`; webpack's chunk errors use `code`.
    const obj = error as { __NEXT_ERROR_CODE?: unknown; code?: unknown };
    const code = obj.__NEXT_ERROR_CODE ?? obj.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function errorNameOf(error: unknown): string | undefined {
  if (error instanceof Error) return error.name;
  return undefined;
}

// sessionStorage key holding the timestamp of our last auto-reload.
const RELOAD_GUARD_KEY = "ap:server-action-skew-reload";

// Refuse to auto-reload again within this window. If a skew error somehow
// survives a reload, this stops the tab from spinning in an infinite refresh
// loop — we fall back to the normal error UI instead.
const RELOAD_COOLDOWN_MS = 30_000;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

/**
 * True when `error` is a Next.js/bundler deploy-skew error (old client vs. new
 * deployment) — the "Failed to find Server Action" (E715), "An unexpected
 * response was received from the server." (E394), or chunk-load variant, the
 * last of which arrives as webpack's ChunkLoadError / CSS_CHUNK_LOAD_FAILED or
 * as Turbopack's plain "Failed to load chunk …" — as opposed to a genuine
 * application error.
 */
export function isServerActionVersionSkew(error: unknown): boolean {
  const code = errorCodeOf(error);
  if (code && SKEW_ERROR_CODES.has(code)) return true;
  const name = errorNameOf(error);
  if (name && SKEW_ERROR_NAMES.has(name)) return true;
  return SKEW_PATTERNS.some((pattern) => pattern.test(messageOf(error)));
}

/**
 * If `error` is a server-action version-skew error, reload the page (once,
 * subject to a cooldown) to pick up the current deployment's HTML and action
 * IDs, and return `true` so callers can suppress the user-facing error screen
 * and skip Sentry noise.
 *
 * Returns `false` (a no-op) for any other error, on the server, or while a
 * recent reload is still cooling down.
 */
export function recoverFromServerActionSkew(error: unknown): boolean {
  if (typeof window === "undefined") return false;
  if (!isServerActionVersionSkew(error)) return false;

  const now = Date.now();

  // sessionStorage can throw in private mode / sandboxed iframes — treat any
  // failure as "no guard available" and still attempt the reload.
  let store: Storage | null = null;
  try {
    store = window.sessionStorage;
  } catch {
    store = null;
  }

  if (store) {
    const last = Number(store.getItem(RELOAD_GUARD_KEY) ?? "0");
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_COOLDOWN_MS) {
      return false;
    }
    try {
      store.setItem(RELOAD_GUARD_KEY, String(now));
    } catch {
      // Ignore write failures; the reload below is still worth attempting.
    }
  }

  window.location.reload();
  return true;
}
