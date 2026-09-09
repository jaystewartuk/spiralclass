# Rebuilding the Oracle A1 box

> [!NOTE]
> **[D-150](../decisions/D-150.md) (2026-09-03) decided this box gets an
> OpenTofu definition again, and that the Next.js app moves onto Oracle
> alongside it.** Nothing has been applied — there are no OCI credentials on
> the dev machine — so **everything below is still the only description of the
> box and is still the procedure to follow.** D-150 also carries the
> measurement that shaped it: this box is in `mx-queretaro-1`, 58 ms from
> Neon's `aws-us-east-2` against the Fly machine's 12 ms. When the module
> lands, this file's "Rebuild" section is what it replaces.

> [!IMPORTANT]
> **This box is hand-built and hand-maintained. There is no infrastructure
> code for it, and there never was one that worked.**
>
> `infra/oracle-runner/` used to sit in this repo claiming that "a `tofu
apply`/rebuild today reproduces the box as-is". It was never applied, had no
> state file, and had drifted from the running machine. It was deleted in
> [D-139](../decisions/D-139.md). This file replaces it, and every command and
> value below was **observed on the running box on 2026-08-29** rather than
> copied out of a template.
>
> **Nothing here is machine-checked.** If you change the box, change this file
> in the same session, or it becomes the thing it replaced.

## What this box is

One Oracle Cloud Always Free ARM instance running the self-hosted LiveKit
stack that carries every live class. It is **not** a CI runner — that role was
retired in 2026-07 after three reversals in as many days, and CI now runs on
GitHub-hosted runners ([D-157](../decisions/D-157.md)).

Losing it stops classes. Rebuilding it is a hand operation measured in hours,
which is the cost [D-139](../decisions/D-139.md) knowingly accepted.

## Observed state, 2026-08-29

| Property       | Value                                                            |
| -------------- | ---------------------------------------------------------------- |
| Hostname       | `oracle-a1-runner` (the name is a fossil of the retired CI role) |
| OS             | Ubuntu 24.04.4 LTS, kernel `6.17.0-1018-oracle`                  |
| Architecture   | `aarch64`                                                        |
| CPU / RAM      | 2 vCPU, 11 GiB usable                                            |
| Boot volume    | 50 GB (`/dev/sda1`, 45 G usable, 56% used)                       |
| Docker         | 29.6.1                                                           |
| Docker Compose | v5.3.1                                                           |
| Tailscale      | 1.102.2                                                          |
| Tailnet IPv4   | `100.64.0.1`                                                     |
| Tailnet IPv6   | `fd7a:115c:a1e0::7301:12c3`                                      |

**Shape is `VM.Standard.A1.Flex`, 2 OCPU / 12 GB, 50 GB boot, `ap-runner` name
prefix.** That came from the deleted module's `variables.tf` and matches what
the running box reports, but the OCI console is the authority and was not
queried while writing this.

## Access

```
ssh ubuntu@100.64.0.1     # or: ssh ubuntu@oracle-a1-runner
```

**Tailscale SSH answers on :22 — the banner is `SSH-2.0-Tailscale`, so SSH
keys are irrelevant.** `~/.ssh/oracle_a1` does not exist, whatever the
retired CI-runner runbook used to say. If the connection hangs with no
output, authenticate the tailnet interactively first.

The node is **untagged** and **key expiry is disabled** (`KeyExpiry: null`),
so the connection does not silently die after 180 days. A rebuilt node must
have expiry disabled again, or SSH access will lapse on a date nobody has
written down.

## The stack

Everything lives in `/home/ubuntu/oracle-livekit-production/`:

| File                 | Mode | Purpose                                                                            |
| -------------------- | ---- | ---------------------------------------------------------------------------------- |
| `docker-compose.yml` | 644  | the five services                                                                  |
| `Caddyfile`          | 644  | TLS termination and the signaling reverse proxy                                    |
| `livekit.yaml`       | 600  | livekit-server config — sections `port`, `rtc`, `turn`, `redis`, `keys`, `webhook` |
| `egress.yaml`        | 600  | egress config — `ws_url`, `api_key`, `api_secret`, `redis`, `cpu_cost`             |
| `.env`               | 600  | secrets, consumed by compose variable substitution                                 |

Several `.bak` copies sit alongside these, written by hand before each edit.
They are the closest thing to a change history the box has.

**Five containers, all `network_mode: host`, all `restart: unless-stopped`:**

- `livekit-caddy` — `caddy:2`
- `livekit-server` — `livekit/livekit-server:latest`
- `livekit-egress` — `livekit/egress:latest`, `shm_size: 2gb`, `cap_add: SYS_ADMIN`
- `livekit-redis` — `redis:7-alpine`, `redis-server --bind 127.0.0.1 --port 6379 --save 60 1`
- `livekit-captions-agent` — built locally, see below

Host networking is deliberate: livekit-server needs unmediated access to its
RTC UDP range, and Docker bridge NAT breaks ICE.

**Four named volumes:**

- `oracle-livekit-production_caddy_data` — **holds the TLS certificates and the ACME account key. This is the one that matters.**
- `oracle-livekit-production_caddy_config`
- `oracle-livekit-production_redis_data`
- `oracle-livekit-production_egress_tmp`

### The captions agent is not pulled, it is built

```yaml
build:
  context: /home/ubuntu/agendaprofe
  dockerfile: packages/livekit-captions-agent/Dockerfile
image: agendaprofe-captions-agent:bd6d6679
```

**A source copy of this repo lives at `/home/ubuntu/agendaprofe` on the box**
— a minimal copy, not a full checkout — and the image tag is the commit it was
built from. A rebuild must recreate that directory before `docker compose up`
can succeed. The context path still carries the pre-rename name.

### Secrets

`.env` supplies six variables by compose substitution. Their values are **not**
in this repo and must come from Infisical:

`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `DEEPGRAM_API_KEY`,
`ANTHROPIC_API_KEY`, `CAPTIONS_AGENT_SHARED_SECRET`, `APP_INTERNAL_BASE_URL`

Infisical also holds `tailscale_authkey_oracle` and `cloudflare_zone_id`, which
the rebuild needs but compose does not read. See
the rotation runbook, which is kept privately (see
[`../security.md`](../security.md)).

### The web app's own config, when D-150 moves it here

⚠️ **Read this before the migration, not during it. The failure mode is
silence.**

Today the box runs LiveKit, the captions agent, Caddy and Redis.
[D-150](../decisions/D-150.md) moves the Next.js app here too, and the app gets
its non-secret configuration a different way from everything above.

**How it works on Fly.** `scripts/docker-entrypoint.sh` sources
`config/env/<APP_ENV>.runtime.env` from inside the image at boot. Nine values in
that file are the literal string `__LOCAL__` — they name real accounts (the
Stripe prices and billing-portal id, `GOOGLE_CLIENT_ID`, `GEMINI_VERTEX_PROJECT_ID`,
`LIVEKIT_API_KEY`, `SENTRY_DSN`, `POSTHOG_KEY`) and deliberately are not in git.
On Fly the real values arrive as **Fly secrets**, and the entrypoint's
only-if-unset rule lets them win over the file.

**Why that breaks here, quietly.** This box has no Fly secrets and does not run
`scripts/fly-deploy.sh`, whose preflight refuses to deploy when a `__LOCAL__`
key has no matching secret. The entrypoint **refuses to export a `__LOCAL__`**,
by design — leaving it unset so `env.ts` applies the variable's own
absent-value behaviour and the feature degrades cleanly rather than pointing at
a project that does not exist.

⚠️ **Cleanly is the problem.** Start the app here without supplying them and
there is no error in any log: sign-in loses its Google client, checkout loses
its prices, and classes lose the LiveKit key. **You find out from a person, not
from the deploy.**

**What to do instead.** Infisical is the source of truth for these, at path
`/config`, per environment — the same store the six variables above come from,
and unlike Fly secrets it is provider-neutral, which is the whole reason it
holds them.

```bash
PROJECT="$(node -pe 'require("./infra/infisical/.infisical.json").workspaceId')"

# Generate the app's env file from Infisical. NOT committed, and regenerate it
# rather than editing it — Infisical is the source of truth, this is a copy.
infisical export --projectId "$PROJECT" --env production --path /config \
  --format dotenv --output-file /opt/spiralclass/app.env
chmod 600 /opt/spiralclass/app.env
```

Then give the app service `env_file: /opt/spiralclass/app.env` in the compose
file. That puts the values in the **container environment**, which is what the
entrypoint's only-if-unset rule reads — the same mechanism Fly secrets use, from
a different source.

**Verify, because the failure is silent.** After the container is up:

```bash
docker compose exec <app-service> sh -lc \
  'for k in GOOGLE_CLIENT_ID GEMINI_VERTEX_PROJECT_ID LIVEKIT_API_KEY \
            STRIPE_PRICE_MONTHLY STRIPE_PRICE_ANNUAL STRIPE_PRICE_FOUNDING \
            STRIPE_BILLING_PORTAL_CONFIG_ID SENTRY_DSN POSTHOG_KEY; do
     v=$(printenv "$k" || true)
     case "${v:-UNSET}" in UNSET|__LOCAL__) echo "MISSING: $k" ;; esac
   done; echo "check complete"'
```

**Every one of the nine must be present and not `__LOCAL__`.** A clean run
prints only `check complete`. ⚠️ **Do not treat a quiet boot as a passing
boot** — a quiet boot is exactly what a missing value looks like.

### The two URLs on this box that name the app, and the outage they caused

`APP_INTERNAL_BASE_URL` is in that list but is **not a secret** — it is a
plain origin, and it is one of exactly two places on this box that name the
Next.js app. Both must be the canonical origin, `https://spiralclass.com`:

- **`.env` line 6 — `APP_INTERNAL_BASE_URL=https://spiralclass.com`.** The
  captions agent posts room-config here once per room and again on a 60-second
  poll.
- **`livekit.yaml`, the `webhook` section — `https://spiralclass.com/api/livekit/webhook`.**
  livekit-server posts room and participant events here.

**Neither is rewritten by anything.** The [D-138](../decisions/D-138.md) rename
swept 934 files in the repo and could not touch this box, so both were left on
`https://agendaprofe.com` and both broke on 2026-08-30. `agendaprofe.com` is
retained and 301s to the new domain, and a 301 turns a POST into a GET, so:

- The captions agent's POST became a GET against a POST-only route and got
  **405**. `discovery.ts` only starts a `RoomWorker` when room-config comes
  back enabled, so on a null it starts none and **publishes no captions at
  all**. One real class ran with subtitles silently dead before this was found.
- livekit-server's webhooks never reached the app. It logs `sent webhook` on a
  301, so **the failure is invisible from the box** — the tell is the `url`
  field in its own log line, not an error. That endpoint is the completion
  signal for lesson-insights Phase A and for finalizing recordings.

> [!IMPORTANT]
> **Changing either value needs a restart, and they differ.** `.env` is read by
> compose substitution, so the agent needs `docker compose up -d captions-agent`
> to be **recreated** — a plain `restart` re-runs the old environment.
> `livekit.yaml` is a mounted file, so compose sees no change at all and
> `docker compose restart livekit` is required. **Restarting livekit-server
> disconnects everyone in a live class** (they auto-reconnect in a few seconds),
> so check for live rooms first — and check _occupancy_, not recent join events.
> A participant who joined ten minutes ago and is still talking produces no
> recent log line. That mistake was made on 2026-08-30 and dropped one
> participant mid-call.

**Two HetrixTools monitors now cover the app half of both paths** (see
`scripts/local/synthetic.sh`'s MOVED block for why they live there rather than
in that file). Note what they do and do not catch: they prove the two routes
are alive and answering **directly** on the canonical origin, because
`max_redirects` is 0 and the only accepted code is 405 — so a 301 fails them.
They **cannot** see this box's config, so they would not have caught this
outage. Nothing external can. The box's copy of these two URLs is checked by
reading it here.

## Networking

### Firewall, as observed

`iptables -S INPUT` on the box:

```
-P INPUT ACCEPT
-A INPUT -j ts-input
-A INPUT -m state --state RELATED,ESTABLISHED -j ACCEPT
-A INPUT -p icmp -j ACCEPT
-A INPUT -i lo -j ACCEPT
-A INPUT -p tcp -m state --state NEW -m tcp --dport 22 -j ACCEPT
-A INPUT -p udp -m udp --dport 50000:60000 -m comment --comment "LiveKit RTC media + TURN relay" -j ACCEPT
-A INPUT -p udp -m udp --dport 3478 -m comment --comment "LiveKit embedded TURN" -j ACCEPT
-A INPUT -p tcp -m tcp --dport 7881 -m state --state NEW -m comment --comment "LiveKit RTC TCP fallback" -j ACCEPT
-A INPUT -p tcp -m tcp --dport 80 -m state --state NEW -m comment --comment "ACME HTTP-01 challenge" -j ACCEPT
-A INPUT -p tcp -m tcp --dport 443 -m state --state NEW -m comment --comment "LiveKit signaling (Caddy/wss)" -j ACCEPT
-A INPUT -j REJECT --reject-with icmp-host-prohibited
```

**The OCI security list must open the same ports**, and it is a separate
control plane from iptables — opening one without the other produces a box
that looks correct and drops media. Ports: TCP 80, 443, 7881; UDP 3478 and
50000-60000.

> [!WARNING]
> **Do not let OCI's default security list stand.** The default opens `:22` to
> `0.0.0.0/0`, which is the M-5 finding. SSH here is Tailscale-only and the
> world-open rule must be removed. The deleted module gave `ssh_ingress_cidr`
> no default on purpose, for exactly this reason — that was a security
> decision, not a missing parameter, and it does not survive in code any more.

**RTC media bypasses Caddy entirely.** Only signaling (wss, :443) and the ACME
challenge (:80) go through it.

## TLS, and the part that will bite

`Caddyfile`, in full:

```
livekit.spiralclass.com {
	reverse_proxy 127.0.0.1:7880
}
```

**`livekit.agendaprofe.com` was dropped on 2026-08-29**, completing the
[D-138](../decisions/D-138.md) rename — removed from this file, reloaded, and
its Cloudflare DNS record deleted. It was served only until `LIVEKIT_URL`
moved, and `config/env/production.runtime.env` has read
`wss://livekit.spiralclass.com` since the cutover.

> [!WARNING]
> **One condition was NOT met when it was dropped, and this is the honest
> record of it.** D-138 said the old name could go once `LIVEKIT_URL` had moved
> **and** a real class had connected on the new one. The first is true; the
> second was not — `livekit-server` logged **zero participant or room events in
> the preceding 72 hours**, so no class has yet proven the new hostname end to
> end. The drop was made anyway, deliberately, on the operator's instruction.
>
> **What this costs is rollback speed, not reversibility.** Falling back used
> to be an env change and a deploy. It now also needs the Cloudflare A record
> re-created (`livekit` → the box IP, proxied) and the hostname re-added to
> this file plus `caddy reload`. The old certificate is still in the
> `caddy_data` volume until it expires 2026-10-19, so no re-issuance is needed
> if the fallback happens before then.

**Certificates as observed 2026-08-29**, read from `caddy_data`:

| Certificate               | Not after            | Caddy's ARI-selected renewal                   |
| ------------------------- | -------------------- | ---------------------------------------------- |
| `livekit.spiralclass.com` | 2026-11-27 15:21 UTC | 2026-10-28 (window 10-27 → 10-29)              |
| `livekit.agendaprofe.com` | 2026-10-19 05:57 UTC | no longer renewed — dropped from the Caddyfile |

Those renewal times are Caddy's own, from ACME Renewal Information, not an
estimate from the 90-day lifetime.

### Why renewal is the risk

The 2026-08-29 certificate for `livekit.spiralclass.com` was obtained by
**tls-alpn-01**, and that only worked because the DNS record was temporarily
grey-clouded. **Both records are proxied again**, and tls-alpn-01 cannot work
through Cloudflare's proxy — the challenge handshake terminates at the edge,
not at Caddy. **Every future renewal must therefore fall back to http-01.**

The http-01 path was verified end-to-end on 2026-08-29 and it does work:

- Cloudflare forwards plain-HTTP `/.well-known/acme-challenge/` to the origin
  without redirecting at the edge — confirmed by the request arriving in
  Caddy's log from a Cloudflare edge address.
- Caddy's http-01 solver is live and inspects those requests
  (`"looking up info for HTTP challenge"`), falling through to its own 308
  only because the probe token was not a real challenge.
- iptables and the OCI security list both open :80 for it.

> [!CAUTION]
> **`Always Use HTTPS` must stay OFF on both Cloudflare zones, and SSL mode
> must stay Full.** Turning on Always Use HTTPS makes the edge answer the ACME
> challenge with a redirect, http-01 fails, and — because tls-alpn-01 is
> already impossible through the proxy — **renewal fails silently until the
> certificate expires and every class stops.** This is
> [D-134](../decisions/D-134.md)'s risk, and it is now the _only_ remaining
> path rather than one of two.
>
> **This invariant is a probe, not just this paragraph.** `pnpm local
synthetic` asserts the challenge path is answered by Caddy (308) rather than
> by a Cloudflare edge redirect (301). Do not rely on remembering it.

> [!CAUTION]
> **A naive external monitor cannot see this certificate.** Both hostnames
> present _Cloudflare's own_ edge certificate to the public internet — verified
> 2026-08-29: `CN=spiralclass.com` expiring 2026-11-25 and
> `CN=agendaprofe.com` expiring 2026-11-22, neither of them the Caddy
> certificate above. Cloudflare renews those automatically, so a hostname-based
> SSL-expiry check stays green straight through an origin expiry.
>
> **The way round it is to connect to the origin IP with SNI**, which is what
> `scripts/local/synthetic.sh` already does. Two probes there cover this:
>
> - **`LiveKit origin cert`** reads the real certificate and fails under 21
>   days remaining. This is a _lagging_ signal — Caddy renews at roughly 30
>   days out, so it only fires once renewal has already been failing for over a
>   week.
> - **`ACME HTTP-01 challenge path`** fails the moment the path breaks, weeks
>   before any certificate is at risk. This is the one that gives useful
>   warning.
>
> ⚠️ **Neither runs on a clock.** There is no cron and no systemd timer on the
> box — verified, both crontabs are empty — and [D-129](../decisions/D-129.md)
> deleted every scheduled
> workflow, so these run by hand and on `pnpm promote`. `pnpm gate` nags when
> the `synthetic` receipt goes stale after 7 days, which is the dead-man's
> switch, but it only nags at a push. **A month without pushing is a month
> without either probe**, and the first signal would again be a teacher
> reporting that a class will not connect.

To read the real expiry, you must look on the box:

```
sudo openssl x509 -noout -subject -dates -in \
  /var/lib/docker/volumes/oracle-livekit-production_caddy_data/_data/caddy/certificates/\
acme-v02.api.letsencrypt.org-directory/livekit.spiralclass.com/livekit.spiralclass.com.crt
```

Caddy's ACME account is `3553706575` on Let's Encrypt production. A staging
account also exists in the volume, which is the safe way to rehearse an
issuance without spending a production rate limit.

## Rebuild

Roughly two to four hours, and it is all by hand.

1. **Create the instance.** `VM.Standard.A1.Flex`, 2 OCPU / 12 GB, 50 GB boot,
   Ubuntu 24.04 ARM, in the existing VCN and public subnet with its internet
   gateway. Capacity for Always Free ARM is frequently unavailable — expect to
   retry.
2. **Fix the security list** before anything else: open TCP 80/443/7881 and
   UDP 3478 + 50000-60000; remove the default world-open `:22`.
3. **First-boot provisioning** — use
   [`oracle-livekit-cloud-init.sh`](./oracle-livekit-cloud-init.sh), which
   installs Docker, Tailscale, git and gh. **Do not use
   `oracle-runner-cloud-init.sh`** — that is the retired CI-runner toolchain,
   kept for history only.
   [`oracle-cloudshell-provision.sh`](./oracle-cloudshell-provision.sh) and
   [`oracle-launch.sh`](./oracle-launch.sh) cover launching from OCI Cloud
   Shell.
4. **Join the tailnet** with `tailscale_authkey_oracle`, enable Tailscale SSH,
   then **disable key expiry for the node** in the admin console.
5. **Restore the stack directory.** Recreate
   `/home/ubuntu/oracle-livekit-production/` with the five files above, and
   `/home/ubuntu/agendaprofe` with enough of this repo to build the captions
   agent. Restore `.env`, `livekit.yaml` and `egress.yaml` from Infisical at
   mode 600.
6. **Point DNS at the new IP, grey-clouded**, and bring the stack up with
   `docker compose up -d --build`. Grey-clouded first, so Caddy can obtain
   certificates by tls-alpn-01 without the proxy in the way.
7. **Verify a class connects**, then re-proxy the records (orange cloud) and
   confirm `Always Use HTTPS` is off and SSL mode is Full on both zones.
8. **Re-check the certificate on the box**, not from outside.

### Reboots

There is **no systemd unit and no cron entry for this stack.** It comes back
after a reboot solely because `docker.service` is enabled and every service is
`restart: unless-stopped`. Unattended-upgrades is installed with automatic
reboot left at its default of false, so kernel updates wait for a manual
reboot — which is why the box had 38 days of uptime when this was written.

## Where the box and the deleted module disagreed

Recorded because the disagreement is the evidence for
[D-139](../decisions/D-139.md):

- **The module was never applied and had no state.** Its README claimed a
  `tofu apply` reproduces the box. On 2026-08-29 a session believed that claim
  and twice proposed applying the module to fix a missing certificate — which
  would have edited a template while production stayed broken. The real fix
  was a hand edit of the `Caddyfile` over Tailscale SSH plus
  `docker exec livekit-caddy caddy reload`.
- **The module's `services/Caddyfile` and the box's differ.** The box's is
  authoritative.
- **`docker-compose.yml` on the box still contains a comment** saying the
  Tofu module "isn't managing this box yet" and that the hand-added captions
  agent matches "the module's intended service definition once Tofu import
  happens later." **That import is now cancelled**; the comment is stale and
  is left in place only because editing the live compose file for a comment
  means touching production for no functional reason.
