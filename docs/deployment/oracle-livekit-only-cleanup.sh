#!/bin/bash
# One-time cleanup for the Oracle A1 box: strips everything the retired
# CI-runner role installed, so the
# box's only resident workload is the self-hosted LiveKit docker-compose
# stack (docs/deployment/ORACLE_LIVEKIT_PRODUCTION.md).
#
# Run this ONCE, over Tailscale SSH, on the live box:
#   ssh ubuntu@oracle-a1-runner   # (or whatever your tailnet name is)
#   sudo bash oracle-livekit-only-cleanup.sh
#
# It is NOT what re-provisions a fresh box — that's
# `oracle-livekit-cloud-init.sh` now (this script only tears down cruft that
# a box built BEFORE that split still has installed). Safe to re-run
# (idempotent): every step no-ops if its target is already gone.
#
# Does NOT touch: Docker itself, the LiveKit containers/images, or any of the
# four named volumes in oracle-livekit-production/docker-compose.yml
# (caddy_data, caddy_config, redis_data, egress_tmp) — those hold real state
# (TLS certs, Redis persistence). `docker system prune` below is deliberately
# NOT `-a` and NOT `--volumes` for exactly that reason.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo." >&2; exit 1; fi
APT="apt-get -o DPkg::Lock::Timeout=300"
RUNNER_USER="${SUDO_USER:-ubuntu}"
RUNNER_HOME="$(getent passwd "$RUNNER_USER" | cut -d: -f6)"

echo "=== Before ==="
df -h / || true
free -h || true

# --- 1. Stop + remove both GitHub Actions runner installs -------------------
# Both were already deregistered from GitHub's side (
# `gh api -X DELETE repos/jaystewartuk/spiralclass/actions/runners/{21,22}`)
# — this just removes the now-orphaned local processes/files. `config.sh
# remove` needs a token from a still-registered runner, so it will likely
# fail here (expected, harmless) since the registration is already gone
# server-side; the directory removal after it is what actually matters.
for dir in "$RUNNER_HOME/actions-runner" "$RUNNER_HOME/actions-runner-2"; do
  if [ -d "$dir" ]; then
    echo "--- cleaning up $dir ---"
    # This whole script already runs as root (checked above) — svc.sh
    # requires that directly; running it via `sudo -u $RUNNER_USER` DROPS
    # back to non-root and makes it fail with "Must run as sudo".
    (cd "$dir" && ./svc.sh stop) || true
    (cd "$dir" && ./svc.sh uninstall) || true
    # `config.sh remove` needs a valid removal token from a still-registered
    # runner — ours are already deregistered from GitHub's side, so this is
    # expected to fail every time now. Not worth attempting: the directory
    # removal below is what actually matters, and svc.sh uninstall above
    # already dropped the systemd unit.
    rm -rf "$dir"
  fi
done
# Any leftover systemd unit files/state, belt-and-suspenders past svc.sh
# uninstall. `list-unit-files` on a glob that matches nothing exits 1 on some
# systemd versions — under `set -e`/pipefail that would abort the whole
# script right here, so the `|| true` covers the ENTIRE pipeline, not just
# the loop body.
(systemctl list-unit-files 'actions.runner.*' --no-legend 2>/dev/null | awk '{print $1}' | while read -r unit; do
  systemctl stop "$unit" 2>/dev/null || true
  systemctl disable "$unit" 2>/dev/null || true
done) || true
systemctl daemon-reload || true

# --- 2. Per-runner pnpm content-addressable stores --------------------------
# ORACLE_RUNNER.md's "give each runner its own pnpm store" note put these at
# a fixed path per runner (distinct PNPM_HOME to avoid the two runners
# corrupting a shared store) — these accumulate every package version ever
# installed across every CI run and were a real, unbounded disk sink.
rm -rf "$RUNNER_HOME/.pnpm-store-runner1" "$RUNNER_HOME/.pnpm-store-runner2"
rm -rf "$RUNNER_HOME/.local/share/pnpm" "$RUNNER_HOME/.cache/pnpm" "$RUNNER_HOME/.npm" "$RUNNER_HOME/.cache/Cypress" "$RUNNER_HOME/.cache/ms-playwright"

# --- 3. CI-only toolchain packages (all installed by the retired
#        oracle-runner-cloud-init.sh, never needed by LiveKit) ---------------
$APT purge -y nodejs postgresql-client build-essential gcc g++ make 2>/dev/null || true
rm -f /etc/apt/sources.list.d/nodesource.list
rm -f /usr/share/keyrings/nodesource.gpg /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true

# AWS CLI v2 — not an apt package, installed via the official installer into
# /usr/local/aws-cli with symlinks in /usr/local/bin (see the retired
# oracle-runner-cloud-init.sh).
rm -rf /usr/local/aws-cli /usr/local/bin/aws /usr/local/bin/aws_completer

# --- 4. General apt/docker hygiene ------------------------------------------
$APT autoremove --purge -y
$APT clean
docker system prune -f   # dangling images/stopped containers/unused networks
                          # only — NEVER add -a or --volumes here, see header.

echo "=== After ==="
df -h / || true
free -h || true
echo "oracle-livekit-only-cleanup: done"
