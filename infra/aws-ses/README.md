# Amazon SES + DKIM/SPF DNS provisioning (OpenTofu, state in R2)

Codifies the AWS side of `infra/aws-ses/README.md` (IAM user scoped to
sending, the SES domain identity with Easy DKIM) **and**, optionally, the
Cloudflare DNS side (the 3 DKIM CNAMEs + a merged SPF TXT record) as IaC —
same "one dir per vendor/concern, state in the shared R2 bucket" pattern as
`infra/cloudflare-r2`. Read that runbook
first; this module automates its Part A + (optionally) Part B. Part C
(requesting SES production access) has no Tofu equivalent — it's an AWS
Support case, still manual.

Provider: `hashicorp/aws ~> 5` + `cloudflare/cloudflare ~> 5`. Works with
**OpenTofu** or **Terraform** — the `.tf` files are identical; only the CLI
name differs (`tofu` ↔ `terraform`).

> **Status: scaffold — plan/validate only, not yet applied.** This session
> built and `tofu validate`-checked the module's syntax but has **no
> network path to `sts.amazonaws.com`/`email.us-east-1.amazonaws.com` or
> `api.cloudflare.com`**, so nothing here has been checked against a live
> API. Read "Before the first real apply" below before running anything but
> `tofu validate`.

## Before the first real apply

1. **The domain question is resolved, but a new one replaced it.** the operator
   confirmed (2026-07-13) via each Resend account's dashboard which domain
   it has verified — production → `updates.spiralclass.com`, preview →
   `updates.staging.spiralclass.com` (both now `variables.tf`'s
   `ses_domains` default). But a live DNS check (public resolver +
   authoritative trace against Cloudflare's own nameservers) found **zero
   records at either domain** — no SPF, no DKIM CNAME — contradicting
   Resend's "verified" status. the operator chose to proceed with this module before
   resolving that contradiction (see `infra/aws-ses/README.md`'s top
   note) — it doesn't block SES's own setup working correctly (nothing live
   to collide with), but check Resend's live per-domain DNS-status page
   before fully trusting **production** deliverability on either provider.
2. **`aws_sesv2_email_identity`'s DKIM token count/format** — the
   `dkim_signing_attributes[0].tokens` shape used in `main.tf` and
   `outputs.tf` is standard, documented AWS provider behavior (Easy DKIM
   always returns exactly 3 tokens), but **unverified against a live
   apply** in this session. If `tofu apply` produces a different token
   count or the `cloudflare_dns_record.ses_dkim` for_each errors, that's
   the first thing to check.
3. **`resend_spf_include`'s default (`_spf.resend.com`)** — also
   unverified, see `variables.tf`. Confirm against Resend's own DNS
   instructions before applying.
4. **The `aws` provider's bootstrap credential.** Creating
   `aws_iam_user.ses_sender` needs an AWS credential with IAM + SES
   permissions — necessarily broader than the narrow SES-sending key this
   module then creates. Use a temporary personal/admin AWS key for the
   `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env vars at apply time; it
   is never written to state or committed anywhere. Rotate/deactivate it
   afterwards if you'd rather not leave a standing admin key around — Tofu
   only needs it at apply time, not for the app to keep running.

## Adopting an existing subdomain (only if a later check finds live records)

If checking Resend's live DNS-status page (see step 1 above) finds that
either domain unexpectedly already has real DNS records — meaning the
public-resolver check that found nothing was somehow stale or wrong —
**set `manage_dns = false`** in `terraform.tfvars` before applying: this
module will still provision the AWS IAM/SES side, but leave DNS as the
manual step `infra/aws-ses/README.md` Part B describes, rather than
risk `cloudflare_dns_record.ses_spf` creating a SECOND `v=spf1` record next
to an existing one (breaks SPF for both providers — DNS allows it, the spec
doesn't). Once confirmed via `dig TXT <domain>` (or the Cloudflare
dashboard) exactly what's live, you can adopt those records into Tofu state
with `tofu import` (see `infra/cloudflare-r2/import.sh` for the general
pattern — no equivalent script exists here yet, write one if this path is
actually needed) and flip `manage_dns` back to `true`.

## Prerequisites

1. **The R2 state bucket.** ✅ Already created — `agendaprofe-tofu-state`
   (same one every other module here uses).
2. **A named AWS CLI profile for the state backend** —
   `agendaprofe-r2-state`, pointed at the R2 token's derived S3 credentials.
   See `backend.hcl.example` for the exact `aws configure --profile` step
   and **`main.tf`'s big comment** for why this can't just be the
   `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env vars like the other
   modules use — this is the first module where those env vars are also
   needed for something else (the real `aws` provider).
3. **A real AWS admin/IAM-scoped credential** for the `aws` provider itself
   — see "Before the first real apply" step 4.
4. **A Cloudflare API token** with `DNS: Edit` on the zone owning
   `var.cloudflare_zone_id` — passed via `CLOUDFLARE_API_TOKEN`. Separate
   token from the account-scoped one `infra/cloudflare-r2` uses (that one
   has no DNS permission; this one doesn't need R2/Account-Token
   permission). Skip this if `manage_dns = false`.

## Configure

```sh
cd infra/aws-ses

cp backend.hcl.example        backend.hcl          # R2 state bucket + endpoint + profile name
cp terraform.tfvars.example   terraform.tfvars     # cloudflare_zone_id (ses_domains' default is already the confirmed pair — READ "Before the first real apply" FIRST)

aws configure --profile agendaprofe-r2-state   # one-time, see backend.hcl.example
export AWS_ACCESS_KEY_ID=…       # REAL AWS admin key, for the aws provider — NOT the R2 profile above
export AWS_SECRET_ACCESS_KEY=…
export CLOUDFLARE_API_TOKEN=…    # zone-scoped DNS:Edit token — omit if manage_dns = false

tofu init -backend-config=backend.hcl
tofu plan   # should show: 1 aws_iam_user, 1 aws_iam_user_policy, 1 aws_iam_access_key,
            # 2 aws_sesv2_email_identity (one per ses_domains entry), and (if manage_dns)
            # 6 cloudflare_dns_record.ses_dkim (3 tokens × 2 domains) + 2 cloudflare_dns_record.ses_spf
            # — nothing to DESTROY on a first apply
tofu apply
```

`backend.hcl` and `terraform.tfvars` are gitignored; only the `*.example`
files ship, and neither holds a secret.

## After `apply`

1. **Wire the credentials to preview:**
   ```sh
   ./push-infisical-secrets.sh
   ```
   Then uncomment `SES_REGION`/`SES_FROM`/`EMAIL_PROVIDER` in `fly.toml`'s
   `[env]` block by hand (non-secret config stays git-reviewed there, not
   in Infisical — see `infra/aws-ses/README.md` Part D) and deploy.
   `SES_FROM` here is `soporte@updates.staging.spiralclass.com` (preview's
   verified domain) — the access key/secret are the SAME shared credential
   as production (see outputs.tf), only `SES_FROM` differs per environment.
2. **Wire the credentials to production:** copy `tofu output -json
credentials` (the SAME access key/secret pushed to preview above — this
   module provisions one shared IAM credential, not per-environment ones)
   onto the **production Fly app** (`fly secrets` / Infisical `production`
   env): `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` (secret), plus the
   non-secret `SES_REGION` and `SES_FROM = soporte@updates.spiralclass.com`
   (production's verified domain — NOT the same value used on preview) in
   `fly.production.toml`'s `[env]`. No script pushes the production side
   yet.
3. **Request SES production access** (Part C — manual, no Tofu resource
   exists for an AWS Support case). Do this before relying on real sends;
   the sandbox caps you at 200/day and verified-recipients-only.
4. **Verify** per `infra/aws-ses/README.md` Part E — SES's Reputation
   dashboard, the `List-Unsubscribe` header check, a real end-to-end send
   on preview before touching production.

## Notes

- **Why one module for two vendors (AWS + Cloudflare), unlike the rest of
  `infra/`'s one-dir-per-vendor pattern:** the DKIM CNAME _values_ are only
  known after AWS creates the SES domain identity (`dkim_signing_attributes
[0].tokens`) — splitting this into two applied-separately modules would
  mean manually copying 3 tokens between them on every recreate, exactly
  the manual-copy chore this whole IaC effort exists to remove. A single
  module with two providers, wired together by a Tofu expression instead
  of a human, is the right shape here even though it's a slight
  convention break.
- **Rotating the SES-sender key**: `tofu taint aws_iam_access_key.ses_sender
&& tofu apply` creates a new key and destroys the old one in the same
  apply (IAM allows 2 access keys per user, so there's no window with
  zero valid keys) — then re-run `push-infisical-secrets.sh` and update the
  production Fly app's secrets by hand.
- **`manage_dns = false` doesn't undo already-created records** — if you
  flip it after an apply that created the DKIM/SPF records, the next
  `tofu apply` will plan to DESTROY them (for_each dropping to empty).
  Don't flip it casually once real records are live; if you need to stop
  managing them without deleting them, `tofu state rm` the specific
  resources instead.
