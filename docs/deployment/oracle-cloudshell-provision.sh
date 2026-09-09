#!/usr/bin/env bash
# One-shot provisioner for the Oracle A1 (Always Free, arm64) box.
#
# STALE (2026-07-21): the embedded toolchain heredoc below still
# installs the retired CI-runner stack (Node/build-essential/postgresql-client/
# AWS CLI) — it was never updated when the box's role moved to LiveKit-only.
# The box already exists and this script's normal job (create-from-scratch)
# shouldn't be needed again barring an Oracle reclamation; if it ever is,
# NOTE (2026-08-29, D-139): `infra/oracle-runner` is deleted — it was never
# applied. Rebuild by hand from docs/deployment/ORACLE_BOX_REBUILD.md.
# The historical alternative was `infra/oracle-runner` (Tofu, pointed at the correct
# `docs/deployment/oracle-livekit-cloud-init.sh`) instead of this script, or update
# the heredoc below to match that file first.
#
# PASTE THIS INTO OCI CLOUD SHELL (the >_ icon, top-right of the Oracle console —
# it's pre-authenticated to your tenancy, `oci` is preinstalled). Idempotent:
# safe to re-run; reuses the VCN/subnet/keys it already made. See ORACLE_RUNNER.md.
#
# It creates networking with a PUBLIC IP (the thing the console wizard defaulted
# to "No"), sizes the shape 2 OCPU / 12 GB, wires the first-boot toolchain, and
# retries past "Out of host capacity". Nothing to edit — just paste and run.
set -euo pipefail

C="${OCI_TENANCY:?run this in OCI Cloud Shell (OCI_TENANCY must be set)}"
AD="$(oci iam availability-domain list -c "$C" --query 'data[0].name' --raw-output)"
echo "Compartment (root) + AD: $AD"

# 1) VCN (reuse if present)
VCN=$(oci network vcn list -c "$C" --display-name ap-runner-vcn --query 'data[0].id' --raw-output 2>/dev/null || true)
if [ -z "${VCN:-}" ] || [ "$VCN" = "null" ]; then
  VCN=$(oci network vcn create -c "$C" --display-name ap-runner-vcn \
    --cidr-blocks '["10.0.0.0/16"]' --wait-for-state AVAILABLE --query 'data.id' --raw-output)
  echo "Created VCN $VCN"
fi

# 2) Internet gateway (reuse if present)
IGW=$(oci network internet-gateway list -c "$C" --vcn-id "$VCN" --query 'data[0].id' --raw-output 2>/dev/null || true)
if [ -z "${IGW:-}" ] || [ "$IGW" = "null" ]; then
  IGW=$(oci network internet-gateway create -c "$C" --vcn-id "$VCN" --is-enabled true \
    --display-name ap-igw --wait-for-state AVAILABLE --query 'data.id' --raw-output)
  echo "Created internet gateway $IGW"
fi

# 3) Default route table → 0.0.0.0/0 via the IGW
RT=$(oci network vcn get --vcn-id "$VCN" --query 'data."default-route-table-id"' --raw-output)
oci network route-table update --rt-id "$RT" --force \
  --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" >/dev/null
echo "Route table points default route at the internet gateway"

# 4) PUBLIC subnet (reuse if present). --prohibit-public-ip-on-vnic false = public.
SUBNET=$(oci network subnet list -c "$C" --vcn-id "$VCN" --display-name ap-runner-subnet --query 'data[0].id' --raw-output 2>/dev/null || true)
if [ -z "${SUBNET:-}" ] || [ "$SUBNET" = "null" ]; then
  SUBNET=$(oci network subnet create -c "$C" --vcn-id "$VCN" --display-name ap-runner-subnet \
    --cidr-block 10.0.1.0/24 --prohibit-public-ip-on-vnic false --route-table-id "$RT" \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output)
  echo "Created public subnet $SUBNET"
fi
# The VCN's default security list already allows inbound SSH (tcp/22).

# 5) SSH key (create if missing — private key stays in Cloud Shell ~/.ssh)
if [ ! -f ~/.ssh/oracle_a1.pub ]; then
  # RSA, not ed25519: OCI Cloud Shell runs in FIPS mode, which rejects ed25519.
  ssh-keygen -t rsa -b 4096 -f ~/.ssh/oracle_a1 -N '' -q
  echo "Generated ~/.ssh/oracle_a1 (private) + .pub"
fi

# 6) First-boot toolchain (kept in sync with docs/deployment/oracle-runner-cloud-init.sh)
cat > /tmp/oracle-ci.sh <<'CLOUDINIT'
#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=300"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
$APT update
$APT install -y git build-essential curl unzip ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
$APT install -y nodejs
corepack enable
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
$APT update
$APT install -y gh
curl -fsSL https://tailscale.com/install.sh | sh
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
$APT update
$APT install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker ubuntu
systemctl enable --now docker
$APT install -y postgresql-client
if ! command -v aws &>/dev/null; then
  TMP_AWS_DIR="$(mktemp -d)"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "$TMP_AWS_DIR/awscliv2.zip"
  unzip -q -o "$TMP_AWS_DIR/awscliv2.zip" -d "$TMP_AWS_DIR"
  "$TMP_AWS_DIR/aws/install"
  rm -rf "$TMP_AWS_DIR"
fi
touch /var/log/oracle-runner-setup.done
CLOUDINIT

# 7) Newest Ubuntu 24.04 aarch64 image for the A1 shape
IMG=$(oci compute image list -c "$C" --shape VM.Standard.A1.Flex \
  --operating-system 'Canonical Ubuntu' \
  --query 'data[?contains("display-name", `"24.04"`) && contains("display-name", `"aarch64"`)] | [0].id' \
  --raw-output)
echo "Image: $IMG"

# 8) Launch, retrying past "Out of host capacity"
echo "Launching A1 2 OCPU / 12 GB with public IP (retry every 60s on capacity)…"
until oci compute instance launch \
  --availability-domain "$AD" -c "$C" \
  --shape VM.Standard.A1.Flex --shape-config '{"ocpus":2,"memoryInGBs":12}' \
  --image-id "$IMG" --subnet-id "$SUBNET" --assign-public-ip true \
  --ssh-authorized-keys-file ~/.ssh/oracle_a1.pub \
  --user-data-file /tmp/oracle-ci.sh \
  --display-name oracle-a1-runner --wait-for-state RUNNING >/dev/null; do
  echo "$(date '+%H:%M:%S')  capacity/other error — retrying in 60s (Ctrl-C to stop)…"
  sleep 60
done

# 9) Public IP + how to connect
INST=$(oci compute instance list -c "$C" --display-name oracle-a1-runner \
  --lifecycle-state RUNNING --query 'data[0].id' --raw-output)
IP=$(oci compute instance list-vnics --instance-id "$INST" --query 'data[0]."public-ip"' --raw-output)
echo
echo "==================================================================="
echo " RUNNING.  Public IP: $IP"
echo " Connect:  ssh -i ~/.ssh/oracle_a1 ubuntu@$IP"
echo " (the private key ~/.ssh/oracle_a1 is here in Cloud Shell — download it"
echo "  from the Cloud Shell menu, or copy it to wherever you'll SSH from.)"
echo " Toolchain done when:  ssh … 'ls -l /var/log/oracle-runner-setup.done'"
echo "==================================================================="
