#!/bin/bash
# Oracle A1 (Always Free, arm64) first-boot toolchain — LiveKit-only.
#
# 2026-08-29 (D-139): infra/oracle-runner is DELETED — never applied. THIS
# script is the first-boot provisioning path again; see
# docs/deployment/ORACLE_BOX_REBUILD.md. Historical note below:
# SUPERSEDED as infra/oracle-runner's default: that module rendered
# infra/oracle-runner/cloud-init.yaml.tftpl (a #cloud-config, not this plain
# bash script) via `tofu apply` — non-interactive Tailscale join, no
# `gh auth login`/repo-clone step, real LiveKit key/secret interpolated
# directly instead of a PLACEHOLDER hand-edit. See
# docs/deployment/ORACLE_LIVEKIT_PRODUCTION.md's "Manual step" sections for
# what changed. This script is kept only for the manual/Cloud-Shell path
# (docs/deployment/oracle-cloudshell-provision.sh) — bootstrapping before
# Tofu/OCI credentials exist, or a from-scratch box without Tofu at all.
#
# 2026-07-21: this box's CI-runner role is retired. Its ONLY job is
# hosting the self-hosted LiveKit stack (docs/deployment/ORACLE_LIVEKIT_PRODUCTION.md,
# docker-compose now at infra/oracle-runner/services/). This script installs
# ONLY what that needs — it deliberately does NOT install the JS/CI toolchain
# `oracle-runner-cloud-init.sh` used to (Node, build-essential,
# postgresql-client, AWS CLI): none of that is needed to run four Docker
# containers, and every KB saved here is a KB this Always-Free box's tight
# quota doesn't have to spend on dead weight. If this box's CI-runner role
# is ever needed again, that's `oracle-runner-cloud-init.sh` — don't add CI
# toolchain back into this one.
#
# Paste into the OCI "Initialization script → cloud-init" box when creating
# the instance by hand, OR run it by hand on a fresh box — idempotent, so it
# doubles as the RE-PROVISION script if the free-tier VM is ever
# idle-reclaimed and you're not going through Tofu for some reason.
#
# After it finishes, run by hand:
#   sudo tailscale up --ssh            # onto your tailnet — SSH stays
#                                       # Tailscale-only, no open :22
#   gh auth login                      # device-flow login, only needed if
#                                       # you want `gh repo clone` for pulling
#                                       # updated compose/Caddy/LiveKit config
#                                       # from this repo instead of hand-editing
#   mkdir -p ~/oracle-livekit-production
#   # copy infra/oracle-runner/services/{docker-compose.livekit.yml,Caddyfile,
#   # livekit.yaml.tftpl,egress.yaml.tftpl} onto the box (scp or `gh repo
#   # clone` + copy) — the .tftpl ones need their ${livekit_api_key}/
#   # ${livekit_api_secret} placeholders hand-filled with real values first,
#   # then: cd ~/oracle-livekit-production && docker compose up -d
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=300"

# Swap — insurance against OOM. Kept even though this is a disk cost, not a
# CI-toolchain leftover: Egress's headless-Chrome room-composite renders are a
# real, occasional memory spike, and OOM-killing a live class recording is a
# far worse outcome than 4 GB of a 50-100 GB boot volume. Revisit only if
# disk is ever genuinely tight (see docs/deployment/ORACLE_LIVEKIT_PRODUCTION.md).
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

$APT update
$APT install -y git curl ca-certificates gnupg

# GitHub CLI — kept for the redeploy convenience of `gh repo clone`/`git pull`
# onto the box (not strictly required — you could scp the compose/config
# files instead), but it's a few MB and genuinely useful when this repo's
# oracle-livekit-production/ files change.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
$APT update
$APT install -y gh

# Tailscale (install only; `tailscale up` is interactive, done after boot)
curl -fsSL https://tailscale.com/install.sh | sh

# Docker — REQUIRED. The entire LiveKit stack (caddy/redis/livekit-server/
# egress) is docker-compose, network_mode: host — see
# infra/oracle-runner/services/docker-compose.livekit.yml.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
$APT update
$APT install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker ubuntu
systemctl enable --now docker

# Deliberately NOT installed (all were CI-runner-only, see
# oracle-runner-cloud-init.sh's history): Node/pnpm, build-essential,
# postgresql-client, AWS CLI, unzip. Also not installed, unchanged from
# before: Android SDK / emulator / eas-cli — never needed on this box.
$APT autoremove -y
$APT clean

touch /var/log/oracle-livekit-setup.done
echo "oracle-livekit-cloud-init: toolchain ready (LiveKit-only)"
