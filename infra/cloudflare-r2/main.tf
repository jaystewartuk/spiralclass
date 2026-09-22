terraform {
  required_version = ">= 1.6"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }

  # State lives in the same R2 bucket as the other infra/* modules on the
  # shared backend, per D-49 — concern-keyed, not vendor-keyed. See
  # ../backend.hcl.
  backend "s3" {
    key = "infra/cloudflare-r2.tfstate"

    region                      = "auto"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requester_charged      = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

# Authenticates via the CLOUDFLARE_API_TOKEN environment variable — same
# pattern as the sibling infra/cloudflare module. NEVER hardcode the token
# here or in tfvars.
provider "cloudflare" {}

# The "Object Read & Write" permission, scoped per-bucket, is what the
# dashboard grants when you tick "Apply to specific buckets" for an R2 API
# token. Looked up by name (not a hardcoded UUID) so a Cloudflare-side
# rename doesn't silently break every future apply.
#
# CORRECTED LIVE (2026-07-12): the original version of this data source was
# `cloudflare_api_token_permission_groups_list` (no account_id argument),
# which calls the USER-scoped `/user/tokens/permission_groups` endpoint and
# 403s ("Valid user-level authentication not found") on a token that only
# has account-scoped permissions. The ACCOUNT-scoped equivalent below
# (`cloudflare_account_api_token_permission_groups_list`, taking
# `account_id`) calls `/accounts/{account_id}/tokens/permission_groups`
# instead — this works with CLOUDFLARE_API_TOKEN's existing account-scoped
# permissions alone, no separate "User API Tokens: Read" grant needed.
#
# CONFIRMED LIVE: the permission-group name below
# ("Workers R2 Storage Bucket Item Write") is exactly right — this data
# source resolved it successfully once account-scoped.
data "cloudflare_account_api_token_permission_groups_list" "r2_bucket_write" {
  account_id = var.account_id
  name       = "Workers R2 Storage Bucket Item Write"
}

# CORRECTED + CONFIRMED LIVE (2026-07-12): the first pass only granted
# Write, but a real imported token (agendaprofe-teacher-photos-r2) diffed
# with an EXTRA permission-group id Write alone doesn't cover —
# Cloudflare's dashboard "Object Read & Write" preset (what created the
# live tokens) always grants Read AND Write as two separate permission
# groups, not one combined one. Missing Read here would have made `apply`
# silently strip a live token's read access (breaks presigned GET —
# downloads/signed URLs) had this gone unnoticed. Re-running `tofu plan`
# after adding this reported "No changes" on
# agendaprofe-teacher-photos-r2's `policies` — confirms the unexplained id
# really was this group, name, and the resources JSON key are all correct.
data "cloudflare_account_api_token_permission_groups_list" "r2_bucket_read" {
  account_id = var.account_id
  name       = "Workers R2 Storage Bucket Item Read"
}

locals {
  r2_bucket_write_permission_group_id = one(data.cloudflare_account_api_token_permission_groups_list.r2_bucket_write.result).id
  r2_bucket_read_permission_group_id  = one(data.cloudflare_account_api_token_permission_groups_list.r2_bucket_read.result).id

  buckets_by_name = { for b in var.buckets : b.name => b }
}

# One R2 bucket per entry in var.buckets. `location`/`storage_class`/
# `jurisdiction` are deliberately left unset (optional+computed) so that
# importing an existing dashboard-created bucket never produces a diff —
# whatever the live bucket already has is accepted as-is.
resource "cloudflare_r2_bucket" "this" {
  for_each = local.buckets_by_name

  account_id = var.account_id
  name       = each.value.name
}

# One API token per bucket (not one shared token) — matches the current
# manual setup, so a leaked/rotated token's blast radius stays limited to
# the single bucket it names.
#
# CORRECTED LIVE (2026-07-12): the original resource type here was
# `cloudflare_api_token` (USER-scoped — lives in the same `/user/tokens/*`
# registry the permission-groups fix above moved away from). The tokens
# already live in the Cloudflare account under "Account API Tokens" — a
# genuinely separate registry (`/accounts/{account_id}/tokens/*`) from
# "User API Tokens" — so importing one of the real existing tokens by id
# against `cloudflare_api_token` 404s ("token not found") even with a
# correct id: it's simply not in that registry. `cloudflare_account_token`
# (below) is the resource type matching where these tokens actually live.
#
# STILL UNVERIFIED: the `resources` JSON key below (the R2-bucket-scoping
# format the Cloudflare dashboard uses internally) — no token import has
# succeeded yet to check it against (see README.md before the first apply).
#
# `name` CORRECTED LIVE (2026-07-12): the real token is named
# "<bucket>-r2" (e.g. "agendaprofe-teacher-photos-r2"), not the
# "r2-<bucket>-rw" pattern the first pass guessed.
resource "cloudflare_account_token" "r2" {
  for_each = local.buckets_by_name

  account_id = var.account_id
  name       = "${each.key}-r2"

  policies = [{
    effect = "allow"
    permission_groups = [
      { id = local.r2_bucket_write_permission_group_id },
      { id = local.r2_bucket_read_permission_group_id },
    ]
    resources = jsonencode({
      "com.cloudflare.edge.r2.bucket.${var.account_id}_default_${each.value.name}" = "*"
    })
  }]
}

locals {
  # S3-compatible Access Key ID / Secret Access Key derived from the API
  # token, per Cloudflare's documented R2 credential derivation
  # (https://developers.cloudflare.com/r2/api/tokens/#get-s3-api-credentials-from-an-api-token):
  #   Access Key ID     = the token's `id` (verbatim)
  #   Secret Access Key = SHA-256 hex of the token's `value`
  # There is no separate Terraform resource for this.
  #
  # VERIFIED LIVE 2026-07-16: a Tofu-created token's `id` + sha256(value)
  # authenticated against the R2 S3 endpoint (rclone ListObjectsV2 → 200).
  # The earlier `md5(token.id)` guess was WRONG — it produced a 401 — and is
  # fixed here. (A newly-created token takes up to ~1 min to propagate to the
  # S3 endpoint before it authenticates; that is expected, not a cred error.)
  #
  # `secret_access_key` is wrapped in `try(..., null)`: `token.value` is
  # ONLY ever populated for a token Tofu itself CREATED (captured from the
  # create response) — Cloudflare's API never returns an existing token's
  # raw value again, so `token.value` is genuinely `null` for every
  # imported (pre-existing) token. That's fine: an imported token already has
  # its real creds set wherever it's consumed — Tofu only needs to track its
  # existence so `apply` never destroys/recreates (and rotates) it. Only
  # tokens created fresh BY Tofu get a real non-null derived secret here.
  r2_credentials = {
    for name, token in cloudflare_account_token.r2 : name => {
      access_key_id     = token.id
      secret_access_key = try(sha256(token.value), null)
    }
  }
}
