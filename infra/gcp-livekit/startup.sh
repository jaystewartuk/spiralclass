#!/bin/bash
# The whole LiveKit box on Compute Engine, as its boot script (D-187).
#
# Runs as root on EVERY boot (instance metadata `startup-script`). The install
# half is guarded, so a reboot only re-renders config and restarts the stack —
# which is also how a change here reaches the box: push the new script to the
# instance's metadata and reset it (README.md, "Changing the box").
#
# ⚠️ NO EGRESS, deliberately. The box is an Always Free e2-micro (2 shared
# vCPU at a quarter of a core sustained, 1 GB). Measured on 2026-09-24: a
# class-shaped call uses ~0.12 core, but adding the app's three audio
# recordings made egress kill two of them within a minute for CPU. Class
# recording and lesson-insights transcription are off in production for that
# reason (D-187). Do not add egress back here without a bigger machine.
set -euo pipefail

MD=http://metadata.google.internal/computeMetadata/v1
md() { curl -sf -H 'Metadata-Flavor: Google' "$MD/$1"; }

# Everything box-specific comes from instance metadata, so nothing in this file
# names a project, an address or a key (D-158).
LK_KEY=$(md instance/attributes/lk-key)
LK_SECRET=$(md instance/attributes/lk-secret)
LK_HOST=$(md instance/attributes/lk-host)
LK_WEBHOOK_URL=$(md instance/attributes/lk-webhook-url)
IP=$(md instance/network-interfaces/0/access-configs/0/external-ip)
DIR=/opt/livekit

if [ ! -f "$DIR/.installed" ]; then
  # 1 GB of RAM: swap on the boot disk, used only under pressure.
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  swapon -a || true
  sysctl -w vm.swappiness=10
  # A mirror mid-sync fails `apt-get update` outright (it did, on the first
  # boot this script ever had); retry rather than leave a half-built box.
  for attempt in 1 2 3 4 5 6; do
    apt-get update -q && break
    echo "apt-get update failed (attempt $attempt), retrying in 30s"
    sleep 30
  done
  DEBIAN_FRONTEND=noninteractive apt-get install -yq docker.io docker-compose-v2 sysstat
  mkdir -p "$DIR"
  touch "$DIR/.installed"
fi

# The key pair lives in this file; the box has no other users and no service
# account, but it still is not world-readable. livekit-server runs as root in
# its image, so 600 is readable to it.
umask 077
cat > "$DIR/livekit.yaml" <<EOF
port: 7880
rtc:
  tcp_port: 7881
  # One UDP port for all media (ICE mux) instead of a range: one firewall hole.
  udp_port: 7882
  use_external_ip: false
turn:
  enabled: true
  udp_port: 3478
  relay_range_start: 50000
  relay_range_end: 50199
keys:
  ${LK_KEY}: ${LK_SECRET}
webhook:
  api_key: ${LK_KEY}
  urls:
    - ${LK_WEBHOOK_URL}
logging:
  level: info
EOF

# Signalling only. The hostname is proxied by Cloudflare (D-134), so the
# certificate can only come from the http-01 challenge on :80; media never
# resolves this name — ICE candidates carry the box's own address (--node-ip).
cat > "$DIR/Caddyfile" <<EOF
${LK_HOST} {
  reverse_proxy 127.0.0.1:7880
}
EOF
chmod 644 "$DIR/Caddyfile"

# The same image digests the Oracle box ran (infra/oracle-box/stack), which are
# multi-arch indexes carrying amd64. Upgrade deliberately, one at a time.
cat > "$DIR/docker-compose.yml" <<EOF
services:
  caddy:
    image: caddy@sha256:844f60b64e4724a5aa8245e019dace0d3f199f7433ce6c57676cb30a920dbad9
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
  livekit:
    image: livekit/livekit-server@sha256:189f7c81b704a36642bc5c7e2d3e1ae83744627c11978a23a251bf19fbec64e0
    restart: unless-stopped
    network_mode: host
    command: --config /etc/livekit.yaml --node-ip ${IP}
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
volumes:
  caddy_data:
EOF

cd "$DIR"
docker compose up -d --remove-orphans

# Health samples every minute on the serial console, readable from outside with
# `gcloud compute instances get-serial-port-output` — the box has no SSH port.
if ! pgrep -f lk-sampler >/dev/null; then
  nohup bash -c 'exec -a lk-sampler bash -c "
    while true; do
      {
        echo \"### SAMPLE \$(date -u +%FT%TZ)\"
        free -m | sed -n 2,3p
        mpstat 30 1 | tail -1
        docker stats --no-stream --format \"{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}\"
      } > /dev/ttyS0 2>&1
      sleep 30
    done"' >/dev/null 2>&1 &
fi
echo "### READY host=${LK_HOST}" > /dev/ttyS0
