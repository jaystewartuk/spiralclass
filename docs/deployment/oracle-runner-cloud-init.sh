#!/bin/bash
# Oracle A1 (Always Free, arm64) first-boot toolchain — HISTORICAL, CI-runner
# role retired.
#
# 2026-07-21: this box is CI-runner-retired — it's dedicated to
# self-hosted LiveKit (docs/deployment/ORACLE_LIVEKIT_PRODUCTION.md) now, and
# `infra/oracle-runner` (deleted 2026-08-29, D-139) had its `cloud_init_file`
# default moved to
# `oracle-livekit-cloud-init.sh` (LiveKit-only: Docker/Tailscale/git/gh, NOT
# the Node/build-essential/postgresql-client/AWS-CLI toolchain below). Do NOT
# register a GitHub Actions runner on this box (the old step below, kept
# struck through for history only) and do NOT run THIS script to re-provision
# it — use `oracle-livekit-cloud-init.sh` instead. Kept by D-139 as the record
# of what that toolchain was, in case the CI-runner role is ever deliberately
# revived; its runbook was deleted in D-164 because the role is not coming back
# (CI is `ubuntu-latest`, and nothing else).
#
# Paste this into the OCI "Initialization script → cloud-init" box when creating
# the instance, OR run it by hand on a fresh box. It is idempotent, so it also
# serves as the RE-PROVISION script if the free-tier VM is ever idle-reclaimed
# (Oracle reserves the right to reclaim idle Always Free compute.)
#
# It installs ONLY the non-interactive parts. After it finishes, run by hand:
#   sudo tailscale up                 # browser/auth-key login onto your tailnet
#   gh auth login                     # device-flow login for the private repo
#   gh repo clone jaystewartuk/spiralclass
#   # ~~then register the GitHub Actions runner (Settings > Actions > Runners):~~
#   # ~~./config.sh --url https://github.com/jaystewartuk/spiralclass \~~
#   # ~~  --token <ONE_TIME_TOKEN> --labels oracle-arm --name oracle-a1~~
#   # ~~sudo ./svc.sh install && sudo ./svc.sh start~~
#   # Don't do this any more — the CI-runner role is retired.
#
# Deliberately NOT installed: Android SDK / emulator / eas-cli — this box never
# builds APKs (x86-only); that stayed on EAS even before the CI-runner role
# was retired.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=300"

# 4 GB swap — insurance against OOM during tsc/vitest (matters most if the box
# fell back to the 6 GB A1 size instead of 12 GB).
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

$APT update
$APT install -y git build-essential curl unzip ca-certificates gnupg

# Node 22 + pnpm (corepack)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
$APT install -y nodejs
corepack enable

# GitHub CLI (for private-repo clone auth via `gh auth login`)
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
$APT update
$APT install -y gh

# Tailscale (install only; `tailscale up` is interactive, done after boot)
curl -fsSL https://tailscale.com/install.sh | sh

# Docker (needed by integration.yml's postgres:16 service container — GitHub
# Actions service containers require a Docker daemon on the runner host).
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
$APT update
$APT install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker ubuntu
systemctl enable --now docker

# postgresql-client (pg_isready/psql) — integration.yml polls the postgres:16
# service container from the RUNNER HOST, not inside a container, so the
# client binaries need to be installed here even though the server is Docker.
$APT install -y postgresql-client

# AWS CLI v2 (arm64) — backup-prod-db.yml uploads pg_dump output to R2 via
# `aws s3 cp` (R2 is S3-compatible). No `apt` package; use the official
# installer, matching the manual install done on the live box 2026-07-13.
if ! command -v aws &>/dev/null; then
  TMP_AWS_DIR="$(mktemp -d)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "$TMP_AWS_DIR/awscliv2.zip"
  unzip -q -o "$TMP_AWS_DIR/awscliv2.zip" -d "$TMP_AWS_DIR"
  "$TMP_AWS_DIR/aws/install"
  rm -rf "$TMP_AWS_DIR"
fi

touch /var/log/oracle-runner-setup.done
echo "oracle-runner-cloud-init: toolchain ready"
