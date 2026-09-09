# Oracle A1 self-hosted LiveKit — production deployment

> [!IMPORTANT]
> **2026-08-29 — the Tofu module this document repeatedly points at is gone.**
> `infra/oracle-runner` was deleted in [D-139](../decisions/D-139.md): it had
> never been applied and had no state, so every `tofu apply` instruction below
> would have edited a template rather than the box. **The rebuild procedure is
> now [`ORACLE_BOX_REBUILD.md`](./ORACLE_BOX_REBUILD.md)**, transcribed from
> the running machine. The manual-step sections here remain the best record of
> what was learned building the box by hand; the "the plan" column and the
> Tofu apply steps are historical and must not be followed.

**Status: LIVE and reachable (2026-07-21).** Fully deployed and verified
end-to-end from the public internet — DNS resolves, both firewall layers
(OCI security list + host iptables, see "Manual step 1") allow the right
ports, and Caddy holds a real Let's Encrypt cert
(`https://livekit.spiralclass.com/` returns `HTTP 200`). Wired to preview
since 2026-07-21 (`config/env/preview.runtime.env`); **as of D-94
(2026-07-21) also wired to production** (`config/env/production.runtime.env`)
— both environments now share this ONE box. Read this alongside
`ORACLE_LIVEKIT_SPIKE.md` (the capacity numbers
this deployment operates under) and
`../architecture/VIDEO_ARCHITECTURE_AUDIT.md`
(the cost/architecture reasoning behind self-hosting at all).

## How this box is delivered — today vs. the plan

Read this before assuming any part of the box comes from the repo.

| Layer                                      | How it works **today**                                                                                                                                                                                    | The plan                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Compute, network, firewall, DNS            | Provisioned **by hand** on 2026-07-21. An OpenTofu module was written for it and never applied, then deleted ([D-139](../decisions/D-139.md)); `infra/oracle-box` is the current, also-unapplied attempt. | Apply it; the box becomes rebuildable from `tofu apply`.                               |
| LiveKit / Egress / Caddy / Redis config    | Rendered onto the box **by hand** in `~/oracle-livekit-production/`. It has since drifted from `services/*.tftpl` (secrets moved into a box-local `.env`).                                                | Rendered by Tofu at apply time.                                                        |
| Upstream images                            | `docker compose pull`, tracking `:latest`.                                                                                                                                                                | Unchanged, or pinned — open question.                                                  |
| **Captions Agent** (only first-party code) | Built **on the box** from a real `main` git checkout at `~/agendaprofe`, image pinned by commit SHA — **D-108**.                                                                                          | CI-built arm64 image in GHCR, pulled by tag — `CAPTIONS_AGENT_DELIVERY.md` Pieces 1–3. |

**The single biggest trap:** `services/docker-compose.livekit.yml.tftpl`
declares `image: ghcr.io/…/agendaprofe-captions-agent:latest`, and **nothing
has ever published that image**. Applying the module onto a rebuilt box would
bring LiveKit up fine while the Agent silently fails to start — classes
connect normally with no captions. That module is deleted ([D-139](../decisions/D-139.md)), so the trap is
now only a reason never to resurrect it from git history without reading
this first. On the live box the Agent is **built locally** from
`/home/ubuntu/agendaprofe`, not pulled — see
[`ORACLE_BOX_REBUILD.md`](./ORACLE_BOX_REBUILD.md).

**On the Tofu module's scope.** Everything the "Manual step" sections below
originally had to be done by hand over SSH — the OCI security list, the host
iptables rules, the DNS record, the real LiveKit key/secret baked into
`livekit.yaml`/`egress.yaml`, joining Tailscale — is now _declared_ in
an OpenTofu module. The manual-step sections are kept below as the
historical record of what was actually discovered doing this by hand the
first time (the two-firewall-layer finding in particular is still real and
still worth knowing), each now annotated with what replaced it.

## Risk-acceptance record — read this before touching the box

The spike doc, §32/§33 of the audit, and this doc's own earlier drafts all
said **don't put production video on this specific box** —
[D-49](../decisions/D-49.md) already ruled it out for anything prod-critical (documented capacity/suspension
risk, no failover), and the measured capacity ceiling (~15-20 concurrent
rooms, see `ORACLE_LIVEKIT_SPIKE.md`) is real, not hypothetical.

**This was a deliberate, informed operator decision, not an oversight.**
Given the choice between provisioning new paid infrastructure (a fresh
Hetzner box, real recurring cost starting immediately) versus using the
already-provisioned, already-free Oracle box for what is currently exactly
one teacher's traffic, the operator chose the Oracle box explicitly, after
seeing the real load-test numbers. At n=1 teacher, concurrent load is
bounded by that one person's ability to teach one class at a time — the
box's ~15-20-room ceiling is not the binding constraint right now. The
residual, real risk is **operational**, not capacity: no SLA, Oracle account
suspensions are documented as a real occurrence, no redundancy if the box
goes down mid-class.

**D-94 update (2026-07-21):** production was cut over onto this SAME box,
not a second one — reaffirming the risk acceptance above rather than
introducing a new one. The ~15-20-room ceiling now has to absorb combined
preview+production traffic, not just preview's. Still accepted at current
scale (current production load, preview's own history on the box), but the
margin before the ceiling matters is smaller than when only preview used it.

**What this means going forward:**

- If a second or third teacher starts generating real concurrent load, or if
  this box becomes unavailable, treat that as the trigger to actually
  provision the Hetzner box `ORACLE_LIVEKIT_SPIKE.md` describes — not a
  reason to scale this one up further. This box was never meant to be the
  permanent answer past very small scale, and that's now true for BOTH
  environments' traffic, not just preview's.
- Recordings are safe regardless of what happens to this box — they upload
  directly to Cloudflare R2 (durable, off-box) the moment egress completes;
  nothing recording-related is stored locally on the box.
- If the box is reclaimed/suspended (a documented Oracle free-tier
  possibility), the failure mode is **video calls stop working**, not data
  loss — see "Disaster recovery" below for the fastest path back.

## Architecture

```
Internet ──443──▶ Caddy (auto Let's Encrypt) ──▶ livekit-server:7880 (wss signaling)
Internet ──7881/tcp, 50000-60000/udp──────────▶ livekit-server (RTC media, direct)
Internet ──3478/udp──────────────────────────▶ livekit-server (embedded TURN, NAT fallback)
livekit-server ──▶ redis (job coordination) ◀── livekit-egress
livekit-egress ──▶ Cloudflare R2 (S3-compatible, per-request creds from the app)
livekit-server ──▶ https://spiralclass.com/api/livekit/webhook (signed, existing route)
```

All four services (`caddy`, `redis`, `livekit`, `egress`) run via one
`docker-compose.yml` (source of truth:
`infra/oracle-runner/services/docker-compose.livekit.yml`), all on
`network_mode: host` — see that file's own comments for why. SSH stays
Tailscale-only; only the ports in the diagram above are open at the OCI
security-list layer (see "Manual step 1" below) — this box's original
hardening (its runbook was deleted by [D-164](../decisions/D-164.md)) is otherwise untouched.

## What's app-side vs. box-side

**App-side: zero code changes.** This is the payoff of the Phase 1
`VideoProvider` abstraction and D-16's original design (the join URL travels
in the per-call grant, never baked into a client build) — switching from
LiveKit Cloud to this self-hosted deployment is purely
`LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` pointing somewhere new.
The client picks up the new URL automatically through the existing
token-minting routes; nothing in `apps/web/src/components/video/` changes.

**One real behavior change, flagged explicitly, not silent:** production
also flips `CLASS_RECORDING_ENABLED=1` (previously off) as part of this
migration, since the ask was working, non-placeholder recording, not just
infrastructure. Because of a pre-existing coupling
(`the video architecture review` §5.2, deliberately left
unfixed during Phase 1) turning this on also starts per-participant
lesson-audio capture to R2 for consenting students — not the downstream AI
transcription/analysis (`LESSON_INSIGHTS_TRANSCRIPTION_ENABLED` stays off,
separately gated, still legal-blocked per D-21). Consent (D-22) still gates
who this applies to; nothing here changes the consent model, only that the
capture side of the already-consented-to pipeline now actually runs instead
of being silently prevented by the coupling bug.

## CI-runner role retired (2026-07-21)

This box used to double-duty as a self-hosted GitHub Actions runner (its
runbook is deleted, [D-164](../decisions/D-164.md)) before every workflow moved
back to GitHub-hosted `ubuntu-latest`. That stopped anything from being
_dispatched_ here, but the two runner **registrations**
(`oracle-a1-runner`, `oracle-a1-runner-2`) were left running — dead weight,
still polling GitHub for jobs that would never arrive. Both are now
deregistered from GitHub's side
(`gh api -X DELETE repos/jaystewart-dev/spiralclass/actions/runners/{id}`).

**Tuning pass (2026-07-21, same day) — EXECUTED, box confirmed LiveKit-only.**
`docs/deployment/oracle-livekit-only-cleanup.sh` was run for real over Tailscale
SSH: `df -h /` went from **38G/45G (86%) to 28G/45G (62%) used**. It stops +
removes both runner installs (`~/actions-runner`, `~/actions-runner-2`,
their systemd services, and their per-runner pnpm stores — the runner runbook's
"give each runner its own pnpm store" note put these at a fixed path per
runner, and they'd accumulated every package version ever installed across
every CI run, unbounded), purges the CI-only toolchain (`nodejs`,
`build-essential`, `postgresql-client`, AWS CLI v2 — none of it is needed to
run four Docker containers), and runs a **safe** `docker system prune`
(dangling images/stopped containers only — never `-a`/`--volumes`, which
would also take the LiveKit stack's own images and its four named state
volumes). Prints `df -h` / `free -h` before and after. Idempotent — safe to
re-run if this box is ever reclaimed and rebuilt onto the CI-era toolchain
by mistake.

Also manually found and removed, past what the script covers (verified zero
references first): two full-size unused `postgres:16`/`postgres:17` CI
images (~1.3GB, left over from `integration.yml`'s Postgres service
container) via `docker image rm`, and 10 orphaned anonymous volumes
(~780MB, `LINKS: 0`, same source) via `docker volume prune -f` — this is
safe _only_ because it removes exclusively volumes with zero container
references; it never touches the four named
`oracle-livekit-production_*` volumes, which are actively referenced by the
running containers. Verified throughout: all four LiveKit containers stayed
up the entire time and `https://livekit.spiralclass.com/` kept returning 200.

```bash
# To re-run the script by hand (e.g. after a rebuild):
ssh ubuntu@oracle-a1-runner   # or your tailnet name for the box
sudo bash oracle-livekit-only-cleanup.sh
```

After that, this box runs **only** the LiveKit `docker-compose` stack
described below — no CI workload, no runner process, no JS/Node toolchain.
Don't re-register a GitHub Actions runner here, and don't re-run
`oracle-runner-cloud-init.sh` if this box is ever reclaimed/rebuilt — use
`oracle-livekit-cloud-init.sh` instead (now `infra/oracle-runner`'s
`cloud_init_file` default). If CI minutes become a problem again, that's a
GitHub-hosted-runner cost question (see
[`COST_PLAYBOOK.md`](./COST_PLAYBOOK.md)), not a reason to add CI workload
back onto this box.

## Manual step 1 — OCI security list (DONE, 2026-07-21; now Tofu-declarative)

**Superseded.** `infra/oracle-runner`'s `oci_core_default_security_list`
resource now declares these same 5 ingress rules directly — a future
`tofu apply` no longer silently wipes them (this resource replaces the
ENTIRE default list on every apply, so a hand-run OCI edit outside Tofu was
always one `apply` away from being erased; that latent bug is what this
plan's PR actually fixed). The commands below are kept as the historical
record of how this was originally discovered and applied, over Cloud
Shell. The corrected working version (the first draft
queried a security list _named_ `ap-runner-vcn`, which doesn't exist — the
VCN is named that, its security list is auto-named "Default Security List
for ap-runner-vcn"; also replaced the original's hand-merge-JSON placeholder
with an actual `jq` merge):

```bash
C="$OCI_TENANCY"
VCN=$(oci network vcn list -c "$C" --display-name ap-runner-vcn --query 'data[0].id' --raw-output)
SECLIST=$(oci network security-list list -c "$C" --vcn-id "$VCN" --query 'data[0].id' --raw-output)

EXISTING=$(oci network security-list get --security-list-id "$SECLIST" --query 'data."ingress-security-rules"')
NEW_RULES='[
  {"protocol":"6","source":"0.0.0.0/0","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":443,"max":443}},"description":"LiveKit signaling (Caddy/wss)"},
  {"protocol":"6","source":"0.0.0.0/0","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":80,"max":80}},"description":"ACME HTTP-01 challenge (Caddy cert issuance/renewal)"},
  {"protocol":"6","source":"0.0.0.0/0","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":7881,"max":7881}},"description":"LiveKit RTC TCP fallback"},
  {"protocol":"17","source":"0.0.0.0/0","isStateless":false,"udpOptions":{"destinationPortRange":{"min":3478,"max":3478}},"description":"LiveKit embedded TURN"},
  {"protocol":"17","source":"0.0.0.0/0","isStateless":false,"udpOptions":{"destinationPortRange":{"min":50000,"max":60000}},"description":"LiveKit RTC media + TURN relay"}
]'
MERGED=$(jq -s '.[0] + .[1]' <(echo "$EXISTING") <(echo "$NEW_RULES"))
oci network security-list update --security-list-id "$SECLIST" --force --ingress-security-rules "$MERGED"
```

**Real finding along the way: this alone was not enough.** The box also has
a **separate, host-level `iptables` firewall** (independent of OCI's cloud
security list) with its own explicit allowlist — originally only SSH:22 —
and a catch-all `REJECT ... icmp-host-prohibited`. Updating only the OCI
security list left every new port still blocked at the OS level (`nc`
against the public IP failed with "No route to host", not a plain
connection-refused/timeout). **This finding is why `infra/oracle-runner`'s
`cloud-init.yaml.tftpl` also inserts the same 5 iptables rules in its
`runcmd`** — a fresh box gets both layers opened automatically on first
boot; a box created before that change (i.e. the currently-live one) still
has these applied from the original manual pass below, and only needs this
repeated by hand if it's ever rebuilt from an image predating the Tofu
change. Originally fixed by inserting matching ACCEPT rules into the box's
own `INPUT` chain, before the reject, then persisting (`iptables-persistent`
was already installed):

```bash
sudo iptables -I INPUT 6 -p tcp --dport 443 -m state --state NEW -j ACCEPT -m comment --comment 'LiveKit signaling (Caddy/wss)'
sudo iptables -I INPUT 6 -p tcp --dport 80 -m state --state NEW -j ACCEPT -m comment --comment 'ACME HTTP-01 challenge'
sudo iptables -I INPUT 6 -p tcp --dport 7881 -m state --state NEW -j ACCEPT -m comment --comment 'LiveKit RTC TCP fallback'
sudo iptables -I INPUT 6 -p udp --dport 3478 -j ACCEPT -m comment --comment 'LiveKit embedded TURN'
sudo iptables -I INPUT 6 -p udp --dport 50000:60000 -j ACCEPT -m comment --comment 'LiveKit RTC media + TURN relay'
sudo netfilter-persistent save
```

**Two independent firewall layers exist on this box — remember both for any
future port change:** the OCI cloud security list (above) AND this host
iptables chain. Verified end to end after both were fixed:
`nc -zv <public-ip> 443/80/7881` all succeeded, and
`curl https://livekit.spiralclass.com/` returned a real `HTTP 200` over a
real Let's Encrypt cert from the public internet.

## Manual step 2 — DNS record (DONE; now Tofu-declarative)

**Superseded.** `infra/oracle-runner`'s `cloudflare_dns_record.livekit`
resource now owns this record, pointed directly at
`oci_core_instance.runner["primary"].public_ip` — a real box replacement
(disaster recovery, or the blue-green cutover in the reproducibility PR)
updates DNS automatically on the next `tofu apply`, no manual dig/edit step.
Caddy auto-obtained its Let's Encrypt certificate the moment both this and
the firewall fix above were live (`docker logs livekit-caddy`: `"certificate
obtained successfully"`) — no separate action needed once DNS + ports were
correct.

**The record is PROXIED (orange cloud) as of 2026-08-27**
([D-134](../decisions/D-134.md)) — it was DNS-only until then, so
`dig +short livekit.spiralclass.com A` now returns Cloudflare edge addresses,
not the box's IP. Only the wss signalling on :443 resolves this name, and
Cloudflare's proxy carries WebSockets natively; RTC media never resolves it
at all, because `livekit.yaml`'s `rtc.use_external_ip: true` makes
livekit-server advertise the box's own public IP in its ICE candidates.
Two operational consequences: keep the zone's SSL/TLS mode on **Full** (or
Full strict) and **"Always Use HTTPS" off** for this hostname, or Caddy's
ACME HTTP-01 renewal on :80 breaks silently (current cert expires
2026-10-19, first proxied renewal ~2026-09-19); and to reach the origin
directly for debugging, use the IP from
`tofu output` / the OCI console rather than the hostname.

<details>
<summary>Original manual instructions (kept for reference / a non-Tofu box)</summary>

Add an **A record**, proxied (orange cloud — Cloudflare carries the wss
signalling fine, and RTC media goes straight to the box's own IP via ICE, so
it never touches the proxy; see [D-134](../decisions/D-134.md)):

```
livekit.spiralclass.com  A  203.0.113.10
```

(Rename the subdomain first if you'd prefer something other than
`livekit.spiralclass.com` — update `Caddyfile` and `livekit.yaml`'s
`webhook.urls` to match before deploying, since Caddy requests its cert for
whatever hostname is in the Caddyfile.)

Caddy auto-provisions and renews the Let's Encrypt cert the moment this
resolves and ports 80/443 are open — no separate certbot step.

</details>

## Manual step 3 — production Infisical `LIVEKIT_API_SECRET` (OUTSTANDING, D-94)

`config/env/production.runtime.env` now points production at this box
(`LIVEKIT_URL`/`LIVEKIT_API_KEY` match preview's values, since it's the same
physical server), but the paired secret half —
`LIVEKIT_API_SECRET` — has NOT been updated in production's Infisical scope.
Until it matches the value already set for preview, every token production
mints will be signed with the old LiveKit Cloud secret and this box will
reject it (a valid-looking JWT that fails the box's own signature check —
calls will fail to connect, not degrade). This is a credentials-gated step
with no code-level substitute; do it before (or as part of) the next
production promote that ships this config change. **Not affected by the
Tofu reproducibility work** — that's a completely separate Infisical
scope (the APP's own runtime env) from `infra/oracle-runner`'s
`livekit_api_secret` Tofu variable (the BOX-side render input); the two
must hold the same value, but neither automates the other.

## Deploying / redeploying

**Provisioning a box from scratch, or a full config/toolchain refresh, is a
hand operation** — see [`ORACLE_BOX_REBUILD.md`](./ORACLE_BOX_REBUILD.md).
It used to say this went "through Tofu now"; it never did. The module was
deleted in [D-139](../decisions/D-139.md) and the `tofu apply -replace` block
that stood here has been removed rather than left to be copied at 2am.

Config changes on the running box are made in place, over Tailscale SSH, in
`/home/ubuntu/oracle-livekit-production/` — with a `.bak` copy first, which is
the convention the box itself already follows.

This destroys and recreates the box — brief signaling interruption expected,
same as the routine image-bump process below; do it outside lesson hours.
DNS follows automatically (`cloudflare_dns_record.livekit` reads the new
box's `public_ip` directly), but this is still a real destroy/recreate, not
a blue-green swap — for a swap with a verified-before-cutover new box, see
the reproducibility plan's `"green"`-key cutover procedure instead.

**A routine image-tag bump (no config change)** doesn't need any of the
above — it's still a direct docker-compose action on the already-running
box, same as always:

```bash
ssh ubuntu@oracle-a1-runner   # or your tailnet name for the box
cd ~/oracle-livekit-production
docker compose up -d
docker compose logs -f livekit   # confirm no errors, watch for the TURN/redis connect lines
curl -sS https://livekit.spiralclass.com/   # once DNS+ports are live — should 200
```

## Captions Agent — deploy & rollback (interim, 2026-07-29)

The other four services are upstream images pulled by tag. The captions Agent
(`packages/livekit-captions-agent`) is the **only first-party code on this
box**, so it is the only thing that gets _built_ — `docker compose pull` does
not cover it, and neither does the image-tag bump above.

**Known, deliberate drift from the Tofu template.** `infra/oracle-runner/
services/docker-compose.livekit.yml.tftpl` declares
`image: ghcr.io/jaystewart-dev/agendaprofe-captions-agent:latest`. Nothing has
ever published that image. Until the GHCR pipeline in
`CAPTIONS_AGENT_DELIVERY.md`
is built, the box's own `~/oracle-livekit-production/docker-compose.yml`
instead carries a `build:` context plus a **pinned SHA tag**. Do not "fix"
this drift by editing the template — when the box is next rebuilt from Tofu,
the `build:` stanza goes away and `image:` becomes correct again.

### Why the box has a git checkout

Before 2026-07-29 the image was built from `/home/ubuntu/captions-agent-src`,
a hand-copied partial source tree with **no `.git`** — so "is the box running
current code?" could only be answered by hashing files over SSH. That is what
turned a two-line bug into the 2026-07-28 captions outage.

The box now has `~/agendaprofe`, a real checkout whose `git rev-parse HEAD`
is a verifiable commit. **That path, and the `agendaprofe-captions-agent`
image name below, are the PRE-RENAME ones** — the repo became `spiralclass`
and the box's directory and image tag did not follow, so the compose file's
`build.context` and `image:` both still say `agendaprofe`. This section said
`~/spiralclass` until 2026-09-02, which is a directory that does not exist;
following it costs you the whole mechanism described here, because the
obvious recovery is to copy files up by hand — which is exactly the
pre-D-108 state this section exists to prevent, and is what happened on
2026-09-02. The repo is **private and the box holds no GitHub
credential** — nothing is cloned from GitHub. Instead the operator's machine
pushes to it over Tailscale SSH, into a repo configured with
`receive.denyCurrentBranch=updateInstead` so the push updates the working tree
directly (and refuses if that tree is ever dirty, which is the intended
safety property). Commit SHAs survive the transport, so provenance is intact
either way.

Track **`main`**, not `production` (changed 2026-07-29 — D-108 shipped hours
earlier saying the opposite; see its addendum for why that reversed). Three
reasons:

- **`promote.yml` does not ship the Agent.** `fly-deploy.yml`'s `paths`
  exclude `packages/livekit-captions-agent/**`, and the box build is manual
  regardless. Tracking `production` never bought synchrony with anything — it
  only forced a full production gate and a `production` fast-forward for a
  change production itself never deploys.
- **This one box serves BOTH preview and production** (D-94). Preview clients
  run `main`, so tracking `production` kept the Agent _behind_ half the
  clients it serves.
- Agent changes so far are box-internal lifecycle fixes (leaked workers, mic
  re-handling, the rejoin race) that never touch the wire contract.

> **The exception that still needs sequencing.** If a change alters the shared
> caption wire contract (`packages/shared/src/captions.ts` — `CAPTION_TOPIC`,
> `encodeCaption`, the `for` field) or the `captionsOn` attribute's meaning,
> the Agent running ahead of production clients is a real hazard — a
> mismatched contract is precisely what the 2026-07-28 outage was. Ship the
> client change to production **first**, then the Agent.

### Deploy

```bash
# 1. from your machine (adds the remote once: git remote add oraclebox \
#    ubuntu@oracle-a1-runner:spiralclass)
git push oraclebox origin/main:refs/heads/main

# 2. on the box
ssh ubuntu@oracle-a1-runner
cd ~/agendaprofe && SHA=$(git rev-parse --short HEAD)
docker build -f packages/livekit-captions-agent/Dockerfile \
  -t agendaprofe-captions-agent:$SHA -t agendaprofe-captions-agent:latest .
sed -i "s|agendaprofe-captions-agent:[a-z0-9]*|agendaprofe-captions-agent:$SHA|" \
  ~/oracle-livekit-production/docker-compose.yml
cd ~/oracle-livekit-production && docker compose up -d --no-build captions-agent
```

Expect **~9 minutes** on this box's 2 OCPUs — the `COPY node_modules` and
image-export/unpack steps dominate (~74 s and ~127 s), not the pnpm install.
Only the `captions-agent` container is recreated; the other four are
untouched.

Two things that will otherwise confuse you mid-build:

- **BuildKit applies the two `-t` tags at different times.** It names
  `:$SHA`, spends ~53 s _unpacking_, then names `:latest`. Seeing the SHA tag
  appear does **not** mean the build finished, and a lagging `:latest` is not
  a failure — wait for the `docker build` process to exit.
- Always double-tag. The `:$SHA` tags are the entire rollback story (there is
  no registry), and they survive both `docker image prune` and
  `docker builder prune`; an untagged previous image does not.

### Live-call interlock — check before every restart

**Restarting the Agent kills captions for any call in progress**, and unlike
a web deploy there is no graceful drain. Check first:

```bash
set -a; . ~/oracle-livekit-production/.env; set +a
lk room list --url http://127.0.0.1:7880 \
  --api-key "$LIVEKIT_API_KEY" --api-secret "$LIVEKIT_API_SECRET"
```

Safe to restart when **every room shows 0 publishers and at most 1
participant** — the Agent joins as a real participant, so `1` means "the
Agent and nobody else". A live class is 2+ participants with at least one
publisher.

Parsing this in a script has three traps, all of which will silently produce
a wrong answer: `lk` prints a banner on **stderr** (so don't blindly strip
the first line); the payload is `{"rooms": [...]}`, not a bare array; and it
is protobuf JSON, which **omits zero-valued fields** — `numParticipants` and
`numPublishers` are simply absent when 0, so default them rather than
`KeyError`ing or, worse, treating absence as truthy. Make the guard fail
_closed_: if parsing fails, abort the restart.

### Rollback

No rebuild and no network — point the tag back and recreate:

```bash
docker images agendaprofe-captions-agent          # the SHA tags are your history
sed -i "s|agendaprofe-captions-agent:[a-z0-9]*|agendaprofe-captions-agent:<prev-sha>|" \
  ~/oracle-livekit-production/docker-compose.yml
cd ~/oracle-livekit-production && docker compose up -d --no-build captions-agent
```

### Verifying a deploy

All of these should agree:

1. `docker ps` — the running image tag is the SHA you just built.
2. `git -C ~/agendaprofe rev-parse --short HEAD` — the same SHA.
3. `grep agendaprofe-captions-agent ~/oracle-livekit-production/docker-compose.yml`
   — the same SHA.
4. First real class — one `captions_toggle_seen` from the teacher followed by
   **two** `sync_deepgram` lines, one per identity. One line means the Agent
   predates `19307f60` (the teacher-only toggle).

## Restart / health / logs

- **Auto-restart:** every service is `restart: unless-stopped` — survives a
  container crash or box reboot without intervention.
- **Certificate:** `pnpm local synthetic` checks Caddy's cert on the ORIGIN
  IP (not the Cloudflare edge, whose cert is always valid) and fails under
  21 days remaining. Since [D-134](../decisions/D-134.md) proxied the record,
  TLS-ALPN-01 cannot work at all and renewal rests solely on HTTP-01
  surviving Cloudflare's redirect — one path where there were two, hence
  the probe. A box replacement must update `LIVEKIT_ORIGIN_IP` in
  `scripts/local/synthetic.sh` alongside the Tofu record's `content`.
- **Health check:** `curl https://livekit.spiralclass.com/` (200 = signaling
  up); `docker compose ps` for container-level status.
- **Logs:** `docker compose logs -f <service>` (`caddy`, `livekit`, `redis`,
  `egress`). No external log shipping set up — this is a single box, `docker
logs` is the whole story for now.
- **Metrics:** none wired up beyond what `docker stats` gives ad hoc — no
  Prometheus/Grafana. Revisit if/when this graduates to the Hetzner box.

## Upgrade process

```bash
cd ~/oracle-livekit-production
docker compose pull          # new livekit-server/egress/caddy/redis images
docker compose up -d         # recreates changed containers, others untouched
docker compose logs -f livekit egress   # confirm clean startup before walking away
```

This covers the **four upstream images only**. The captions Agent is built
locally from `~/agendaprofe`, so `pull` does not update it — see "Captions
Agent — deploy & rollback" above, and check the live-call interlock there
before any restart that includes it.

Rollback: `docker compose down`, edit the image tags back to the previous
known-good version, `docker compose up -d` again. No blue/green — a brief
signaling interruption during upgrade is expected; do this outside lesson
hours per the repo's existing "no risky-path merges during lesson hours"
policy, treating this exactly like any other production-risk change.

## Backup

- **Recordings:** already durable — they land in R2 directly from Egress,
  never staged on the box. Nothing to back up there.
- **Redis:** job-coordination state only (in-flight egress jobs), not a
  system of record — `redis_data` volume has `--save 60 1` RDB persistence
  so a container restart doesn't lose in-flight job state, but this is not a
  backup target worth restoring from elsewhere; if lost, in-flight
  recordings fail and the app's existing stale-row self-heal
  (`call-recording.ts`'s `startBookingRecording`) cleans up on the next
  Record attempt.
- **Config** (`docker-compose.yml`/`livekit.yaml`/`egress.yaml`/`Caddyfile`):
  **not version-controlled anywhere.** It lives only on the box, in
  `/home/ubuntu/oracle-livekit-production/`, alongside hand-made `.bak`
  copies. Secrets come from Infisical's `infra` environment and are never
  committed. Losing the box means rebuilding it by hand from
  [`ORACLE_BOX_REBUILD.md`](./ORACLE_BOX_REBUILD.md); if you regenerate a fresh LiveKit key/secret
  pair while you're at it (rather than reusing the same one), that also
  means updating the app's `LIVEKIT_API_SECRET` in Infisical to match (see
  "Manual step 3" above for that separate scope).
- **Caddy's cert:** `caddy_data` volume — losing it just means Caddy
  re-issues from Let's Encrypt on next start (rate-limited, but not
  precious).

## Disaster recovery (box reclaimed/suspended)

Now much shorter, since box + security list + DNS record all live in one
Tofu state:

1. **Rebuild by hand, following
   [`ORACLE_BOX_REBUILD.md`](./ORACLE_BOX_REBUILD.md)** — instance, OCI
   security list, host iptables and the Cloudflare DNS record are all separate
   manual steps, and the runbook gives the order. This step used to read
   `cd infra/oracle-runner && $INFISICAL tofu apply` and claim one apply
   recreated all of it; that module was never applied and is now deleted
   ([D-139](../decisions/D-139.md)). Alternatively,
   stand up the Hetzner box this was always meant to graduate to (see
   "Risk-acceptance record" above) — this is the natural moment to make
   that move instead of re-provisioning the same free-tier box again.
2. Supply the SAME `livekit_api_key`/`livekit_api_secret` values as before
   (they're just Infisical-stored Tofu variables now, not regenerated
   on-box) and **no app-side change is needed at all** — this is the one
   thing that got strictly easier: the pre-Tofu process regenerated fresh
   keys on every re-provision (forcing a `LIVEKIT_API_SECRET` Infisical
   update, Manual step 3's exact failure mode), but reusing the stored value
   here is now a deliberate choice, not something re-provisioning forces on
   you. Only rotate (and only then update the app's `LIVEKIT_API_SECRET` to
   match) if you actually want to invalidate the old key.
3. No app code changes needed either way — same as the
   original migration, the URL travels in the per-call grant.

## Validation checklist

Run through this after any deploy/redeploy, matching the original migration
ask's own list:

1. Teacher creates/joins a room (web) — real call connects.
2. Student joins the same room (web) — both sides see/hear each other.
3. Same, from a phone browser on a mobile network — confirms the RTC UDP range and TURN
   fallback both work from a real device, not just Tailscale.
4. Kill wifi briefly mid-call — confirms reconnect (existing livekit-client
   auto-reconnect logic, unchanged).
5. Teacher taps Record — `CallRecording` row created, egress starts
   (`docker compose logs -f egress` shows a room-composite job).
6. End the call — egress completes, `CallRecording.status` flips to
   `completed` via the webhook path (`egress_ended` → `webhook-events.ts`),
   file lands in the R2 `recordings` bucket.
7. Download/play back the recording from the app.
8. If a consenting student was in the call, confirm a `LessonAudio` row
   also completed (the coupling-bug side effect noted above) and its file
   is in R2 under `lesson-audio/`.

## Confirmed findings (infra-level testing, 2026-07-21)

Tested directly against the deployed stack (via `lk`, bypassing the app —
this confirms the infrastructure works; items 1-4 and 6-8 above still need a
real pass through the actual app once app-side config points here):

- **TURN relay range**: LiveKit's embedded TURN does **not** reuse
  `rtc.port_range_start/end` by default — it has its own separate default
  (30000-40000), confirmed on first boot. Fixed by explicitly setting
  `turn.relay_range_start/end` to match `rtc.port_range` (both 50000-60000),
  so only one UDP range needs opening (Manual step 1 above already assumes
  this fix). If you ever see TURN connection failures despite the firewall
  rules being applied, check this hasn't drifted.
- **Egress CPU warning is real but not fatal.** Egress logs `"not enough cpu
for some egress types"` (`minimumCpu: 4`, `available: 2`) on every
  startup — this box's 2 OCPUs are below Egress's own recommended minimum
  for CPU-heavy room-composite jobs. A `cpu_cost.room_composite_cpu_cost: 2`
  override in `egress.yaml` did **not** silence the warning (it appears to
  be a broader system-level floor check, not purely the per-type cost), so
  it's left in as an honest declaration rather than something that "fixed"
  it.
- **Room-composite recording was tested directly and works.** A real
  ~30-second room-composite egress (2 simulated video publishers → Chrome
  render → local file output, bypassing R2 to isolate the CPU-bound render
  path from the already-proven S3 upload path) completed cleanly:
  `egress_active` → `egress_ending` → `egress_complete`, no errors, CPU
  peaked around 160% (1.6 of 2 cores) during the render, and the output was
  a valid `ISO Media, MP4 v2` file at a plausible size for the duration. The
  startup warning is a conservative heads-up, not a functional blocker, **at
  this box's actual usage (one teacher, recordings essentially never
  concurrent)**. Revisit if concurrent room-composite jobs ever become
  realistic — that's exactly the scenario the CPU floor is warning about.
