# The LiveKit box on Compute Engine

Production's video server since [D-187](../../docs/decisions/D-187.md):
`livekit-server` and Caddy on one **Always Free `e2-micro`** in `us-east1`,
reached at `wss://livekit.spiralclass.com`. Classes run on it; **class
recording and lesson-insights transcription do not**, because egress does not
fit on the machine (measured — D-187).

> [!NOTE]
> **Hand-built, not OpenTofu.** [D-150](../../docs/decisions/D-150.md) forbids
> committing a module for a self-hosted box before it has been applied and a
> state file exists, and [D-164](../../docs/decisions/D-164.md) holds a
> runbook to the machine it describes. So this directory holds the box's
> **boot script** — [`startup.sh`](./startup.sh), which is the whole
> configuration — and the commands below, which are the ones that built it.
> If the box and this file ever disagree, fix whichever is wrong in the same
> session, or delete the file.

## What it is

| Part     | Value                                                                                                                                                                |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project  | its own GCP project, not production's — the project id is in Infisical, not here ([D-158](../../docs/decisions/D-158.md))                                            |
| Machine  | `e2-micro`, `us-east1-b`, 30 GB `pd-standard` boot disk, Ubuntu 24.04 minimal. All inside the Always Free allowance                                                  |
| Address  | one **static, Standard-tier** external IPv4 ($0.005/hour, the only line on the bill). Standard tier because its outbound allowance is far larger than Premium's 1 GB |
| Identity | **no service account and no scopes** — the VM holds no Google credential at all                                                                                      |
| Network  | its own VPC; ingress `tcp:80,443,7881` and `udp:3478,7882,50000-50199`. **No port 22**: the box is read through its serial console                                   |
| Config   | instance metadata: `startup-script`, `lk-key`, `lk-secret`, `lk-host`, `lk-webhook-url`                                                                              |

Why a separate project: enabling Compute Engine in a project creates a
`default` network with SSH and RDP open to the internet, and a default service
account holding **Editor** on the whole project. Neither belongs next to
production's Cloud Run service and its secrets.

## What it can carry

Measured 2026-09-24 with `lk load-test` from outside Google:

- **One class at a time, comfortably.** Two publishers with 720p simulcast and
  audio, one subscriber: 0 packet loss, 2.2 Mbps delivered, `livekit-server`
  ~10–12% of one core, the whole VM ~0.12 core — under the quarter-core an
  `e2-micro` sustains without burst credits — and ~375 MB of RAM.
- **Two at once** would sit at that sustained ceiling. That is the graduation
  trigger: a second teacher with overlapping classes means an `e2-medium`
  (~$25/month), which is also the size that fits egress.
- **Not egress.** With the app's three audio recordings added, egress killed two
  of them for CPU inside a minute and the call degraded. D-187 has the numbers.

## Building it

Every value in angle brackets comes from Infisical or from the command before
it. Run from anywhere with `gcloud` authenticated as the operator.

```bash
P=<project id>

gcloud projects create "$P" --name="SpiralClass media"
gcloud billing projects link "$P" --billing-account=<billing account>
gcloud services enable compute.googleapis.com --project="$P"

# The default network enabling Compute creates: delete it and its open rules.
gcloud compute firewall-rules delete default-allow-icmp default-allow-internal \
  default-allow-rdp default-allow-ssh --project="$P" --quiet
gcloud compute networks delete default --project="$P" --quiet

gcloud compute networks create livekit --project="$P" --subnet-mode=custom
gcloud compute networks subnets create livekit-us-east1 --project="$P" \
  --network=livekit --region=us-east1 --range=10.10.0.0/24
gcloud compute firewall-rules create livekit-media --project="$P" \
  --network=livekit --direction=INGRESS --source-ranges=0.0.0.0/0 \
  --allow=tcp:80,tcp:443,tcp:7881,udp:3478,udp:7882,udp:50000-50199 \
  --target-tags=livekit
gcloud compute addresses create livekit-ip --project="$P" \
  --region=us-east1 --network-tier=STANDARD

# lk-key / lk-secret: files holding production's LiveKit pair, the same values
# as LIVEKIT_API_KEY / LIVEKIT_API_SECRET in production Infisical.
gcloud compute instances create livekit --project="$P" --zone=us-east1-b \
  --machine-type=e2-micro \
  --network-interface=subnet=livekit-us-east1,address=<the address above>,network-tier=STANDARD \
  --tags=livekit \
  --image-family=ubuntu-minimal-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --no-service-account --no-scopes \
  --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
  --metadata=lk-host=livekit.spiralclass.com,lk-webhook-url=https://spiralclass.com/api/livekit/webhook \
  --metadata-from-file=startup-script=infra/gcp-livekit/startup.sh,lk-key=<file>,lk-secret=<file>
```

Then, by hand:

1. **Cloudflare:** the `livekit` A record → the address above, **proxied**
   ([D-134](../../docs/decisions/D-134.md)). `Always Use HTTPS` must not apply
   to this hostname, or Caddy's http-01 challenge on :80 never reaches the box
   and no certificate is issued.
2. **Wait for `### READY`** on the serial console (below), then for Caddy's
   certificate: `curl -sI https://livekit.spiralclass.com` answers `200`.

First boot takes about five minutes on this machine, most of it `apt` and the
image pulls.

## Reading it

There is no SSH. Everything the box says goes to its serial console:

```bash
gcloud compute instances get-serial-port-output livekit --project="$P" --zone=us-east1-b \
  | grep -E '^### |^Mem:|^Average|cpu='
```

A `### SAMPLE` block lands every minute: memory, CPU (the last `mpstat` column
is idle), and per-container CPU and memory. `### READY` marks the end of each
boot. A failed boot shows as `Script "startup-script" failed with error`.

## Changing it

Edit `startup.sh` here, then push it and reboot — the stack is re-rendered on
every boot, and `.installed` skips the install half:

```bash
gcloud compute instances add-metadata livekit --project="$P" --zone=us-east1-b \
  --metadata-from-file=startup-script=infra/gcp-livekit/startup.sh
gcloud compute instances reset livekit --project="$P" --zone=us-east1-b
```

A reboot drops any class in progress. Do it outside lesson hours.

**Rotating the key pair** is `add-metadata` with new `lk-key`/`lk-secret`
files, the same values into production Infisical, a reset, and a redeploy of
the app — in that order, between classes.
