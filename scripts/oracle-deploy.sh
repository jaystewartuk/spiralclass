#!/usr/bin/env bash
# Deploy the whole Oracle box: the LiveKit stack, the preview web app and
# preview's Postgres. Idempotent — run it as often as you like.
#
# ⚠️ PRODUCTION IS NOT DEPLOYED FROM HERE. The production web app is on Fly
# and its database is on Neon (D-150's second addendum, 2026-09-04);
# scripts/fly-deploy.sh ships it and nothing in this file touches it.
#
# ⚠️ THIS IS THE ONLY THING THAT DEPLOYS THE BOX. `deploy-preview.yml` is
# what calls it once the box is serving — and when it does, it must invoke
# this script and list no steps of its own, exactly as gate.yml calls
# scripts/ci/gate.mjs. That is the condition on which Actions was allowed back
# at all (D-157): a workflow that restates what a script does is a second
# definition, and it agrees on the day it is written and drifts silently
# after.
#
# So: everything below must work from a laptop, unchanged. If a step can only
# run in CI, it does not belong here and probably does not belong at all.
#
#   ./scripts/oracle-deploy.sh                  # deploy everything
#   ./scripts/oracle-deploy.sh --verify-only    # check, change nothing
#   ./scripts/oracle-deploy.sh --restore-caddy  # first run after a rebuild
set -euo pipefail

BOX="${ORACLE_BOX_HOST:-spiralclass-box}"
REMOTE_USER="${ORACLE_BOX_USER:-ubuntu}"
SSH="ssh -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new ${REMOTE_USER}@${BOX}"
STACK_DIR="/home/ubuntu/oracle-livekit-production"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_STACK="${REPO_ROOT}/infra/oracle-box/stack"
# ⚠️ No fallback default (D-158). A working default is a committed account
# identifier with a switch beside it, which is exactly how this one read as
# configurable in review for two months. Order: the environment, then the
# gitignored project link, then a loud failure.
# ⚠️ This script destroys and rebuilds a box. Which project its secrets came
# from is never inferred and never merely resolved — it is VERIFIED against
# infra/infisical/project.sha256 before a single value is fetched.
# ⚠️ Escape hatch, if the guard itself is ever what is wrong mid-cutover:
#     INFISICAL_SKIP_PROJECT_CHECK=1 scripts/oracle-deploy.sh …
# shellcheck source=../infra/infisical/infisical.sh
source "${REPO_ROOT}/infra/infisical/infisical.sh"
INFISICAL_PROJECT="$(infisical_project_id)" || exit 1
CAPTURE_DIR="${ORACLE_CAPTURE_DIR:-$HOME/oracle-capture-2026-09-04}"
# The compose project name is the basename of STACK_DIR — verified on Compose
# 5.4.0: hyphens are kept, so the volume really is
# `oracle-livekit-production_caddy_data`, and a volume created by hand under
# that name is picked up (compose warns that it did not create it, and mounts
# it anyway). The old box's own capture came out of this same path, which is
# independent evidence the derivation holds on the version the box runs.
CERT_ROOT="/var/lib/docker/volumes/oracle-livekit-production_caddy_data/_data"

VERIFY_ONLY=0
RESTORE_CADDY=0
for arg in "$@"; do
  case "$arg" in
    --verify-only)   VERIFY_ONLY=1 ;;
    --restore-caddy) RESTORE_CADDY=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m› %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }

# Anything appended here is echoed to the terminal AND, in CI, becomes the run
# summary — so a reviewer reads a verdict instead of opening logs. Same habit
# as scripts/ci/gate.mjs.
summary() {
  printf '%s\n' "$*"
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
  return 0
}

# ── 1. Preflight ──────────────────────────────────────────────────────────
say "Preflight"

command -v infisical >/dev/null || fail "infisical CLI not found"
[ -n "$INFISICAL_PROJECT" ] || fail "No Infisical project id. Export INFISICAL_PROJECT_ID, or run \`infisical init\` in \$HOME, or create infra/infisical/.infisical.json from its .example (D-158)."
ok "infisical project: $INFISICAL_PROJECT"

$SSH true 2>/dev/null || fail "cannot reach ${BOX} over the tailnet.

  Tailscale SSH is the only way in — :22 is closed to the internet on purpose
  and there is no management CIDR to open. If the tailnet join failed, the way
  in is the OCI serial console, not a firewall change:

    oci compute instance-console-connection create \\
      --instance-id \$INSTANCE_OCID --ssh-public-key-file ~/.ssh/id_ed25519.pub"
ok "reachable: ${BOX}"

# ⚠️ Did the boot volume's filesystem actually grow? `boot_volume_gb` is 200,
# and cloud-init's growpart is what turns that into a 200 GB root. If the
# image ever stops doing that, nothing else here notices: the IOPS reason for
# taking the whole allowance still holds at the volume level, so the box feels
# fine right up until a deploy fills 47 GB. Warn, never fail — a deliberately
# smaller boot_volume_gb is a legitimate configuration.
ROOT_GB="$($SSH "df -BG --output=size / | tail -1 | tr -dc '0-9'" 2>/dev/null || echo 0)"
if [ "${ROOT_GB:-0}" -lt 150 ]; then
  printf '\033[33m! root filesystem is %s GB — boot_volume_gb is 200, so the partition may not have grown\033[0m\n' "${ROOT_GB:-?}" >&2
else
  ok "root filesystem: ${ROOT_GB} GB"
fi

# ⚠️ The images are built OFF this box — see the compose file. A box that
# builds is a box spending both its OCPUs on something other than a class.
#
# ⚠️ APP_IMAGE_PREVIEW MUST BE A PREVIEW BUILD, and there is no longer a
# production image on this box to fall back to — which is the one good thing
# about production having left. Every NEXT_PUBLIC_* is baked at BUILD time
# (Dockerfile ARG, fed by scripts/env-build-args.mjs), so a production build
# permanently carries NEXT_PUBLIC_DEPLOY_ENV=production;
# apps/web/next.config.ts hands that to buildSecurityHeaders, which emits
# `X-Robots-Tag: noindex, nofollow` ONLY for a non-production deploy. Run one
# here and preview.spiralclass.com — a Cloudflare-proxied public hostname full
# of seeded teachers — becomes indexable, while production's Stripe
# publishable key, Sentry DSN and PostHog key ship inside preview's browser
# bundle.
: "${APP_IMAGE_PREVIEW:?set APP_IMAGE_PREVIEW to the PREVIEW web app image (digest or tag)}"
: "${CAPTIONS_AGENT_IMAGE:?set CAPTIONS_AGENT_IMAGE}"
ok "images: preview=${APP_IMAGE_PREVIEW} captions=${CAPTIONS_AGENT_IMAGE}"

# ── 2. Render config from Infisical ───────────────────────────────────────
# ⚠️ Infisical is the source of truth for every one of these. Nothing here is
# committed, and nothing here is edited on the box — regenerate instead.
say "Rendering config from Infisical"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"

# ⚠️ THE APP NEEDS BOTH INFISICAL PATHS, AND THIS IS NOT WHAT THE RUNBOOK SAYS.
#
# ORACLE_BOX_REBUILD.md describes generating the app's env from `/config` and
# talks only about the nine `__LOCAL__` values. That is half the story. Those
# nine are the ones the ENTRYPOINT refuses to export; but the app also needs
# every genuinely secret value that used to arrive as a Fly secret —
# DATABASE_URL, SESSION_SECRET, BETTER_AUTH_SECRET, STRIPE_SECRET_KEY,
# FIELD_ENCRYPTION_KEY and the rest — and those live at Infisical's ROOT path,
# not in /config.
#
# Found by actually running the image before the rebuild rather than after:
# with only /config supplied it starts, prints `Ready in 115ms`, and then dies
# with `Invalid server environment: SESSION_SECRET: Required` and serves 500
# to everything. Mid-cutover, that is a fault diagnosed under the worst
# possible conditions.
#
# /config is applied LAST so that if a name ever appears in both, the
# environment-specific config wins over the shared secret store.
render_app_env() {
  local env="$1" out="$2"

  # /config LAST, so an environment-specific value wins over a shared secret
  # of the same name. infisical_env emits paths in the order given.
  infisical_env "$env" / /config > "$out" || fail "$env: Infisical export failed"
  chmod 600 "$out"

  # ⚠️ DERIVED FROM config/env/<env>.runtime.env, NOT RESTATED HERE.
  #
  # The names are whichever ones that file sets to the literal `__LOCAL__` —
  # that file IS the definition of "the value deliberately is not in git", and
  # it is what scripts/docker-entrypoint.sh reads to decide what it refuses to
  # export. An earlier version hardcoded the nine as a regex, and
  # verify-runtime-env.sh hardcoded them a second time, so a tenth
  # `__LOCAL__` added later would have been checked by neither: the deploy
  # would report "all nine present", the tenth would boot unset, and per the
  # comment below that is a feature broken with nothing in any log.
  #
  # Names, not a count, for the same reason a count was wrong before: a name
  # present at BOTH Infisical paths appears twice in the concatenation, so
  # nine lines never meant nine distinct values.
  local expected missing k
  expected="$(grep '=__LOCAL__$' "${REPO_ROOT}/config/env/${env}.runtime.env" | cut -d= -f1 | sort -u)"
  [ -n "$expected" ] || fail "$env: config/env/${env}.runtime.env lists no __LOCAL__ values — that file is the source of truth and it looks wrong"

  missing=""
  for k in $expected; do
    grep -q "^${k}=" "$out" || missing="${missing} ${k}"
  done

  # A short export is not a warning — it is an app that will either refuse to
  # boot or boot without sign-in and checkout.
  [ -z "$missing" ] || fail "$env: Infisical supplied no value for:${missing}"

  local n_total n_cfg
  n_total="$(grep -c '^[A-Z_][A-Z0-9_]*=' "$out" || true)"
  n_cfg="$(printf '%s\n' "$expected" | grep -c . || true)"
  grep -q '^SESSION_SECRET=' "$out"  || fail "$env: SESSION_SECRET missing — the app will not start"
  grep -q '^DATABASE_URL=' "$out"    || fail "$env: DATABASE_URL missing — the app will not start"
  ok "$env: $n_total values (all $n_cfg __LOCAL__ overrides, plus the root secrets)"
}

# ⚠️ Preview only. Production's environment is Fly's, set by
# `flyctl secrets` and by config/env/production.*.env at build time — nothing
# here renders it and nothing here should.
render_app_env preview "$TMP/preview.app.env"

# ⚠️ The LiveKit stack's own variables are NOT rendered here. They come from
# scripts/oracle-render-livekit.sh, which writes the `.env` compose actually
# reads. An earlier version of this script exported them to $TMP/stack.env,
# never shipped the file, and never read it — dead code that read exactly like
# the thing supplying compose's substitutions, which is how a set of missing
# variables survived review.

# ── 3. Render the LiveKit config, and point preview at its own database ───
# ⚠️ ORDER MATTERS. This runs BEFORE anything ships, because it generates
# preview's Postgres credentials, and preview.app.env has to carry the matching
# connection string. An earlier version rendered this AFTER shipping the env
# files, so the override never reached the box: preview kept the Neon URL it
# gets from Infisical and the Postgres container on this box sat provisioned,
# published and completely unused.
say "Rendering livekit.yaml, egress.yaml and preview's database credentials"

# ⚠️ THE PREVIEW DATABASE PASSWORD LIVES ON THE BOX, AND MUST BE READ BACK.
#
# Postgres writes the password into the data directory at initdb and IGNORES
# POSTGRES_PASSWORD on every start after that. So a deploy that invents a new
# one gives you: a container that starts, a `pg_isready -q` that passes
# because it never authenticates, eight running containers, a green
# verify-runtime-env — and a preview app failing every query with `password
# authentication failed`. The deploy reports success.
#
# oracle-render-livekit.sh has a persistence check of its own, but it looks in
# its OUTPUT directory, which is the `mktemp -d` below — fresh every run, so
# that branch can never fire on this path and a second deploy silently broke
# preview. The durable copy is the `.env` already on the box; read it here,
# where the ssh connection is, and hand it over as an override.
#
# The `sed 's/\$\$/$/g'` undoes the compose escaping the render script applies
# on the way out (a `$` in a compose `.env` value is interpolated away, so it
# is written as `$$`). Generated passwords are base64 with `/+=` stripped and
# never contain one, but an operator-supplied PREVIEW_DB_PASSWORD can, and
# without this the value would gain a `$` on every round trip.
if EXISTING_DB_PASSWORD="$($SSH "sed -n 's/^PREVIEW_DB_PASSWORD=//p' ${STACK_DIR}/.env 2>/dev/null" 2>/dev/null | sed 's/\$\$/$/g')" \
   && [ -n "$EXISTING_DB_PASSWORD" ]; then
  export PREVIEW_DB_PASSWORD="$EXISTING_DB_PASSWORD"
  ok "reusing preview's existing database password"
else
  unset PREVIEW_DB_PASSWORD || true
  ok "no password on the box yet — generating one (first deploy)"
fi

"${REPO_ROOT}/scripts/oracle-render-livekit.sh" "$TMP" >/dev/null || fail "render failed"
[ -f "$TMP/preview-db.env" ] || fail "render produced no preview-db.env"

# /config was applied last for the app; this is applied last of all, so
# preview's DATABASE_URL points at the container beside it rather than Neon.
cat "$TMP/preview-db.env" >> "$TMP/preview.app.env"
ok "preview points at postgres-preview, not Neon"

# ⚠️ THE BOX HOLDS NO PRODUCTION DATABASE AT ALL, and that is deliberate.
# Production stays on Neon — D-150 rejected colocating it on the operator's
# own measured history: when backups depended on a human remembering,
# production went ELEVEN DAYS with no backup and nobody noticed. An earlier
# draft of this rebuild provisioned an idle Postgres here "ready if the
# decision is revisited"; the decision was settled instead, so it came out
# rather than run for a day that is not coming. Reopening it means building
# the automated, off-box, monitored, restore-TESTED backup FIRST — that is the
# whole objection, and a container is not an answer to it.

# ── 4. Ship the stack ─────────────────────────────────────────────────────

# ⚠️ COMPOSE DOES NOT NOTICE THAT A BIND-MOUNTED FILE CHANGED, AND THE
# ASYMMETRY THAT CREATES IS A SILENT OUTAGE.
#
# `docker compose up -d` recreates a container when its service DEFINITION
# hash changes — image, environment, ports, volume declarations. The CONTENT
# behind a bind mount is not in that hash. So shipping a new livekit.yaml,
# egress.yaml or Caddyfile and running `up -d` leaves all three processes
# running their old configuration, and the deploy says nothing.
#
# The asymmetry is the dangerous half. The captions agent takes its LiveKit
# credentials through `environment:` interpolated from `.env`, which IS in the
# hash — so it gets recreated with the new key while livekit-server, reading
# the same key from the bind-mounted livekit.yaml, keeps the old one. Rotate
# the key pair (CUTOVER.md step 9 says to, and says now is cheapest) and you
# get an agent that cannot authenticate against a server that looks perfectly
# healthy: captions silently dead, which is the 2026-08-30 symptom with a
# third distinct cause.
#
# So compare before shipping and act after starting. Caddy has a graceful
# reload; livekit-server and egress do not, and restarting them drops whatever
# is connected — which is why this is content-addressed rather than
# unconditional.
CHANGED=""
remote_differs() {
  local local_file="$1" remote_name="$2" local_sum remote_sum
  local_sum="$(shasum -a 256 "$local_file" | cut -d' ' -f1)"
  remote_sum="$($SSH "sha256sum ${STACK_DIR}/${remote_name} 2>/dev/null | cut -d' ' -f1" 2>/dev/null || true)"
  [ "$local_sum" != "$remote_sum" ]
}

if [ "$VERIFY_ONLY" -eq 0 ]; then
  if remote_differs "${LOCAL_STACK}/Caddyfile" Caddyfile;  then CHANGED="$CHANGED caddy";   fi
  if remote_differs "$TMP/livekit.yaml"       livekit.yaml; then CHANGED="$CHANGED livekit"; fi
  if remote_differs "$TMP/egress.yaml"        egress.yaml;  then CHANGED="$CHANGED egress";  fi
fi

if [ "$VERIFY_ONLY" -eq 0 ]; then
  say "Shipping stack files"
  $SSH "install -d -m 0755 ${STACK_DIR}"
  scp -q "${LOCAL_STACK}/docker-compose.yml" "${LOCAL_STACK}/Caddyfile" \
    "${LOCAL_STACK}/verify-runtime-env.sh" "${LOCAL_STACK}/verify-app-egress.sh" \
    "${REMOTE_USER}@${BOX}:${STACK_DIR}/"
  scp -q "$TMP/preview.app.env" "${REMOTE_USER}@${BOX}:${STACK_DIR}/"
  scp -q "$TMP/livekit.yaml" "$TMP/egress.yaml" "$TMP/.env" \
    "${REMOTE_USER}@${BOX}:${STACK_DIR}/"
  $SSH "chmod 600 ${STACK_DIR}/*.app.env ${STACK_DIR}/livekit.yaml ${STACK_DIR}/egress.yaml ${STACK_DIR}/.env"
  $SSH "chmod +x ${STACK_DIR}/verify-runtime-env.sh ${STACK_DIR}/verify-app-egress.sh"
  ok "compose, Caddyfile, preview's env file and LiveKit config in place"
fi

# ── 5. Restore the certificates, on a fresh box only ──────────────────────
# ⚡ This is what stops a rebuild costing a re-issuance. The caddy_data volume
# holds the ACME account key and the live certificate for
# livekit.spiralclass.com, captured before the old box was destroyed. Restored,
# that hostname's TLS survives the rebuild untouched.
#
# ⚠️ It does NOT cover preview.spiralclass.com — that name is new to Caddy and
# must be issued, which needs "Always Use HTTPS" OFF on the zone (D-134).
# `spiralclass.com` is not served here at all: it is on Fly, behind Cloudflare,
# and Caddy on this box must never be given it.
if [ "$RESTORE_CADDY" -eq 1 ]; then
  say "Restoring caddy_data (ACME account key + certificates)"
  [ -f "${CAPTURE_DIR}/caddy_data.tar.gz" ] || fail "no caddy_data.tar.gz in ${CAPTURE_DIR}"
  $SSH "docker volume create oracle-livekit-production_caddy_data >/dev/null"
  # shellcheck disable=SC2002
  cat "${CAPTURE_DIR}/caddy_data.tar.gz" | $SSH \
    "sudo tar -xzf - -C ${CERT_ROOT}"

  # ⚠️ TAR EXITING 0 IS NOT THE SAME AS THE CERTIFICATES BEING WHERE CADDY
  # LOOKS, AND THE DIFFERENCE IS SILENT.
  #
  # An archive built from an absolute path unpacks to
  # `_data/var/lib/docker/volumes/.../_data/...` — tar succeeds, this step
  # printed "certificates restored", and Caddy then finds an empty volume and
  # goes to Let's Encrypt for a name that already had a valid certificate.
  # That is the one outcome the whole capture exists to prevent, and it is an
  # issuance through Cloudflare's proxy: the most fragile step there is, taken
  # by accident, at the worst moment.
  #
  # So assert the shape rather than the exit code. Both halves matter — the
  # ACME ACCOUNT KEY is what cannot be regenerated, and the certificate is
  # what saves the issuance.
  $SSH "sudo test -d ${CERT_ROOT}/caddy/certificates" \
    || fail "restore left no ${CERT_ROOT}/caddy/certificates — the archive almost certainly carries a path prefix (rebuild it with 'tar -czf - -C <volume>/_data .')"
  $SSH "sudo find ${CERT_ROOT}/caddy/certificates -name 'livekit.spiralclass.com.crt' | grep -q ." \
    || fail "restore produced no certificate for livekit.spiralclass.com — do NOT continue; Caddy will re-issue through Cloudflare's proxy"
  $SSH "sudo find ${CERT_ROOT}/caddy/acme -name '*.key' | grep -q ." \
    || fail "restore produced no ACME account key — that is the part that cannot be regenerated"
  ok "certificates and ACME account key restored, and verified in place"
fi

# ── 6. Bring it up ────────────────────────────────────────────────────────
if [ "$VERIFY_ONLY" -eq 0 ]; then
  say "Starting the stack"
  # ⚠️ --remove-orphans earns its place on the first deploy after this
  # topology change: it is what takes `spiralclass-production` and
  # `spiralclass-production-db` off a box that has already run the earlier
  # compose file. Without it they keep running, unreferenced by anything,
  # holding production's whole secret surface on a box that no longer needs
  # it.
  $SSH "cd ${STACK_DIR} && \
    APP_IMAGE_PREVIEW='${APP_IMAGE_PREVIEW}' \
    CAPTIONS_AGENT_IMAGE='${CAPTIONS_AGENT_IMAGE}' \
    docker compose up -d --remove-orphans"
  ok "compose up"

  # The other half of the bind-mount problem described above. Only the
  # services whose config file actually changed, because two of these three
  # cannot reload gracefully.
  if [ -n "$CHANGED" ]; then
    say "Applying changed config files (compose did not)"
    for svc in $CHANGED; do
      case "$svc" in
        caddy)
          # Graceful: Caddy reloads without dropping connections.
          $SSH "docker exec livekit-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile" \
            || fail "Caddyfile changed but Caddy would not reload it — it is still serving the old config"
          ok "Caddyfile changed — Caddy reloaded"
          ;;
        livekit | egress)
          # ⚠️ NOT graceful. livekit-server has no config reload, so this
          # drops every session on it. Unavoidable if the file changed —
          # running on stale config is worse — but never do it during a class.
          printf '\033[33m! %s.yaml changed — restarting %s, which DROPS anything connected to it\033[0m\n' "$svc" "$svc" >&2
          $SSH "cd ${STACK_DIR} && \
            APP_IMAGE_PREVIEW='${APP_IMAGE_PREVIEW}' \
            CAPTIONS_AGENT_IMAGE='${CAPTIONS_AGENT_IMAGE}' \
            docker compose restart ${svc}" \
            || fail "${svc}.yaml changed but ${svc} would not restart — it is still running the old config"
          ok "${svc}.yaml changed — ${svc} restarted"
          summary "- ⚠️ ${svc} was restarted to pick up a changed ${svc}.yaml (sessions on it were dropped)"
          ;;
      esac
    done
  else
    ok "livekit.yaml, egress.yaml and the Caddyfile are unchanged — nothing to reload"
  fi
fi

# ── 7. Verify ─────────────────────────────────────────────────────────────
# ⚠️ THE FAILURE THIS CATCHES IS SILENT. scripts/docker-entrypoint.sh refuses
# to export a __LOCAL__ placeholder, by design — so an app missing these boots
# cleanly, logs nothing wrong, and loses sign-in, checkout and LiveKit. You
# find out from a person, not from the deploy. Do not treat a quiet boot as a
# passing boot; this check is the boot.
say "Verifying the __LOCAL__ runtime values inside the preview container"

# The check itself is a script that runs ON the box — see
# infra/oracle-box/stack/verify-runtime-env.sh. It is deliberately not an
# inline SSH one-liner: the quoting needed to nest `docker exec ... sh -c` in
# an ssh argument in a command substitution is exactly the kind of thing that
# silently stops checking anything while still exiting 0.
FAILED=0

if $SSH "${STACK_DIR}/verify-runtime-env.sh spiralclass-preview"; then
  ok "preview: every __LOCAL__ runtime value present"
  summary "- Runtime config — every __LOCAL__ value present in preview"
else
  FAILED=1
  summary "- ⚠️ Runtime config — values MISSING, see the deploy output"
fi

say "Container state"
# ⚠️ --filter status=running. Plain `docker ps` lists a container that is
# crash-looping, so a restart-looping Postgres passed this check while the
# deploy reported success.
$SSH "docker ps --filter status=running --format '{{.Names}}\t{{.Status}}'" | tee "$TMP/ps.txt"
EXPECTED="livekit-caddy livekit-server livekit-egress livekit-redis \
livekit-captions-agent spiralclass-preview spiralclass-preview-db"
for c in $EXPECTED; do
  grep -q "^${c}[[:space:]]" "$TMP/ps.txt" || { printf '\033[31m✗ %s not running\033[0m\n' "$c" >&2; FAILED=1; }
done

# ⚠️ Preview's database gets its own check, because "the container exists" is
# not the failure mode. Given no password it exits 1 and restart-loops, and a
# name match against `docker ps` is satisfied by a container in that state.
if $SSH "docker exec spiralclass-preview-db pg_isready -q" 2>/dev/null; then
  ok "preview database accepting connections"
else
  printf '\033[31m✗ preview database is not accepting connections\033[0m\n' >&2
  summary "- ⚠️ Preview database — NOT accepting connections"
  FAILED=1
fi

# ⚠️ PREVIEW'S OWN ROUTE TO LIVEKIT, which no amount of colocation fixes.
#
# LIVEKIT_URL is `wss://livekit.spiralclass.com` and cannot be loopback — the
# same value is what the BROWSER connects to. So the preview app, on a docker
# BRIDGE network on this box, resolves that public name, leaves the box and
# comes back to it. (Production asks the same question from Fly over the
# ordinary internet, and has been answering it correctly for months.)
#
# ⚠️ EXPECTED TO FAIL UNTIL DNS POINTS AT THIS BOX. Run it again at
# CUTOVER.md step 7, and do not re-proxy Cloudflare until it passes: when this
# is broken, livekit-server looks perfectly healthy and no class can be
# created. Warning, not a verdict, precisely because the deploy legitimately
# runs before DNS moves.
say "Preview's own route to LiveKit"
if $SSH "${STACK_DIR}/verify-app-egress.sh spiralclass-preview"; then
  ok "preview can reach its LiveKit server"
  summary "- Preview → LiveKit — reachable from inside the container"
else
  printf '\033[33m! preview cannot reach its LiveKit server (expected before DNS moves — must pass before you re-proxy)\033[0m\n' >&2
  summary "- ⚠️ Preview → LiveKit — NOT reachable; no class can be created on preview until it is"
fi

# ⚠️ THE CALLBACK INTO PRODUCTION, AND THIS IS THE ONLY THING WATCHING IT.
#
# livekit-server's webhook and the captions agent both post to
# APP_INTERNAL_BASE_URL, which is production ON FLY — off this box, through
# Cloudflare. That is the 2026-08-30 path: a stale hostname answered with a
# 301, the 301 turned the agent's POST into a GET, it got a 405,
# discovery.ts started no RoomWorker, and a real class ran with captions
# silently dead while livekit-server's own log said `sent webhook`. A redirect
# is indistinguishable from success from every other angle, which is why it is
# asserted on every deploy rather than reasoned about once.
#
# 401 is the PASS: the route was reached and it rejected an unsigned body.
# Any 3xx is a failure. 000 means the box could not reach it at all.
say "The callback into production (Fly), from this box"
CALLBACK_BASE="$(sed -n 's/^APP_INTERNAL_BASE_URL=//p' "$TMP/.env" | sed 's/\$\$/$/g')"
[ -n "$CALLBACK_BASE" ] || fail "no APP_INTERNAL_BASE_URL was rendered — the captions agent has no app to call"
CALLBACK_CODE="$($SSH "curl -s -o /dev/null -m 15 -w '%{http_code}' -X POST ${CALLBACK_BASE}/api/livekit/webhook" 2>/dev/null || echo 000)"
case "$CALLBACK_CODE" in
  401 | 403)
    ok "callback: ${CALLBACK_BASE} answered ${CALLBACK_CODE} — route reached, unsigned body rejected"
    summary "- Callback into production — ${CALLBACK_CODE}, no redirect"
    ;;
  3??)
    printf '\033[31m✗ callback: %s answered %s — A REDIRECT. This is the 2026-08-30 outage: captions and webhooks fail silently.\033[0m\n' "$CALLBACK_BASE" "$CALLBACK_CODE" >&2
    summary "- ⚠️ Callback into production — ${CALLBACK_CODE} REDIRECT; captions and webhooks are silently dead"
    FAILED=1
    ;;
  *)
    printf '\033[31m✗ callback: %s answered %s\033[0m\n' "$CALLBACK_BASE" "$CALLBACK_CODE" >&2
    summary "- ⚠️ Callback into production — ${CALLBACK_CODE}"
    FAILED=1
    ;;
esac

# ⚠️ Read the certificate ON the box. Both hostnames present Cloudflare's own
# edge certificate to the public internet, so an external SSL check stays
# green straight through an origin expiry.
say "Origin certificates, read on the box"
if ! $SSH "sudo find ${CERT_ROOT} -name '*.crt' -print0 2>/dev/null \
  | xargs -0 -r -I{} sh -c 'echo; echo {}; sudo openssl x509 -noout -subject -enddate -in {}'"; then
  # ⚠️ Not "expected before the first issuance" any more. That wording made
  # this line unable to say anything: it swallowed a failed ssh, a missing
  # volume and a restore that unpacked to the wrong depth alike. On a
  # --restore-caddy run the assertions above have already proved certificates
  # are here, so reaching this branch means something changed under us.
  printf '\033[33m! could not read the certificate store at %s\033[0m\n' "$CERT_ROOT" >&2
  # Not `[ ... ] && FAILED=1`: a false test as the last command of an `if`
  # body is the compound's exit status, and `set -e` takes the script down.
  if [ "$RESTORE_CADDY" -eq 1 ]; then
    summary "- ⚠️ Certificate store — unreadable after a restore that had verified"
    FAILED=1
  fi
fi

# ── 8. Reclaim disk ───────────────────────────────────────────────────────
# ⚠️ Here rather than on a timer, deliberately. The box has no cron and no
# systemd timers and that is a property worth keeping — a scheduled prune is
# something that runs during a class without anyone asking it to. Pruning at
# deploy time happens when a human is already watching.
if [ "$VERIFY_ONLY" -eq 0 ]; then
  say "Reclaiming disk"
  $SSH "docker image prune -af --filter 'until=168h' && docker builder prune -af" >/dev/null
  $SSH "df -h / | tail -1"
fi

if [ "$FAILED" -ne 0 ]; then
  summary ""
  summary "**Deploy FAILED verification.** See the missing values above."
  fail "verification failed"
fi

summary ""
summary "**Box deployed and verified.** LiveKit, preview and preview's database are up. Production is on Fly and was not touched."
ok "done"
