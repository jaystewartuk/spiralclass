#!/bin/sh
# Assert that the app container can actually REACH the LiveKit server it is
# configured to talk to.
#
# ⚠️ THIS IS THE DIRECTION NOBODY LOOKS AT, AND ON THIS BOX IT IS PREVIEW'S.
#
# The app calling LiveKit — RoomService, token minting, egress requests — goes
# over LIVEKIT_URL, which config/env/<env>.runtime.env sets to
# `wss://livekit.spiralclass.com`. That can never be loopback, because the same
# value is what the BROWSER connects to. So the preview app, which sits on a
# docker BRIDGE network on this box, resolves a public name that points at this
# same box and leaves it to come back.
#
# The other two app↔LiveKit directions — livekit-server's webhook and the
# captions agent's APP_INTERNAL_BASE_URL — both point at PRODUCTION, which is
# on Fly. They leave the box for real, and scripts/oracle-deploy.sh probes them
# separately and fails on any 3xx. Whether that works depends on Cloudflare's proxy
# state, on this box's own egress, and — while a hostname is grey-clouded — on
# OCI hairpinning traffic from a bridged container to the instance's own
# reserved address. None of that is true by construction, and when it is false
# livekit-server looks perfectly healthy while no class can be created.
#
# Runs ON the box, and the probe runs INSIDE the container, because the bridge
# network is the whole point — the same check from the host network namespace
# proves nothing. Shipped by scripts/oracle-deploy.sh.
#
# POSIX sh. `node`, not curl: the app image is node:24-slim, which has neither
# curl nor wget.
#
#   ./verify-app-egress.sh <container>
set -eu

container="${1:?usage: verify-app-egress.sh <container>}"

url="$(docker exec "$container" printenv LIVEKIT_URL 2>/dev/null || true)"
if [ -z "$url" ]; then
  echo "FAIL: $container — LIVEKIT_URL is unset; the app has no LiveKit server at all" >&2
  exit 1
fi

# wss:// is not a scheme fetch() takes; the HTTP origin is the same host.
probe="$(printf '%s' "$url" | sed -e 's#^wss://#https://#' -e 's#^ws://#http://#')"

# ⚠️ The node source is a single-quoted argument in THIS file rather than
# something nested inside an ssh command line, and the URL arrives as an env
# var for the same reason: quoting a URL through ssh → docker exec → sh -c →
# node is exactly the layering that silently stops checking anything while
# still exiting 0.
if docker exec -e PROBE_URL="$probe" "$container" node -e '
  const u = process.env.PROBE_URL;
  fetch(u, { redirect: "manual", signal: AbortSignal.timeout(10000) })
    .then((r) => {
      console.log("HTTP " + r.status);
      process.exit(0);
    })
    .catch((e) => {
      console.log("unreachable: " + e.message);
      process.exit(1);
    });
'; then
  echo "OK: $container reached $probe"
else
  echo "FAIL: $container cannot reach $probe — no class can be created" >&2
  exit 1
fi
