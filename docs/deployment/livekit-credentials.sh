#!/usr/bin/env bash
# Export LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET into the CALLING
# shell. SOURCE this, never exec it — livekit-activity.sh and
# livekit-activity-ink.sh, beside it, are the two callers.
#
# ⚠️ PRODUCTION'S PAIR, BECAUSE IT IS THE ONLY ONE. Preview holds no LiveKit key
# pair (D-94's 2026-09-16 addendum), so everything comes from production:
#
#   * LIVEKIT_URL from config/env/production.runtime.env (D-85).
#   * The key and the secret from Infisical's production environment, at the
#     two paths scripts/oracle-render-livekit.sh renders the box from — the key
#     at /config, the secret at /. The key is not read from the env file: it is
#     `__LOCAL__` there, and the earlier version of these probes, which read it
#     from preview's file, would have sent that placeholder as the key.
#
# Never point this back at preview's scope to make a probe work. If it fails,
# the fix is production's values, not a copy of them in preview.
#
# Sets no shell options, for with-secret.sh's reason: a sourced file that does
# changes its caller's shell. Both callers set their own.

_livekit_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# shellcheck source=../../infra/infisical/with-secret.sh
source "$_livekit_repo_root/infra/infisical/with-secret.sh"

LIVEKIT_URL="$(grep -m1 '^LIVEKIT_URL=' "$_livekit_repo_root/config/env/production.runtime.env" | cut -d= -f2-)"
LIVEKIT_API_KEY="$(infisical_secrets --path=/config --plain production LIVEKIT_API_KEY)" || return 1
unset _livekit_repo_root

for _livekit_var in LIVEKIT_URL LIVEKIT_API_KEY; do
  case "${!_livekit_var}" in
    "" | __LOCAL__)
      echo "livekit-credentials: $_livekit_var is empty or __LOCAL__ — aborting" >&2
      unset _livekit_var
      return 1
      ;;
  esac
done
unset _livekit_var

infisical_export_secrets --env production LIVEKIT_API_SECRET || return 1
export LIVEKIT_URL LIVEKIT_API_KEY
