# Cutover: destroying and rebuilding the box

Written **before** the old box was destroyed, so that nothing here is improvised
while live video is down. Follow it in order.

> [!IMPORTANT]
> **What this box carries, since the 2026-09-04 topology decision:** the
> LiveKit stack, the preview web app and preview's Postgres. **The production
> web app stays on Fly and production's database stays on Neon** — see D-150's
> second addendum. So the outage this procedure risks is **live classes**, not
> the site: `spiralclass.com` is served by Fly throughout and its DNS record is
> never touched here.

> [!CAUTION]
> **Step 3 is the one-way door, and there is no rollback.** The old boot
> volume is deleted with the instance, deliberately (operator's decision,
> 2026-09-04) — the new box takes the whole 200 GB allowance, and 200 + 47
> does not fit under the limit, so the two choices are one choice.
>
> The fallback is therefore `~/oracle-capture-2026-09-04` plus this document,
> not a volume. That is a smaller loss than it appears: a preserved boot
> volume only helps if an instance can be launched to attach it to, and the
> failure actually in play here is "Out of host capacity", where a spare
> volume is worth nothing.
>
> ⚠️ **If capacity is unavailable after step 3, LiveKit is down until Oracle
> has hardware.** Accepted on the basis that no classes are booked until
> Monday morning.

## 0. Before anything — confirm the capture is real

The capture is at `~/oracle-capture-2026-09-04`. It is **outside the repo**,
because that repo goes public.

```bash
cd ~/oracle-capture-2026-09-04
tar -tzf stack.tar.gz | wc -l        # config + every .bak
tar -tzf caddy_data.tar.gz | grep -c crt   # certificates
ls -l tailscale-authkey image-digests.txt
```

⚠️ `caddy_data.tar.gz` is the one that cannot be regenerated: it holds the ACME
account key and the live certificate for `livekit.spiralclass.com`. Without it
that hostname needs a fresh issuance through Cloudflare's proxy, which is the
most fragile step there is.

⚠️ **Confirm its SHAPE, not just that it is a file.** `oracle-deploy.sh` now
asserts this after unpacking, but check it here too, where a bad archive costs
nothing:

```bash
tar -tzf caddy_data.tar.gz | head -3
```

The first entries must be `./caddy/...` or `caddy/...`. If they are
`var/lib/docker/volumes/...`, the archive was built from an absolute path and
unpacks to the wrong depth. Rebuild it, from the old box, while it still
exists: `tar -czf - -C /var/lib/docker/volumes/oracle-livekit-production_caddy_data/_data .`

### The three things that lock you out, none of which the terminate frees

⚠️ **Tailscale is the ONLY way into the new box, and all three of these are
checkable now and unrecoverable-in-a-hurry later.** :22 is closed to the
internet, so a miss here means the OCI serial console at 2am.

1. **The auth key is reusable and unexpired.** Tailscale auth keys default to
   90 days and single use. If the captured key is either, `tailscale up` in
   cloud-init fails — non-fatally, so the box finishes provisioning and simply
   never appears. Check it in the admin console under Settings → Keys, and
   mint a fresh reusable one if there is any doubt.
2. **The tailnet ACL's `ssh` rule matches the NEW hostname.** The box is
   deliberately renamed `oracle-a1-runner` → `spiralclass-box`
   (`var.name_prefix`). If that rule is scoped by node name rather than by
   tag, `tailscale status` will show a healthy node while
   `ssh ubuntu@spiralclass-box` is refused and `oracle-deploy.sh` dies in
   preflight, having done nothing.
3. **`vcn-count` has room for one more VCN.** This is the one limit the
   terminate does NOT free: the old `ap-runner-vcn` survives it and this
   module builds its own, so the apply needs headroom that destroying the box
   does not create.

```bash
oci limits resource-availability get --compartment-id "$T" \
  --service-name vcn --limit-name vcn-count
```

## 1. Take the last look at the old box

```bash
ssh ubuntu@100.64.0.1 'docker ps; df -h /; uptime'
```

Anything you want off it, take now.

## 2. Prove the module BEFORE the door

⚠️ **`tofu init` and `tofu plan` come first, and this is a correction.** An
earlier version of this document put both inside step 4, under a warning that
read "the moment to discover a missing provider is not after the one-way
door" — while prescribing exactly that. `init` downloads roughly 100 MB of
oracle provider; that download, the state path, and the plan are all things
that can fail, and all of them are free to discover while the old box is still
carrying classes.

```bash
oci session authenticate --region mx-queretaro-1 --profile-name DEFAULT

cd infra/oracle-box
export TF_VAR_compartment_id=<tenancy ocid>
export TF_VAR_tailscale_authkey="$(cat "$HOME/oracle-capture-2026-09-04/tailscale-authkey")"

STATE="$HOME/.tofu-state/spiralclass/oracle-box.tfstate"
tofu init
tofu plan -state="$STATE"
```

Expect **7 to add, 0 to change, 0 to destroy**. Anything else — especially
anything to destroy — stop and read it, because at this point stopping is
still free.

> [!CAUTION]
> **`$HOME`, never `~`, and always quoted.** No shell expands a tilde after
> `=` in a non-assignment word, so `-state=~/.tofu-state/…` is taken
> literally. OpenTofu then creates the directory and **succeeds**, writing
> the state for the box that carries every live class to a literal
> `infra/oracle-box/~/.tofu-state/spiralclass/` inside this checkout.
>
> The damage is not disclosure — the root `.gitignore` already covers
> `*.tfstate`, so it would never be committed. It is worse in a quieter way:
> the state ends up somewhere nobody looks, git does not show it, and every
> later `plan` run the documented way finds **no state at all** and proposes
> creating all seven resources again — against a tenancy that has room for
> none of them. The failure surfaces as a baffling plan, not as a missing
> file.
>
> Do this plan first and the mistake is a stray directory you can delete
> while the old box is still serving.

## 3. ⚠️ Destroy — volume and all

```bash
oci compute instance terminate \
  --instance-id ocid1.instance.oc1.<region>.<redacted> \
  --preserve-boot-volume false
```

⚠️ **`false`, deliberately.** The new box claims the entire 200 GB
block-storage allowance and the old volume is 47 GB, so keeping it would put
the tenancy at 247 of 200 and the apply would fail. Confirm you want this
before running it: after this command the old machine does not exist in any
form, and step 0's capture is the only copy of anything that was on it.

Then wait for **both** allowances to come back, not just the cores. The apply
needs cores AND the full 200 GB, and the volume is released a little after the
instance is:

```bash
T=<tenancy ocid>
AD="benl:MX-QUERETARO-1-AD-1"

oci limits resource-availability get --compartment-id "$T" \
  --service-name compute --limit-name standard-a1-core-count --availability-domain "$AD"
# wait for available: 2

oci limits resource-availability get --compartment-id "$T" \
  --service-name compute --limit-name standard-a1-memory-count --availability-domain "$AD"
# wait for available: 12 — the cores and the memory are SEPARATE limits and
# both are consumed; waiting only on cores can start an apply that then fails.

oci limits resource-availability get --compartment-id "$T" \
  --service-name block-storage --limit-name total-storage-gb --availability-domain "$AD"
# wait for available: 200 — NOT 153. If it stalls at 153 the boot volume
# survived the terminate; delete it explicitly with `oci bv boot-volume delete`
# or the apply will fail on the storage limit.
```

## 4. Apply

⚠️ **Refresh the OCI session first.** `oci session authenticate` issues a token
that lasts an hour. When it lapses the CLI does not fail cleanly — it hangs, so
a stalled command here means an expired credential, not a slow API.

The environment is the one from step 2. `init` has already run and the plan has
already been read; this is the apply alone.

```bash
oci session refresh --profile DEFAULT     # or re-run session authenticate

cd infra/oracle-box
export TF_VAR_compartment_id=<tenancy ocid>
export TF_VAR_tailscale_authkey="$(cat "$HOME/oracle-capture-2026-09-04/tailscale-authkey")"

STATE="$HOME/.tofu-state/spiralclass/oracle-box.tfstate"
tofu plan  -state="$STATE"     # re-read it: the limits have changed since step 2
tofu apply -state="$STATE"
```

⚠️ **The boot volume is 200 GB — the whole allowance, on one volume.** No other
volume can exist alongside it. Nothing needs one, but if a volume operation
ever fails on this tenancy, that is why.

⚠️ **The old VCN survives the terminate and is never cleaned up.** Terminating
an instance deletes no networking, and this module builds its own VCN — so
afterwards the tenancy holds both `ap-runner-vcn` and `spiralclass-box-vcn`,
using the _same_ 10.0.0.0/16 and 10.0.1.0/24. Harmless (they do not peer), but
it counts against `vcn-count` — which is why step 0 checks that limit before
the door, since it is the only one the terminate does not free. Leaving a
second VCN with identical CIDRs lying around is also exactly the kind of thing
that confuses the next reader: delete the old VCN, its subnet and its gateway
once the new box is serving.

⚠️ **"Out of host capacity" is a normal answer.** Re-run. Do not change the
shape to something smaller to get past it without deciding that deliberately —
a 1 OCPU box will not carry egress.

Note the `public_ips` output. That is the address DNS will point at, and
because it is **reserved**, it is the last time this ever changes.

## 5. Disable Tailscale key expiry — before you forget

Admin console → Machines → `spiralclass-box` → disable key expiry.

⚠️ cloud-init cannot do this. Skip it and SSH lapses 180 days from now on a
date nobody has written down. The old box only survived because someone
turned it off by hand.

## 6. Push the images, then deploy

The box builds nothing.

⚠️ **Two images, not three. The production web app is not on this box** — it
is on Fly and `scripts/fly-deploy.sh` ships it, unchanged, throughout this
procedure. Do not push it here.

⚠️ **Use the same tag everywhere.** The images built on 2026-09-04 carry both
a commit-SHA tag and `:latest`, and the capture's own `verify-capture.sh`
checks the `:latest` ones. Push one tag and reference a different one and
compose tries to pull a nonexistent image from Docker Hub. Read the tag off
`docker images` rather than typing it.

⚠️ **`APP_IMAGE_PREVIEW` must be a PREVIEW build, and the deploy script now
refuses to start without it** — there is no production image on the box to
fall back to any more. Every `NEXT_PUBLIC_*` is baked at build time, so a
production build permanently carries `NEXT_PUBLIC_DEPLOY_ENV=production`;
`apps/web/next.config.ts` feeds that to `buildSecurityHeaders`, which emits
`X-Robots-Tag: noindex, nofollow` **only** for a non-production deploy. Run one
here and `preview.spiralclass.com` — Cloudflare-proxied, public, full of seeded
teachers — is crawlable, with production's Stripe publishable key, Sentry DSN
and PostHog key in its browser bundle.

```bash
WEB_PREVIEW=spiralclass-web-preview:latest
CAP=agendaprofe-captions-agent:latest

./scripts/oracle-push-images.sh "$WEB_PREVIEW" "$CAP"

export APP_IMAGE_PREVIEW="$WEB_PREVIEW"
export CAPTIONS_AGENT_IMAGE="$CAP"
./scripts/oracle-deploy.sh --restore-caddy
```

If no preview image has been built on the night, **grey-cloud
`preview.spiralclass.com` and leave preview down** rather than reaching for the
production image. Preview being absent for a day costs a day of UAT;
preview serving a production build costs an indexable seeded site with
production client keys in it.

`--restore-caddy` is only for this first run; it puts the ACME account key and
the LiveKit certificate back.

### Preview's database is empty until you migrate it

The deploy points preview at the Postgres container beside it rather than at
Neon, so on a fresh box that database has **no schema and no data**. Preview
will start and fail every query until it is migrated and seeded.

> [!CAUTION]
> **Do this from the LAPTOP, through a tunnel. Not with `docker exec`.**
>
> An earlier version of this step said
> `docker exec spiralclass-preview pnpm --filter spiralclass-web prisma migrate deploy`.
> That cannot work, and it fails after the one-way door. The runtime image is
> the `runner` stage of `Dockerfile`, which copies only `.next/standalone`,
> `.next/static`, `public/`, `config/env/*.runtime.env` and
> `docker-entrypoint.sh` — there is no `pnpm`, no `prisma` CLI, no
> `schema.prisma` and no workspace manifest for `--filter` to resolve. It
> exits `pnpm: not found`, and if that is read as noise the preview database
> ends the cutover with an empty schema.
>
> The laptop has the whole toolchain. Preview's Postgres publishes on the
> box's loopback, so one `ssh -L` reaches it.

```bash
# The password is on the box; the deploy script put it there and reuses it.
PGPW="$(ssh ubuntu@spiralclass-box \
  "sed -n 's/^PREVIEW_DB_PASSWORD=//p' /home/ubuntu/oracle-livekit-production/.env" \
  | sed 's/\$\$/$/g')"

# postgres-preview publishes on 127.0.0.1:5432 of the box, not the tailnet.
ssh -f -N -L 55432:127.0.0.1:5432 ubuntu@spiralclass-box

export DATABASE_URL="postgresql://spiralclass_preview:${PGPW}@127.0.0.1:55432/spiralclass_preview"
export DIRECT_URL="$DATABASE_URL"
pnpm --filter spiralclass-web exec prisma migrate deploy
```

Then reseed. ⚠️ `SEED_OPERATOR_EMAIL` and `SEED_PILOT_TEACHER_EMAIL` must be
set in preview's Infisical **first** — a reseed without them loses the tester's
UAT account, which is a separate item already on the board.

> [!CAUTION]
> **`pnpm seed:preview` and `pnpm reset:preview` still point at NEON, and
> nothing in this migration changed that.**
>
> Both scripts (`infra/infisical/seed-preview.sh`,
> `infra/infisical/reset-preview.sh`) call `infisical_export_secrets
DATABASE_URL DIRECT_URL` against Infisical's `preview` environment, which
> still holds the Neon URL. Only the CONTAINER was repointed, by
> `preview-db.env` appended to `preview.app.env`.
>
> So after the cutover those two commands exit 0 having done nothing useful:
> `seed:preview` writes rows into an orphaned Neon database the app no longer
> reads, and `reset:preview` runs `prisma migrate reset --force` — a
> destructive drop-and-recreate — against it. Meanwhile the box's database
> stays empty.
>
> Until Infisical's preview `DATABASE_URL`/`DIRECT_URL` are repointed, seed
> through the same tunnel with the two variables exported as above, and treat
> a bare `pnpm reset:preview` as a command that destroys the wrong database.

⚡ This is the one part of the migration with no rollback story of its own, and
it is fine: preview's data is seeded and disposable, which is the entire reason
D-150's objection to colocating Postgres does not apply to it. If that ever
stops being true, the decision needs re-opening.

## 7. ⚠️ Verify before DNS, not after

Everything here works over the tailnet with no public DNS involved, which is
the whole point of doing it in this order.

- **The nine runtime values**, in preview. The deploy script does this and
  fails on it. ⚠️ A missing value produces no error anywhere — the entrypoint
  refuses to export a `__LOCAL__` and the app boots clean without sign-in,
  checkout or LiveKit. Do not read a quiet boot as a passing one.
- **The callback into production, which now leaves the box.** livekit-server's
  webhook and the captions agent both post to `https://spiralclass.com`, on
  Fly, through Cloudflare — the 2026-08-30 path. The deploy script probes it
  and **fails on any 3xx**; run it by hand too, since it costs one command:

  ```bash
  ssh ubuntu@spiralclass-box \
    'curl -s -o /dev/null -w "%{http_code}\n" -X POST https://spiralclass.com/api/livekit/webhook'
  ```

  **401 is the pass** — the route was reached and rejected an unsigned body.
  ⚠️ Anything in the 3xx range is the 2026-08-30 outage: a 301 turns the
  agent's POST into a GET, it gets a 405, `discovery.ts` starts no RoomWorker,
  and classes run with captions silently dead while livekit-server's log says
  `sent webhook`. Do not carry on past a redirect; fix the hostname.

- **PREVIEW's own route to LiveKit.** `LIVEKIT_URL` is
  `wss://livekit.spiralclass.com` and can never be loopback — the same value is
  what the browser connects to. So the preview app — on a docker bridge network
  on this box — resolves a public name that now points at this same box, leaves
  it, and comes back. That depends on Cloudflare's proxy state, on this box's
  egress, and while a name is grey-clouded on OCI hairpinning a bridged
  container's traffic to the instance's own reserved address. None of it is
  true by construction, and when it is false livekit-server looks perfectly
  healthy while no class can be created on preview.

  ```bash
  ssh ubuntu@spiralclass-box \
    '/home/ubuntu/oracle-livekit-production/verify-app-egress.sh spiralclass-preview'
  ```

  ⚠️ **Expected to FAIL here**, because DNS has not moved yet — the deploy
  script runs it and warns rather than failing for that reason. It is the
  gate on step 8.5: do not re-proxy until it passes.

  ⚡ **Production asks LiveKit the same question from Fly**, over the ordinary
  internet, and has been answering it correctly for months — but it answers it
  against a NEW address once step 8 moves `livekit.spiralclass.com`. Booking a
  real class in step 8.4 is what proves that, and it is the check that matters
  most on the night.

- **The root filesystem actually grew to 200 GB.** `df -h /` on the box.
  cloud-init's growpart is what turns `boot_volume_gb = 200` into a 200 GB
  root, and nothing else notices if it does not — the IOPS reason for taking
  the whole allowance still holds at the volume level, so the box feels fine
  right up until a deploy fills 47 GB. The deploy script warns below 150 GB.

- **The database latency D-150 requires.** Take it here, over the tailnet,
  before DNS moves. D-150 says in as many words that the migration must not cut
  DNS before the real number replaces its 1.3-second estimate, and that the
  decision should be re-opened if it comes back far worse.

## 8. DNS, and the certificate trap

> [!IMPORTANT]
> **Two records move, and `spiralclass.com` is not one of them.** The apex
> keeps pointing at Fly for the whole of this procedure — production never
> changes address, so the site cannot be taken down by anything in this step.
> What moves is `livekit.spiralclass.com` and `preview.spiralclass.com`.

⚠️ **One of the two has no certificate.** `caddy_data` carries
`livekit.spiralclass.com` only. `preview.spiralclass.com` is new to Caddy and
must be issued — and tls-alpn-01 cannot work through Cloudflare's proxy, so
http-01 is the only path.

That makes D-134's invariant govern both: **"Always Use HTTPS" must be OFF and
SSL mode must be Full on the zone.** Turn it on and issuance fails silently
until the certificate expires and every class stops.

Order:

1. Point the **two** A records at the reserved IP, **grey-clouded**. ⚠️ Not the
   apex — leave `spiralclass.com` on Fly.
2. Watch Caddy obtain preview's certificate.
3. Re-run preview's LiveKit probe from step 7 — `verify-app-egress.sh
spiralclass-preview`. It has to pass before anything else here means much:
   livekit-server serving correctly and an app unable to reach it look
   identical from outside.
4. **Verify a real class connects on `livekit.spiralclass.com` — from
   production, on Fly.** ⚡ This is the check that matters most on the night:
   it is the one that proves the machine change reached the thing users
   actually do, from the deployment that actually serves them.
5. Re-proxy (orange cloud).
6. Re-run preview's probe a third time. Re-proxying changes the path it tests —
   grey-clouded it goes to this box's own address, orange-clouded it goes to
   Cloudflare and back — so a pass before the flip is not a pass after it.
7. Confirm `Always Use HTTPS` is off and SSL mode is Full on the zone.
8. Re-read the certificates **on the box** — both hostnames present
   Cloudflare's own edge certificate to the public internet, so an external SSL
   check stays green straight through an origin expiry.

## 9. Afterwards

- **Revoke the Tailscale auth key** used here and issue a fresh one, then store
  it in Infisical as `tailscale_authkey_oracle` — which makes
  `ORACLE_BOX_REBUILD.md`'s claim true for the first time. ⚠️ The key used for
  this rebuild was displayed in a session transcript.
- **Rotate the LiveKit API key pair.** It was also exposed in that transcript,
  and rotating is cheapest now, while `livekit.yaml` is being rewritten anyway.
- ⚠️ **Take the NOT-APPLIED banner off `infra/oracle-box/README.md`** — it is
  the whole price of having merged this module before applying it (D-150's
  third addendum), and it is worthless if it outlives the apply. A reader who
  finds a banner that is no longer true stops believing the next one.
- **Put the deploy on GitHub Actions, which is where it belongs** (operator,
  2026-09-04: every deploy runs through Actions). Three things are needed and
  none of them exists yet, so board them rather than improvising on the night:
  a **Tailscale OAuth client** so the runner can reach a box whose `:22` is
  closed to the internet; an **Infisical machine identity**, since
  `oracle-deploy.sh` renders config from Infisical and a runner has no
  operator session to borrow; and the **GHCR** build-and-push that replaces
  `oracle-push-images.sh`, on an `ubuntu-24.04-arm` runner. Restoring
  `deploy-preview.yml`'s push trigger against this box is the last step of
  that, not the first — see D-157's addendum, and invert the `runs-on` guard
  rather than deleting it.
- **Repoint Infisical's preview `DATABASE_URL` and `DIRECT_URL`** at the box's
  Postgres, or delete the orphaned Neon preview project. Until one of those
  happens, `pnpm seed:preview` seeds a database nothing reads and
  `pnpm reset:preview` destructively resets it — see step 6.
- **Migrate the state** off the local file to R2.
- **Sweep the old names.** `oracle-a1-runner` still appears in the repo, and
  it is the only one left: the addresses and the instance OCID are placeholders
  as of D-158. ⚠️ **The repository is published from this tree**, so anything
  added back here is added in public — see `scripts/check-no-identifiers.sh`.
- **Update `ORACLE_BOX_REBUILD.md`.** Its "Rebuild" section is what this file
  replaces, and D-150 said so.
