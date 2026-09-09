<!--
Thanks for the PR. Keep the description tight; the diff is the source
of truth. Cross items off the security checklist when they apply.
-->

## Summary

<!-- One or two sentences. Why, not just what. -->

## Test plan

<!-- Bulleted list of what was tested and how. Include manual repro
     steps for UI changes. -->

- [ ]

## Security checklist

Mark with `[x]` if the answer is yes, `[N/A]` if the item does not
apply to this PR. Anything left unchecked is a question for the
reviewer.

- [ ] **New env var?** Added to `apps/web/.env.example` _and_
      validated in `apps/web/src/lib/env.ts` (server or client schema
      as appropriate). Production-required vars added to
      `assertProductionCredentials()`.
- [ ] **New route handler / server action?** Has an explicit auth
      gate — `requireOnboardedTeacher` for a page route (it redirects),
      `requireApiOnboardedTeacher` for a handler taking a plain `Request`
      (it throws `ApiAuthError`), `requireSuperuser` for admin — _and_ a
      zod schema for any user-provided input.
- [ ] **New service-role / admin / webhook DB query?** Every query has an
      explicit `where teacherId = ?` filter — there is no DB-side RLS
      backstop; application-level scoping is the only tenant isolation
      (post-D-70/D-89).
- [ ] **New PII column?** Updated `apps/web/src/lib/sentry-scrub.ts`
      so the value cannot leak into Sentry events.
- [ ] **New third-party SDK / origin?** If CSP is enforcing, added to
      the directive in `apps/web/next.config.ts` and `apps/web/src/lib/csp.ts`.
- [ ] **Touches `middleware.ts`, `lib/auth/**`, `lib/api/auth.ts`,
      `lib/admin.ts`, or `prisma/**`?** Tier 2 production-risk path
      (CLAUDE.md) — explicit security review required.
- [ ] **New webhook handler?** Signature verified before any DB
      write; idempotency key recorded in `WebhookEvent`.
- [ ] **Logs / Sentry tags / PostHog events** contain no raw PII
      (email, phone, `whatsappE164`, payment-method details).
