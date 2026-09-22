import type { Prisma } from "@prisma/client";

// The DB-level translation of `hasPayoutRail` (lib/marketplace-ready.ts), for
// the places that must ask "can this teacher take money?" inside a Prisma
// `where` rather than in JS — the sitemap and the admin "stalled" filter.
//
// Deliberately its OWN module rather than sitting beside the predicate it
// mirrors, which is where it lived until D-124. `lib/admin-filters.ts` imports
// these, and `admin-filters` is reachable from the CLIENT (the admin teachers
// table filters in the browser). `marketplace-ready.ts` imports the PostHog
// *server* client, which reaches `node:async_hooks` and `node:fs` — fine on
// the server, fatal in a client chunk. That import only ever stayed out of the
// browser bundle because these two constants were plain object literals that
// Turbopack could tree-shake the rest of the module away from; the moment they
// became a module-eval-time computation, the whole module came with them and
// the client build failed on the node builtins. Splitting the file removes the
// coupling entirely instead of relying on tree-shaking to keep holding.
//
// D-145 removed the bank-account branch along with the kind it tested. That
// branch was GENERATED per currency from the scheme registry, because a
// domestic clearing system settles one currency and offering it against
// another quotes a student an amount their bank cannot send. Wise has no such
// limit, so the currency question disappears from the SQL entirely rather than
// being answered — which is why this file no longer enumerates
// PRICING_CURRENCIES.
//
// One deliberate imprecision survives, stated rather than hidden: SQL tests
// that an enabled Wise instrument with a handle EXISTS, where JS asks
// `isInstrumentReady`. The two agree over every state the application can
// produce, because `saveTeacherInstrument` refuses to enable an instrument
// without a handle. The sitemap parity test (tests/seo/sitemap.test.ts)
// enumerates the reachable states.

const WISE_RAIL_BRANCH = {
  payoutInstruments: { some: { enabled: true, kind: "wise" as const, wiseHandle: { not: null } } },
} satisfies Prisma.TeacherWhereInput;

export const HAS_PAYOUT_RAIL_WHERE = {
  OR: [{ stripeChargesEnabled: true }, WISE_RAIL_BRANCH],
} satisfies Prisma.TeacherWhereInput;

// The complement: a teacher with no usable payout rail at all.
export const NO_PAYOUT_RAIL_WHERE = {
  stripeChargesEnabled: false,
  NOT: WISE_RAIL_BRANCH,
} satisfies Prisma.TeacherWhereInput;

// "Has Wise auto-reconcile credentials on file" — a different question from
// the rail one above (a handle is enough to be PAID; the API profile id is
// what lets the statement poller reconcile), and the other instrument fact an
// admin `where` asks.
//
// Named here rather than written inline because the credential columns moved
// from `Teacher` onto the INSTRUMENT at D-113, and a `where` written against
// the old shape is a RUNTIME-only failure: Prisma's `Subset` types accept an
// unknown key inside a spread `where` literal without a compile error, so
// `tsc` cannot see it — /admin/teachers 500'd on exactly that from D-113 until
// 2026-09-06. `satisfies` on a named constant is what makes the typechecker
// check it, so keep instrument `where` clauses in this file rather than at
// their call sites.
export const WISE_API_CONNECTED_WHERE = {
  payoutInstruments: { some: { kind: "wise" as const, wiseApiProfileId: { not: null } } },
} satisfies Prisma.TeacherWhereInput;
