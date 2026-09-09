#!/usr/bin/env bash
# Move locally-built images onto the box over the tailnet.
#
# ⚠️ THIS IS A STOPGAP FOR THE CUTOVER NIGHT, AND IT SHOULD NOT SURVIVE THE
# REPOSITORY GOING PUBLIC.
#
# The end state is decided, not merely preferred: **every deploy runs through
# GitHub Actions** (operator, 2026-09-04). For this box that means building on
# a GitHub-hosted `ubuntu-24.04-arm` runner — free on a public repository and
# genuinely native aarch64, which D-157's addendum works through — pushing to
# GHCR, and letting the box pull. It needs the repository to be public, because
# a 3 GB private package would blow the free Packages quota and because
# publishing the image before the repository is public discloses the app early.
# Both conditions land together on the flip, so this script's life is measured
# in days.
#
# Until then this exists so the BOX never builds. A build on this machine
# occupies both OCPUs that also carry live classes — the cost D-108 named —
# and the web app build alone peaks at 5.26 GB against 12 GB of RAM shared
# with livekit-server, egress, Redis, Caddy and the captions agent.
#
# ⚠️ The PREVIEW image, not the production one — the production web app is on
# Fly and its image is never pulled onto this box (D-150's second addendum).
#
#   ./scripts/oracle-push-images.sh spiralclass-web-preview:abc1234 agendaprofe-captions-agent:abc1234
set -euo pipefail

BOX="${ORACLE_BOX_HOST:-spiralclass-box}"
REMOTE_USER="${ORACLE_BOX_USER:-ubuntu}"

[ $# -gt 0 ] || { echo "usage: oracle-push-images.sh <image> [<image> ...]" >&2; exit 2; }

for image in "$@"; do
  docker image inspect "$image" >/dev/null 2>&1 || {
    echo "no such local image: $image" >&2; exit 1; }

  arch="$(docker image inspect "$image" --format '{{.Architecture}}')"
  # ⚠️ The box is aarch64. An amd64 image will load without complaint and then
  # fail at run time with an exec-format error that reads like a broken
  # entrypoint, so check here where the message can still be useful.
  [ "$arch" = "arm64" ] || { echo "$image is $arch, not arm64 — the box will not run it" >&2; exit 1; }

  size="$(docker image inspect "$image" --format '{{.Size}}')"
  echo "› ${image} (${arch}, $((size / 1024 / 1024)) MB over the wire) → ${BOX}"

  # Streamed, not written to a tar first: the laptop gains nothing from
  # holding a copy.
  #
  # ⚠️ Not gzipped, deliberately. `docker save` emits a tar of layers that are
  # ALREADY compressed, so gzip -1 took 440 MB to 438 MB — half a percent, for
  # CPU on both ends. Measured, not assumed; an earlier version of this script
  # compressed on the theory that the link was the slow part.
  #
  # Note also that `docker image inspect .Size` (what is printed above, and
  # what crosses the wire) is NOT the `docker images` SIZE column, which is
  # the uncompressed on-disk footprint and roughly 5x larger. Compare like
  # with like when judging whether an image got smaller.
  docker save "$image" \
    | ssh -o ConnectTimeout=15 "${REMOTE_USER}@${BOX}" 'docker load'
done

echo "› images on the box:"
ssh -o ConnectTimeout=15 "${REMOTE_USER}@${BOX}" \
  "docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}'"
