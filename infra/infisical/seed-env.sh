#!/usr/bin/env bash
# THE SEED'S ENVIRONMENT CONTRACT: every value apps/web/scripts/seed.ts reads,
# and where each one comes from. SOURCE this, never exec it — it exports into
# the CALLING shell, through with-secret.sh, which is the only thing that can.
#
# Both scripts that run the seed source this (seed-preview.sh, reset-preview.sh)
# so that a value the seed learns to read is wired up for both of them in one
# edit, rather than in whichever one somebody happened to have open.
#
# WHY THIS FILE EXISTS RATHER THAN TWO COPIES OF FOUR LINES. Setting
# SEED_OPERATOR_EMAIL in Infisical's preview environment used to change nothing
# whatsoever: seed.ts read it, no script exported it, and the seed carried on
# with its `.invalid` fallback while every "done when" about having set it
# passed. The gap was silent because nobody owned the list — the export list
# lived in one script and the read list lived in another file, and the two only
# agreed by memory. This file owns the list, and
# apps/web/tests/config/seed-env-contract.test.ts fails the moment seed.ts reads
# a name this file does not account for.
#
# NOT FROM INFISICAL — deliberately, each for its own reason. That test parses
# this block, so an entry here is a claim it checks (the name must still be read
# by seed.ts, and must not also be exported below), not a passing comment:
#
#   SEED_BULK_TEACHERS             — a per-run volume knob, passed on the command
#                                    line (`SEED_BULK_TEACHERS=40 pnpm
#                                    seed:preview`) and different every run. A
#                                    stored value would be the wrong shape.
#   SEED_BULK_STUDENTS_PER_TEACHER — that knob's companion, same reason (D-55).
#   PROD_DB_HOSTS                  — the production-database refusal guard
#                                    (D-89). It travels with the environments
#                                    that carry prod credentials; a preview seed
#                                    has no prod DB to protect and wants it
#                                    unset, so pulling it here would be backwards.
#
# shellcheck source=./with-secret.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/with-secret.sh"

# Export everything the seed reads from Infisical's `preview` environment.
# Returns non-zero only when a REQUIRED value is missing.
infisical_export_seed_secrets() {
  # REQUIRED. Without a target there is nothing to seed, and a missing or
  # half-answered fetch has to fail loudly — which is precisely what
  # infisical_export_secrets does: it refuses an empty result, and refuses a
  # partial one, rather than exporting what it happened to get.
  infisical_export_secrets DATABASE_URL DIRECT_URL || return 1

  # OPTIONAL, and each on a line of its OWN. That shape is load-bearing, not
  # style: `infisical_secrets` gives the caller every key it named or none of
  # them, so ONE call naming all three would export NOTHING at all the moment
  # any one of the three was unset — the exact silent, half-configured failure
  # this file was written to end. Three calls give three independent answers,
  # and setting one of them in Infisical takes effect on its own.
  #
  # They must stay optional: CI and a fresh checkout have no Infisical at all,
  # and must keep seeding on seed.ts's own fallbacks.

  # A real test-mode connected account for the Stripe-ready hero teacher,
  # instead of the fabricated `acct_seed_*` stub that Stripe answers with
  # `403 account_invalid` — the whole reason the card rail was untestable on
  # preview. Absent, seed.ts falls back to the stub, which is what CI wants.
  infisical_export_secrets SEED_STRIPE_ACCOUNT_ID || {
    echo "  (no SEED_STRIPE_ACCOUNT_ID in Infisical preview — seeding the acct_seed_* stub)" >&2
  }

  # The two real inboxes: the superadmin bootstrap, and the pilot tester who
  # needs to receive an actual sign-in code. Neither address is in this
  # repository (docs/security.md) — they live only in Infisical, and seed.ts
  # falls back to `.invalid` addresses that RFC 2606 guarantees can never route
  # mail, so an unset variable cannot quietly bootstrap superadmin onto an
  # address a stranger could register.
  infisical_export_secrets SEED_OPERATOR_EMAIL || {
    echo "  (no SEED_OPERATOR_EMAIL in Infisical preview — seeding the .invalid fallback)" >&2
  }
  infisical_export_secrets SEED_PILOT_TEACHER_EMAIL || {
    echo "  (no SEED_PILOT_TEACHER_EMAIL in Infisical preview — seeding the .invalid fallback)" >&2
  }
}
