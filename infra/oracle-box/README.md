# The Oracle A1 box, in OpenTofu

Replaces the deleted `infra/oracle-runner` module ([D-139](../../docs/decisions/D-139.md)),
under the reversal [D-150](../../docs/decisions/D-150.md) allowed.

> [!CAUTION]
> ⚠️ **THIS MODULE HAS NOT BEEN APPLIED. NO STATE FILE EXISTS. NO BOX MATCHES
> IT.** Read every file here as a proposal, never as a description of a
> machine — and in particular, **do not run `tofu apply` to "fix" a problem
> with the live box.** There is a live box; this does not describe it.
>
> That is D-139's exact fault, committed knowingly. [D-150](../../docs/decisions/D-150.md)
> forbade committing this before an apply precisely to avoid it, and its third
> addendum waives that condition for one reason: the repository's history is
> being rewritten into a NEW public repository, and a branch that is not on
> `main` when that happens is stranded on the private archive. The cost of the
> waiver is this banner, and **the banner comes off in the same change that
> follows the first successful apply** — see
> [`CUTOVER.md`](./CUTOVER.md)'s closing section.
>
> How to tell, rather than trusting this paragraph: there is no
> `$HOME/.tofu-state/spiralclass/oracle-box.tfstate`, and `tofu plan` against
> the tenancy answers **7 to add**. Once it answers **0 to add, 0 to change**,
> this box is described by this module and the banner is wrong.

## What this builds, and what it does not

**Builds:** one VCN, one internet gateway, the default route table and
security list, one public subnet, one `VM.Standard.A1.Flex` instance, and one
**reserved** public IP attached to it. Seven resources.

**Does not:** deploy anything. Docker, Tailscale, the firewall and swap come
from `cloud-init.yaml.tftpl`; the LiveKit stack, the preview web app and
preview's Postgres come from `scripts/oracle-deploy.sh`, which is re-runnable
and is what CI invokes. A box that must be rebuilt to change what it runs is
the box this replaced.

**Does not:** carry production. The production web app is on Fly and
production's database is on Neon — the 2026-09-04 topology decision, in
[D-150](../../docs/decisions/D-150.md)'s second addendum. This box holds
LiveKit, preview and preview's data, and losing it stops classes rather than
stopping the site.

**Does not:** touch Cloudflare. D-139 deleted `infra/cloudflare` because its
Access application was made by hand, so a first apply would create a second
one beside it rather than adopt it. The DNS records here have the same
problem, so they stay a hand operation and the reserved IP above is what makes
that a one-time cost rather than a recurring one.

## The two facts that shape it

**Oracle halved the Always Free A1 allowance.** Measured 2026-09-04 against
the tenancy, not inferred: `standard-a1-core-count` is **2**, used 2,
**available 0**; `standard-a1-memory-count` is **12**, used 12, available 0.
Earlier records, and [D-150](../../docs/decisions/D-150.md)'s reasoning, both
assumed 4 and 24. That is no longer true.

⚠️ **So the old box must be destroyed before this can be applied.** There is
no capacity for a second instance and no price that buys one — a launch is
_rejected by the service limit_, not billed. `for_each` and the `primary` key
survive in `main.tf` for a blue-green that is not reachable today.

⚠️ **The old box's public IP was ephemeral and is gone.** It died with the
instance and OCI has no operation to convert an ephemeral address to a
reserved one. This module spends the tenancy's single reserved
public IP (`reserved-public-ip-count` = 1, 0 used) so the address survives the
_next_ rebuild and DNS never has to move again.

## Running it

```bash
# A token session, not an API key — see the provider block in main.tf.
oci session authenticate --region mx-queretaro-1 --profile-name DEFAULT

export TF_VAR_compartment_id=<tenancy ocid>
export TF_VAR_tailscale_authkey="$(cat /path/to/authkey)"

# ⚠️ $HOME, never ~ — a tilde after = is not expanded by any shell, and
# OpenTofu will happily create the literal directory inside this repo.
STATE="$HOME/.tofu-state/spiralclass/oracle-box.tfstate"

tofu init
tofu plan  -state="$STATE"
tofu apply -state="$STATE"
```

## Getting in

**Normally: `ssh ubuntu@spiralclass-box`** over the tailnet. The banner on :22
is `SSH-2.0-Tailscale` and ordinary SSH keys are irrelevant to it.

⚠️ **:22 is closed to the internet and there is no management CIDR.**
Tailscale needs no inbound port, so opening one would spend the security
property for nothing. Do not add an ingress rule to "make SSH work" — if
Tailscale is not working, the answer is below, not a firewall hole.

**When the tailnet join has failed: the serial console.** Out-of-band, through
the OCI API. It needs no network on the instance, no open port, and no fixed
address on your side — which matters, because the operator connects from
changing networks and any IP-pinned hatch would stop working within days.

```bash
oci compute instance-console-connection create \
  --instance-id "$INSTANCE_OCID" \
  --ssh-public-key-file ~/.ssh/id_ed25519.pub

# then take the `connection-string` from the response and run it
```

That is what `ssh_public_key_file` puts on the box. It is inert while
Tailscale is healthy.

⚠️ **A1 capacity in Querétaro is contended and `apply` does not retry.** "Out
of host capacity" is a normal answer, not a broken one. Re-run — and note that
with the old box already destroyed there is no fallback but to keep retrying,
which is the whole risk this rebuild accepted.

### Where the state lives, and why it is local for now

`$HOME/.tofu-state/spiralclass/oracle-box.tfstate` — a stable path, mode 700 on
the directory.

⚠️ **Not in the capture directory.** An earlier draft put it in
`~/oracle-capture-2026-09-04/`, which was wrong in a way worth naming: that
directory is a dated, point-in-time snapshot of a machine that no longer
exists, and state is the opposite — live, mutating, and meaningful
indefinitely. State that lives in a folder whose name says "one night in
September" is state somebody eventually tidies up.

⚠️ **This file contains `tailscale_authkey` in plaintext.** OpenTofu records
the values of sensitive variables in state; `sensitive = true` hides them from
console output, not from the file. Hence mode 700 on the directory, and hence
it must never be committed.

⚠️ **Back it up somewhere the laptop is not the only copy.** Losing it does not
destroy the box, but it does return it to exactly the condition D-139
objected to: infrastructure nothing describes. Re-adopting would mean
importing seven resources by hand.

The deleted module declared an S3 backend against the R2 bucket its siblings
use (D-49). That is still the right destination. It is not where the
_first_ apply happens: this module had never been applied, and putting an
untested backend in the same run as an untested module means two things
failing at once with no way to tell which. Migrate with
`tofu init -migrate-state` once a clean plan is a no-op against the running
box — and note that "no-op" is only a meaningful test because the instance now
ignores image drift; without that pin the plan would eventually show a destroy
for reasons that have nothing to do with the backend.

⚠️ Until then the state is one file on one laptop, for a box that carries
every live class. That is the exact single point of failure the backend
existed to remove, and it is a debt with a due date, not a decision.

## What must happen by hand after an apply

1. **Disable Tailscale key expiry for the node**, in the admin console.
   cloud-init cannot do it. Skip it and SSH lapses 180 days from now, on a
   date nobody has written down. The old box only survived because someone
   turned it off by hand.
2. **`scripts/oracle-deploy.sh`** — the stack.
3. **Cloudflare A records** → the `public_ips` output.
4. **Migrate the state**, per above.

## Secrets: what this box holds, and why tmpfs does not help

⚠️ **What this box holds is preview's whole environment plus five production
LiveKit values** — `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `DEEPGRAM_API_KEY`,
`ANTHROPIC_API_KEY` and `CAPTIONS_AGENT_SHARED_SECRET`. That is the single
biggest security consequence of keeping production on Fly, and it is worth
stating in the positive: an earlier draft of this rebuild put the production
app here too, which would have meant `STRIPE_SECRET_KEY`, production's
`DATABASE_URL`, `SESSION_SECRET`, `BETTER_AUTH_SECRET` and
`FIELD_ENCRYPTION_KEY` sitting as files at mode 600 on a free-tier box Oracle
reserves the right to reclaim. They stay in Fly's managed secret store instead.

⚠️ **Preview's secrets are still real secrets.** They are not production's, but
a preview `DATABASE_URL` and a Stripe test key are not nothing, and everything
below applies to them.

They arrive by `scp` from whoever runs the deploy, over the tailnet, and sit at
mode 600 in the stack directory. The box holds **no Infisical credential** —
compromising it yields the values it needs, never the means to fetch more.

### The tmpfs idea, and why it was measured and rejected

The obvious improvement is to render secrets into `/run` (tmpfs) so a boot
volume Oracle **reclaims** carries no plaintext. It was built on 2026-09-04 and
then deleted, because it does not work:

> **Docker writes the resolved environment into
> `/var/lib/docker/containers/<id>/config.v2.json` on the persistent volume.**

Measured, not assumed: an env file was deleted from disk and the value was
still in `docker inspect`; the container was stopped and it was still there;
and `grep` found it verbatim in `config.v2.json`. A tmpfs env file therefore
buys **no** at-rest protection, while adding a boot-time network dependency —
if the secret store is unreachable, the box does not start its stack.

**What would actually work**, if this becomes worth doing: compose `secrets:`
with `file:` sources, which mounts material into the container rather than
baking it into the container config, plus a small change to
`scripts/docker-entrypoint.sh` so it sources those files instead of relying on
the environment. That is an application change and wants its own testing — it
is not a thing to attempt beside a cutover.

### Cheaper wins that are already applied

- `no-new-privileges` and `cap_drop: ALL` on the preview app, the preview
  database and the captions agent. ⚠️ **Egress is deliberately exempt** — it needs
  `SYS_ADMIN` for Chrome's sandbox and cannot be locked down without breaking
  recordings.
- Preview's Postgres publishes to `127.0.0.1` on a bridge network, not the host
  interface.

### Worth doing, not yet done

- **Drop secrets the app never reads.** The env is generated from Infisical's
  whole root path, so a retired push-delivery token still ships to the box for
  nothing.
- **Tailscale ACLs.** The tailnet is flat; the box should not be able to reach
  the operator's laptop.

## Things that were wrong in the sources this was rebuilt from

Recorded because they cost time during the rebuild and will otherwise cost it
again:

- **The old module read `LIVEKIT_API_KEY` out of
  `config/env/production.runtime.env` with a `regex()`.** That value is now
  the literal `__LOCAL__` (the nine runtime values moved to Infisical), so
  applying it would have rendered `__LOCAL__` as LiveKit's API key into
  `livekit.yaml`, `egress.yaml` and the compose file — every token would fail
  to verify and no class would connect, with nothing in any log saying why.
  The key is a variable here.
- **`ORACLE_BOX_REBUILD.md` and the private rotation runbook claim Infisical holds
  `tailscale_authkey_oracle` and `cloudflare_zone_id`.** It holds neither.
  Production Infisical has exactly two paths — `/` with 22 secrets and
  `/config` with 15. Discovered mid-rebuild, which is the worst moment.
- **The deleted module's `ssh_ingress_cidr` was a trap worth not copying.** It
  had no default on purpose, to force a narrow SSH source rather than accept
  OCI's world-open `:22` — a real improvement on the default, and the reason
  for it survived nowhere but the deleted file. But the right answer on this
  box is narrower still: Tailscale needs no inbound port at all, so `:22` is
  closed to everything and the variable is gone. An IP-pinned rule would also
  have been useless here in particular, since the one person who would use it
  connects from a different network most weeks.
- **The box had a 4 GB swapfile no record mentions.** Reproduced rather than
  dropped.
- **The image data source would have planned a destroy on its own.**
  `local.image_id` takes the newest aarch64 Ubuntu 24.04 image, and
  `source_details.source_id` is a force-new attribute, so the first apply
  after any Canonical respin would have planned a destroy and a recreate of
  the box carrying every live class — surfacing at exactly the moment this
  file tells you to look for a clean no-op plan before migrating the state.
  `main.tf` now ignores changes to it, so the data source only chooses the
  image for the FIRST apply and rebuilding onto a newer one is a deliberate
  `-replace`.
