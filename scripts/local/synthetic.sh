#!/usr/bin/env bash
# Read-only synthetic monitor against production. Run it: `pnpm local synthetic`.
#
# The local port of the deleted .github/workflows/synthetic.yml (D-129) — same
# probes, same body markers, same reasoning per probe. What changed is when it
# runs: there is no 12-hourly cron any more. `pnpm promote` runs this itself
# once production is serving the new code, because a deploy is when these
# regressions are introduced and therefore when the probes are worth anything.
# The rest of the time it is a command, and `pnpm local:status` says when it
# last passed.
#
# Every probe asserts a 200 AND a body marker. Status alone reports a healthy
# funnel nobody can buy from: a Next.js render error on one route, a landing
# page with no packages, a checkout with no payment rail — all still 200.
#
# Limits, unchanged from the workflow: no auth, no payments, no booking write.
# Full happy-path coverage means a credentialed synthetic (Checkly, Datadog).
set -uo pipefail

BASE_URL="${BASE_URL:-https://spiralclass.com}"
# A real, publicly listed teacher in PRODUCTION, named with her agreement. If
# renamed or deleted, update here — a 404 means the slug is gone or the public
# route regressed, and both are worth knowing about.
#
# ⚠️ Never a seed teacher. The publication sweep replaced this with
# `alicia-moreno`, the pseudonym apps/web/scripts/seed.ts creates locally, and
# production has no such page: the first deploy from this repository
# (2026-09-13) shipped, then failed four probes against a 404. The pseudonyms
# stay right everywhere that runs against the seed; this is the one file that
# runs against the live site. apps/web/tests/config/synthetic-probe.test.ts
# refuses any slug the seed creates.
TEACHER_SLUG="${TEACHER_SLUG:-ana-laura}"
# NOTE: LIVEKIT_URL used to live here, for a reachability probe that moved to
# HetrixTools on 2026-08-29 (see the MOVED block below). The lockstep rule it
# carried now belongs to that monitor: it must target the host
# config/env/production.runtime.env actually dials, which is
# `wss://livekit.spiralclass.com`. Probing the wrong one made a probe fail
# after a good deploy once already (D-138), so check the env file rather than
# the prose when moving it.
# The box's own IP, needed because the hostname is Cloudflare-proxied (D-134) —
# resolving it gives a Cloudflare edge address, whose certificate is Cloudflare's
# and always valid. Checking that would prove nothing about Caddy.
#
# ⚠ NOT DEFAULTED, and deliberately so. Hiding the origin behind Cloudflare is
# the protection; committing the origin address to a public repository undoes
# it. Export it, or put it in a gitignored local env file:
#
#   LIVEKIT_ORIGIN_IP=<origin> pnpm local synthetic
#
# The live value is the `content` of the Cloudflare DNS record for
# livekit.spiralclass.com, visible in the Cloudflare dashboard. A box
# replacement changes it there, and nothing here needs updating.
LIVEKIT_HOST="${LIVEKIT_HOST:-livekit.spiralclass.com}"

# ── Is production's video actually on the self-hosted box? ───────────────────
#
# [D-182] moved production video to LiveKit Cloud on 2026-09-19, while Oracle
# had no capacity to rebuild the box. The origin-certificate check below is
# about the BOX, so from that moment its subject was something production no
# longer used — and it duly went red on every release, reading as "production
# is broken" when production was fine. CLAUDE.md's own lesson: "when you retire
# a thing, retire its guard in the same change."
#
# Derived from config/env/production.runtime.env rather than from a flag or a
# sentence here, for the reason the LIVEKIT_URL note above already gives: that
# file is what production actually dials, and probing the wrong host made a
# probe fail after a good deploy once already (D-138). Deriving it also means
# the check comes back BY ITSELF the day D-182 is reversed and the URL points
# at the box again — no second edit, and no guard left asserting a dead premise.
# Anchored to this script's own location, not to the working directory. Every
# other check here reaches the app over HTTP and never touched the tree, so the
# script had no reason to know where it was until now — and a relative path
# would read as "no LIVEKIT_URL" from any directory but the repository root,
# which is a false failure in the one check whose job is to avoid those.
SYNTHETIC_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIVEKIT_URL_IN_CONFIG="$(
  sed -n 's/^LIVEKIT_URL=//p' \
    "$SYNTHETIC_REPO_ROOT/config/env/production.runtime.env" 2>/dev/null | tail -1
)"
# ⚠️ Compared as a HOST, never as a substring of the URL. A `== *"$LIVEKIT_HOST"*`
# test was the first version and CodeQL was right to fail it
# (js/incomplete-url-substring-sanitization): `livekit.spiralclass.com` can sit
# anywhere in a URL, so `wss://elsewhere.example/?x=livekit.spiralclass.com` — or
# `wss://livekit.spiralclass.com.example/` — would have read as "production is on
# the box" and sent this probe to check a certificate that decides nothing.
#
# Unlikely to arrive by accident, but this is the check that says whether the
# other one is meaningful, and it costs one parameter expansion to be exact:
# strip the scheme, then the path, then the port, and compare what is left.
LIVEKIT_URL_HOST="${LIVEKIT_URL_IN_CONFIG#*://}"
LIVEKIT_URL_HOST="${LIVEKIT_URL_HOST%%/*}"
LIVEKIT_URL_HOST="${LIVEKIT_URL_HOST%%:*}"
LIVEKIT_IS_SELF_HOSTED=0
[ -n "$LIVEKIT_URL_IN_CONFIG" ] && [ "$LIVEKIT_URL_HOST" = "$LIVEKIT_HOST" ] &&
  LIVEKIT_IS_SELF_HOSTED=1

# ⚠️ Required only WHEN THE CHECK WILL RUN. It used to be unconditional, which
# meant that while production was on LiveKit Cloud the whole probe refused to
# start without an address for a box it was not going to contact.
if [ "$LIVEKIT_IS_SELF_HOSTED" = "1" ] && [ -z "${LIVEKIT_ORIGIN_IP:-}" ]; then
  echo "synthetic: LIVEKIT_ORIGIN_IP is unset — the LiveKit origin certificate check cannot run." >&2
  echo "           Export it (see the comment above) or skip this probe deliberately." >&2
  exit 2
fi
LIVEKIT_ORIGIN_IP="${LIVEKIT_ORIGIN_IP:-}"
# Let's Encrypt issues for 90 days and Caddy renews at ~30 days remaining, so
# under this many days left means a renewal has already failed at least once —
# a real signal rather than a countdown that cries wolf every cycle.
LIVEKIT_CERT_MIN_DAYS="${LIVEKIT_CERT_MIN_DAYS:-21}"

failures=0
# ⚠️ Every body check is `grep -q … <<<"$body"`, never `printf "$body" | grep -q`.
# Under pipefail, GNU grep exits at its first match, printf takes EPIPE writing
# the rest of a page larger than the pipe buffer, and the pipeline fails: the
# marker reads as missing BECAUSE it was found. The 2026-09-13 deploy of #98
# went red that way on a booking page carrying ten package links. macOS's BSD
# grep drains its input, so it never shows on a laptop — only on the runner.
# apps/web/tests/config/synthetic-probe.test.ts reproduces it on both.
pass() { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1" >&2; failures=$((failures + 1)); }
# Neither green nor red: a check whose SUBJECT is not in production right now.
# Distinct from `pass` on purpose — "not applicable" and "verified" are
# different claims, and a probe that reported the first as the second would be
# the kind of sentence nothing verifies that CLAUDE.md's fourth rule is about.
skip() { printf '  – %s\n' "$1"; }

echo "Probing $BASE_URL"

# ── homepage renders with sign-in / sign-up CTAs ─────────────────────────────
response=$(curl -sS -w "\n%{http_code}" --max-time 15 "${BASE_URL}/" || true)
body=$(printf '%s\n' "$response" | sed '$d')
status=$(printf '%s\n' "$response" | tail -n1)
if [ "$status" != "200" ]; then
  fail "homepage returned $status"
elif ! grep -q "/sign-up" <<<"$body"; then
  fail "homepage body missing /sign-up CTA"
elif ! grep -q "/sign-in" <<<"$body"; then
  fail "homepage body missing /sign-in CTA"
else
  pass "homepage"
fi

# ── health endpoint reports db ok ────────────────────────────────────────────
response=$(curl -sS -w "\n%{http_code}" --max-time 15 "${BASE_URL}/api/health" || true)
body=$(printf '%s\n' "$response" | sed '$d')
status=$(printf '%s\n' "$response" | tail -n1)
if [ "$status" != "200" ]; then
  fail "/api/health returned $status (body: $body)"
elif ! grep -q '"status":"ok"' <<<"$body"; then
  fail "/api/health did not report status ok"
elif ! grep -q '"db":"ok"' <<<"$body"; then
  fail "/api/health did not report db ok"
else
  pass "/api/health"
fi

# ── public booking page renders a purchasable package ────────────────────────
# Body-marked, not status-only. A 200 proves the route handler ran; it does not
# prove the page is sellable. The landing page links each package at
# /b/<slug>/buy?package=<id> — no link means nothing is for sale.
response=$(curl -sS -w "\n%{http_code}" --max-time 20 "${BASE_URL}/b/${TEACHER_SLUG}" || true)
body=$(printf '%s\n' "$response" | sed '$d')
status=$(printf '%s\n' "$response" | tail -n1)
if [ "$status" != "200" ]; then
  fail "/b/${TEACHER_SLUG} returned $status"
elif ! grep -q "/b/${TEACHER_SLUG}/buy?package=" <<<"$body"; then
  fail "/b/${TEACHER_SLUG} rendered no purchasable package"
else
  pass "/b/${TEACHER_SLUG}"
fi

# ── checkout offers a working payment rail ───────────────────────────────────
# The landing page can look perfect while checkout offers no way to pay: both
# rails are gated on teacher state, and a teacher with neither still gets a 200
# buy page.
#
# This said until 2026-08-31 that an early teacher was "Wise-only, because
# her country is outside the Stripe Connect circle" (D-58), so a single rail was a
# single point of failure. D-143 reversed exactly that: the teacher is now
# merchant of record on her own connected account, her country is one of the 44
# measured Connect countries, and that account is live and charge-enabled. Both
# rails are available, and the probe matters for the opposite reason — a teacher can now lose
# the Stripe rail (a capability going restricted, requirements falling due)
# while the page still renders perfectly.
#
# KNOWN BLIND SPOT: `stripeReady` is `stripeAccountId && stripeChargesEnabled`,
# two database columns fed by the `account.updated` webhook. So this catches her
# account going restricted, and does NOT catch anything about the platform's own
# credentials — a rolled `STRIPE_SECRET_KEY` that never reached Fly leaves this
# probe green and every real checkout broken, because the first live Stripe call
# happens at session creation, after the buyer clicks Pay. Proving that needs a
# real Checkout Session, which writes rows; it is deliberately not done here.
#
# D-113 (2026-08-23) replaced the web buy page's `wiseReady` boolean with a
# full `instruments` array (a teacher can offer Wise AND a bank_account/SPEI
# instrument side by side) — `wiseReady` survives only on the mobile JSON API,
# kept there for the installed app. Readiness here mirrors purchase-flow.tsx's
# own `stripeReady || instruments.length > 0`: a non-empty `instruments` array
# starts with `[{`, so that's the marker for "at least one manual instrument".
response=$(curl -sS -w "\n%{http_code}" --max-time 20 "${BASE_URL}/b/${TEACHER_SLUG}/buy" || true)
body=$(printf '%s\n' "$response" | sed '$d')
status=$(printf '%s\n' "$response" | tail -n1)
if [ "$status" != "200" ]; then
  fail "/b/${TEACHER_SLUG}/buy returned $status"
elif ! grep -qE '\\"stripeReady\\":true|\\"instruments\\":\[\{' <<<"$body"; then
  fail "/b/${TEACHER_SLUG}/buy offers no payment rail"
else
  pass "/b/${TEACHER_SLUG}/buy"
fi

# ── booking page is discoverable in the sitemap ──────────────────────────────
# The listing gate is enforced in two places: the page, and a hand-written
# Prisma `where` in sitemap.ts. Unit tests pin those two to each other; this
# proves the deployed pair agree on real production data — which is what
# silently broke on 2026-07-26, when a gate change de-listed every teacher who
# had onboarded before it and the sitemap emptied out unnoticed.
body=$(curl -sS --max-time 20 "${BASE_URL}/sitemap.xml" || true)
if ! grep -q "/b/${TEACHER_SLUG}<" <<<"$body"; then
  fail "/sitemap.xml does not list /b/${TEACHER_SLUG}"
else
  pass "sitemap lists /b/${TEACHER_SLUG}"
fi

# ── share card renders the teacher, not the generic fallback ─────────────────
# opengraph-image.tsx degrades to the brand card instead of 404ing when the
# teacher isn't publicly listed, so a broken share preview is completely silent
# — and the launch channel is Facebook, where this image IS the post. Size is
# the available signal: the per-teacher card embeds her photo as a data URL and
# is several times the weight of the photoless generic one (~50KB vs ~95KB,
# measured 2026-07-29). A loose floor on purpose: this catches "fell back to the
# brand card", not a photo swap.
read -r status bytes < <(curl -sS -o /dev/null \
  -w "%{http_code} %{size_download}\n" --max-time 30 \
  "${BASE_URL}/b/${TEACHER_SLUG}/opengraph-image" || echo "000 0")
if [ "$status" != "200" ]; then
  fail "opengraph-image returned $status"
elif [ "$bytes" -lt 60000 ]; then
  fail "opengraph-image looks like the generic fallback card ($bytes bytes)"
else
  pass "opengraph-image (${bytes} bytes)"
fi

# ── MOVED TO HETRIXTOOLS, 2026-08-29 ────────────────────────────────────────
# Two probes that used to live here have moved, because they detect
# TIME-driven failures rather than DEPLOY-driven ones and this file only runs
# by hand and on `pnpm promote`. A certificate stops renewing on a Tuesday
# nobody deployed.
#
#   - self-hosted LiveKit box reachable (D-94) — covered by the
#     `livekit.spiralclass.com` HetrixTools monitor, 5-minute, four locations,
#     200 + body "OK".
#   - ACME HTTP-01 challenge path — a new HetrixTools monitor, 10-minute, four
#     locations, expecting exactly 308 with redirects not followed. A 301 means
#     a Cloudflare edge redirect is intercepting :80 and renewal has no working
#     path left; see D-134 and docs/deployment/ORACLE_BOX_REBUILD.md.
#
# Added 2026-08-30, same reasoning, after the D-138 rename broke both of them:
#
#   - `spiralclass livekit webhook` — 5-minute, four locations, GET, redirects
#     NOT followed, accepting only 405. The route is POST-only, so 405 is the
#     app answering; a 301 is the origin redirecting and is exactly the failure
#     that killed every lesson-insight webhook on 2026-08-30. Same shape as the
#     two Stripe webhook monitors, which exist for the same reason
#     (2026-08-29). Its twin watched the box-side caption worker's callback
#     route; that route was deleted when captions moved into the browser
#     (D-185), so that monitor can only answer 404 — delete it in HetrixTools
#     if it is still there.
#
# ⚠ This monitors the APP half only. It cannot see the Oracle box's own
# `.env` / `livekit.yaml`, which is where that outage actually lived — the box
# was still pointed at `agendaprofe.com` long after the app was fine. Nothing
# external can see that; scripts/oracle-deploy.sh's callback probe checks it
# from the box on every deploy, and docs/deployment/ORACLE_BOX_REBUILD.md's
# "two URLs on this box" section explains it.
#
# ⚠ `livekit.agendaprofe.com` is deliberately NOT monitored, and this note
# exists because a session added monitors for it on 2026-08-29 and had to take
# them straight back out. The Caddyfile comment and D-138 both say production
# "still" dials the old hostname; that is stale. config/env/production.runtime.env
# has read `wss://livekit.spiralclass.com` since the cutover, so nothing reaches
# the old name and a failed renewal on it breaks nothing. Caddy still serves it,
# so it can still be dropped from the Caddyfile — but do not monitor it.
#
# What stayed here, and why, so nobody "finishes the job" later:
# everything else in this file asserts something a DEPLOY breaks — a render
# regression, a missing CTA, a package that stopped rendering — and a deploy
# is when it is worth checking. Moving those to a 1-minute external clock buys
# nothing and costs the alert fatigue scripts/local/jobs.mjs warns about.

# ── the LiveKit box's ORIGIN certificate is not about to expire ──────────────
# Caddy auto-renews, and until D-134 it had two independent ways to prove
# control of the hostname: TLS-ALPN-01 and HTTP-01. Proxying the record through
# Cloudflare terminates TLS at the edge, so TLS-ALPN-01 can no longer work at
# all. HTTP-01 is now the only path left — one link deep instead of two.
#
# ⚠ THIS COMMENT USED TO SAY "Always Use HTTPS is on, so :80 never reaches
# Caddy". That was wrong, and it was never tested. Measured on 2026-08-29: a
# plain-HTTP request to the challenge path DOES reach Caddy — it appears in
# Caddy's own log ("looking up info for HTTP challenge") arriving from a
# Cloudflare address, and the 308 that comes back is Caddy's own redirect, not
# Cloudflare's. Cloudflare is forwarding :80 to the origin, which is precisely
# what HTTP-01 needs and precisely what "Always Use HTTPS" would destroy.
#
# That distinction is now a probe rather than a belief — see the next check.
#
# Deliberately against the ORIGIN IP with SNI, not the hostname: the hostname now
# resolves to Cloudflare, whose own certificate is always valid and says nothing
# about whether Caddy renewed.
#
# ⚠ THIS ONE CANNOT MOVE TO HETRIXTOOLS, and it is not for want of trying
# (checked 2026-08-29). A HetrixTools monitor resolves its target by DNS —
# `resolve_address` in its API is what it resolved, not an override you can set
# — so it would read Cloudflare's edge certificate and stay green through an
# origin expiry. Pointing one straight at https://203.0.113.10/ fails too:
# Caddy refuses the handshake when SNI matches no site block. So this stays
# here, on a hand-run clock, and the HetrixTools ACME-path monitors are what
# actually give warning — they fail weeks earlier, the moment renewal loses its
# only remaining challenge type.
if [ -z "$LIVEKIT_URL_IN_CONFIG" ]; then
  # Not a skip: the file that says where production's video lives is the one
  # thing this check cannot do without, and its absence is a real fault.
  fail "config/env/production.runtime.env names no LIVEKIT_URL — cannot tell which host production dials"
elif [ "$LIVEKIT_IS_SELF_HOSTED" != "1" ]; then
  # Production dials something other than the box — LiveKit Cloud, under
  # [D-182]. The box's certificate is not production's problem today.
  skip "LiveKit origin cert — production dials ${LIVEKIT_URL_IN_CONFIG}, not ${LIVEKIT_HOST} (D-182)"
elif ! command -v openssl >/dev/null 2>&1; then
  fail "openssl not found — cannot check the LiveKit origin certificate"
else
  cert=$(echo | openssl s_client -connect "${LIVEKIT_ORIGIN_IP}:443" \
    -servername "${LIVEKIT_HOST}" 2>/dev/null || true)
  if [ -z "$cert" ]; then
    fail "could not read a certificate from the LiveKit origin (${LIVEKIT_ORIGIN_IP}:443)"
  else
    expiry=$(printf '%s' "$cert" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    if [ -z "$expiry" ]; then
      fail "LiveKit origin served something that isn't a parseable certificate"
    # -checkend rather than date arithmetic: BSD date (macOS, where this runs —
    # D-119) has no -d, and this needs no portability shim.
    elif ! printf '%s' "$cert" |
      openssl x509 -noout -checkend $((LIVEKIT_CERT_MIN_DAYS * 86400)) >/dev/null 2>&1; then
      fail "LiveKit origin cert expires within ${LIVEKIT_CERT_MIN_DAYS}d (${expiry}) — Caddy's renewal has stalled"
    else
      pass "LiveKit origin cert (expires ${expiry})"
    fi
  fi
fi

# ── Stripe webhook rejects a forged signature ────────────────────────────────
# The one live-deployment check nothing else asserts: that the Connect webhook
# is signature-verified on the DEPLOYED env (secret present, not bypassed).
# In-process rejection is unit-tested; this proves the running deploy refuses a
# forged event before any processing.
#   200 → verification BYPASSED (hard incident)
#   503 → STRIPE_WEBHOOK_SECRET missing on the deploy
#   401 → correct refusal
status=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 \
  -X POST "${BASE_URL}/api/stripe/webhook" \
  -H "Content-Type: application/json" \
  -H "stripe-signature: t=1,v1=garbage" \
  -d '{"id":"evt_synthetic","type":"ping"}' || echo 000)
if [ "$status" != "401" ]; then
  fail "/api/stripe/webhook accepted a forged signature (status $status, expected 401)"
else
  pass "stripe webhook rejects a forged signature"
fi

echo ""
if [ "$failures" -gt 0 ]; then
  echo "$failures probe(s) failed against $BASE_URL" >&2
  exit 1
fi
echo "All probes passed against $BASE_URL"
