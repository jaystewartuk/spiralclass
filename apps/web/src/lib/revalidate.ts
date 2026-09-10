import { revalidatePath } from "next/cache";

/**
 * The ONE sanctioned way for a server action to refresh its page.
 *
 * ⚠️ A server action must revalidate AT MOST ONE PATH. A second
 * `revalidatePath` call in the same action — even to the same path, even
 * layout-scoped — makes the client throw the whole action response away:
 * `useActionState` never receives the returned state, the page never picks up
 * the new data, and on Next 15 the transition never commits at all, so the
 * submit button stays disabled forever and every link on the page goes dead
 * until a manual reload. The write itself still lands, so it reads to the user
 * as "saving does nothing" while quietly succeeding — and they click again.
 *
 * Reproduced on production builds only (`pnpm dev` never shows it) against
 * next 15.5.25 / react 19.2.3, and still present on next 16.3.4, where the
 * permanent hang becomes a flat 10-second stall. Verified both directions:
 * one page-scoped call for the current route works; two calls, two calls to
 * the same path, and one layout-scoped call all break it. See D-174.
 *
 * Dropping the extra calls costs nothing here: `next build` prerenders NO
 * route in this app (every route is `ƒ`, server-rendered on demand), so there
 * is no Full Route Cache entry for `revalidatePath` to invalidate. Its only
 * effect is on the client Router Cache, and `staleTimes.dynamic` defaults to 0
 * — a dynamic route is refetched on navigation regardless. So the sibling
 * list page an action used to revalidate alongside its detail page was already
 * refetching on its own.
 *
 * Pass the path of the page the action is invoked FROM — that is the one the
 * response has to carry fresh data for. Everything else refetches when the
 * user navigates to it.
 *
 * Held to one call per action by `apps/web/tests/config/revalidate-once.test.ts`.
 *
 * `type` is passed straight through, and the handful of existing callers that
 * pass "layout" are whole-app refreshes (reading preferences, onboarding) that
 * are NOT `useActionState` forms — they are fire-and-forget `startTransition`
 * calls with no result to lose. A layout-scoped revalidation was measured to
 * break the response the same way a second call does, so do not reach for it
 * from a form action: keep those page-scoped.
 */
export function revalidateAfterAction(path: string, type?: "layout" | "page"): void {
  // Forwarded as a single argument when no scope is given: `revalidatePath` is
  // widely spied on in the unit suite, and passing an explicit `undefined`
  // changes the recorded call shape for every caller.
  if (type === undefined) revalidatePath(path);
  else revalidatePath(path, type);
}
