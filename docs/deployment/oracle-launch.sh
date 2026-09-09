#!/usr/bin/env bash
# Launch the Oracle A1 (Always Free, arm64) CI-runner instance from the CLI,
# retrying past the common "Out of host capacity" error instead of clicking
# Create repeatedly. Best run in OCI Cloud Shell (the >_ icon in the console —
# pre-authenticated, `oci` preinstalled). The runner runbook this pointed at was
# deleted by D-164; the box is LiveKit-only now.
#
# You must set TWO things; everything else is auto-discovered:
#   SUBNET_OCID     — a PUBLIC subnet's OCID (create a VCN+public subnet once in
#                     the console "Create VCN" wizard, then copy the subnet OCID;
#                     or list them:  oci network subnet list -c "$OCI_TENANCY" \
#                       --query 'data[?"prohibit-public-ip-on-vnic"==`false`].[id,"display-name"]' --output table )
#   SSH_PUBKEY_FILE — path to your SSH *public* key (default ~/.ssh/id_rsa.pub).
#                     In Cloud Shell (FIPS mode → RSA, not ed25519):
#                       ssh-keygen -t rsa -b 4096 -f ~/.ssh/oracle_a1 -N ''
#
# Optional:
#   USER_DATA_FILE  — cloud-init to run on first boot (this repo ships one:
#                     docs/deployment/oracle-runner-cloud-init.sh). Leave unset to skip.
#   OCPUS / MEM_GB  — default 2 / 12 (the Always-Free ceiling on a free-tier
#                     account post-June-2026). Drop to 1 / 6 if 2/12 isn't free.
set -euo pipefail

SUBNET_OCID="${SUBNET_OCID:?set SUBNET_OCID to a PUBLIC subnet OCID (see header)}"
SSH_PUBKEY_FILE="${SSH_PUBKEY_FILE:-$HOME/.ssh/id_rsa.pub}"
COMPARTMENT="${COMPARTMENT:-${OCI_TENANCY:?set COMPARTMENT or run in Cloud Shell where OCI_TENANCY is set}}"
OCPUS="${OCPUS:-2}"
MEM_GB="${MEM_GB:-12}"
USER_DATA_FILE="${USER_DATA_FILE:-}"

[ -f "$SSH_PUBKEY_FILE" ] || { echo "No SSH public key at $SSH_PUBKEY_FILE — run: ssh-keygen -t ed25519"; exit 1; }

echo "Discovering availability domain + image…"
AD="$(oci iam availability-domain list -c "$COMPARTMENT" --query 'data[0].name' --raw-output)"

# All images returned for the A1.Flex shape are arm64; pick Ubuntu 24.04 Minimal.
IMAGE_OCID="$(oci compute image list -c "$COMPARTMENT" \
  --shape VM.Standard.A1.Flex \
  --operating-system 'Canonical Ubuntu' \
  --query 'data[?contains("display-name", `"24.04"`) && contains("display-name", `"aarch64"`)] | [0].id' \
  --raw-output)"
[ -n "$IMAGE_OCID" ] && [ "$IMAGE_OCID" != "null" ] || {
  echo "Could not auto-find the Ubuntu 24.04 aarch64 image. List them with:"
  echo "  oci compute image list -c \"$COMPARTMENT\" --shape VM.Standard.A1.Flex --operating-system 'Canonical Ubuntu' --query 'data[].[\"display-name\",id]' --output table"
  exit 1
}

echo "AD=$AD"
echo "IMAGE=$IMAGE_OCID"
echo "SUBNET=$SUBNET_OCID   SHAPE=VM.Standard.A1.Flex ${OCPUS}ocpu/${MEM_GB}GB"
[ -n "$USER_DATA_FILE" ] && echo "cloud-init=$USER_DATA_FILE"

ARGS=(
  --availability-domain "$AD"
  --compartment-id "$COMPARTMENT"
  --shape VM.Standard.A1.Flex
  --shape-config "{\"ocpus\": $OCPUS, \"memoryInGBs\": $MEM_GB}"
  --image-id "$IMAGE_OCID"
  --subnet-id "$SUBNET_OCID"
  --assign-public-ip true
  --ssh-authorized-keys-file "$SSH_PUBKEY_FILE"
  --display-name "oracle-a1-runner"
  --wait-for-state RUNNING
)
[ -n "$USER_DATA_FILE" ] && ARGS+=(--user-data-file "$USER_DATA_FILE")

echo "Launching (will retry every 60s past 'Out of host capacity')…"
until oci compute instance launch "${ARGS[@]}"; do
  echo "$(date '+%H:%M:%S')  capacity/other error — retrying in 60s (Ctrl-C to stop)…"
  sleep 60
done

echo
echo "Instance is RUNNING. Get its public IP:"
echo "  INST=\$(oci compute instance list -c \"$COMPARTMENT\" --display-name oracle-a1-runner --lifecycle-state RUNNING --query 'data[0].id' --raw-output)"
echo "  oci compute instance list-vnics --instance-id \"\$INST\" --query 'data[0].\"public-ip\"' --raw-output"
echo "Then:  ssh -i <your-private-key> ubuntu@<public-ip>"
