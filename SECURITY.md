# Security policy

SpiralClass handles real payments (Stripe/Wise) and personal data for teachers
and students, and `spiralclass.com` is a live production site.

## Reporting a vulnerability

**Do not open a GitHub issue or PR for a security problem.** Issues and PRs
are visible to everyone with repo access, and an unfixed vulnerability
described in one is a roadmap for abuse.

Instead, report privately, either way:

- GitHub's private **"Report a vulnerability"** flow, on this repository's
  **Security** tab; or
- email **security@spiralclass.com** with a description, reproduction steps and
  the impact you believe it has.

You'll get an acknowledgement as soon as the report is read. This is a
solo-maintained project — there is no formal SLA and there is no bug bounty,
but payment-path and auth-path reports are treated as drop-everything work, and
you will be credited in the fix unless you'd rather not be.

**Please don't** test against `spiralclass.com` itself: it is a live service
with real teachers and real students on it. `pnpm setup && pnpm dev` gives you
the whole system on your own machine in one command, with seeded fixtures and
no credentials required — that is the right place to prove a finding.

## Scope notes for contributors

- Production-risk code paths (payments, auth, webhooks, migrations — the
  Tier 2 list in `CLAUDE.md`) get the strictest review; the PR template's
  security checklist is mandatory reading before touching them.
- There is no DB-side row-level security: application-level `teacherId`
  scoping is the only tenant isolation. A missing `where teacherId = ?` on an
  admin/webhook/service query is a reportable vulnerability, not a style nit.
- Never commit real credentials. `.env.local` and friends are gitignored;
  secrets live in Infisical / Fly / GitHub environments.
