terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }

  # State lives in the same R2 bucket as every other module here
  # (infra/cloudflare-r2), per D-49 —
  # concern-keyed, not vendor-keyed. See backend.hcl.example.
  #
  # IMPORTANT — two DIFFERENT AWS credential sets are in play in this one
  # root module, and they must NOT collide:
  #   1. This `backend "s3"` block talks to Cloudflare R2 (S3-compatible),
  #      for STATE STORAGE only. It authenticates via a named profile
  #      (`profile` below), never the bare AWS_ACCESS_KEY_ID/
  #      AWS_SECRET_ACCESS_KEY env vars.
  #   2. The `provider "aws"` block further down talks to REAL AWS, for the
  #      actual IAM/SES resources. It authenticates via those same env var
  #      names (the AWS SDK's default credential chain) — deliberately, so
  #      it matches every other provider in this repo (env-var-only, never
  #      hardcoded).
  # If the backend also read AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, `tofu
  # init` would try to use your REAL AWS admin key to authenticate to R2 and
  # fail (or worse, silently pick whichever env var happened to resolve).
  # See README.md "Configure" for the exact `aws configure --profile`
  # bootstrap step this profile name expects.
  backend "s3" {
    key     = "infra/aws-ses.tfstate"
    profile = "agendaprofe-r2-state"

    region                      = "auto"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requester_charged      = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

# Real AWS. Authenticates via AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (an
# ADMIN-scoped key, used only to bootstrap the narrow SES-sender IAM user
# below — never the credential the app itself ends up using) — see
# README.md "Configure". NEVER hardcode a key here or in tfvars.
provider "aws" {
  region = var.aws_region
}

# Authenticates via CLOUDFLARE_API_TOKEN, same pattern as every other
# Cloudflare module in this repo. Needs "DNS: Edit" on the zone that owns
# var.cloudflare_zone_id (separate from the R2/account-scoped token the
# other Cloudflare modules use — this one is zone-scoped).
provider "cloudflare" {}

# --- AWS: IAM user scoped to SES sending only ---------------------------
#
# See infra/aws-ses/README.md Part A. Least-privilege: SES can't scope the
# SendEmail/SendRawEmail actions by IAM Resource ARN, but the Condition on the
# policy below DOES gate them on the From identity (ses:FromAddress), so this
# credential can only send *as* an address at one of our verified sending
# domains (L-10) — defense in depth on top of which identities are verified on
# the account. No console access; access-key-only.
resource "aws_iam_user" "ses_sender" {
  name = var.ses_user_name
  path = "/agendaprofe/"
}

resource "aws_iam_user_policy" "ses_send" {
  name = "ses-send-only"
  user = aws_iam_user.ses_sender.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ses:SendEmail", "ses:SendRawEmail"]
      Resource = "*"
      # SES can't scope send by resource ARN, but it CAN gate on the From
      # identity (L-10): restrict this credential to only send as an address at
      # one of our verified sending domains. ses:FromAddress is the full From
      # address; StringLike "*@domain" allows any local-part at that domain, one
      # pattern per domain in var.ses_domains.
      Condition = {
        StringLike = {
          "ses:FromAddress" = [for d in var.ses_domains : "*@${d}"]
        }
      }
    }]
  })
}

# The secret half (`secret`) is only ever returned by AWS at creation time —
# see outputs.tf's `sensitive = true` and README.md's "Wire the credentials"
# step for pushing it straight to Infisical rather than leaving it sitting
# in a shell history or a file.
resource "aws_iam_access_key" "ses_sender" {
  user = aws_iam_user.ses_sender.name
}

# --- AWS: SES domain identity, Easy DKIM (one per environment domain) ----
#
# `var.ses_domains` has NO default — see variables.tf. As of 2026-07-13,
# the operator confirmed via the Resend dashboard which domain each environment's
# Resend account has verified: production → updates.spiralclass.com,
# preview → updates.staging.spiralclass.com. BUT a live DNS check (public
# resolver + authoritative trace against Cloudflare's own nameservers)
# found ZERO records — no SPF, no DKIM CNAME — at either name. That
# contradiction is UNRESOLVED (the operator chose to proceed with this module before
# checking Resend's live per-domain DNS-status page — see
# infra/aws-ses/README.md's top note). Applying this module creates a
# fresh SPF/DKIM setup regardless of that mystery, which is fine BECAUSE
# nothing is currently live to collide with — but if it turns out Resend's
# dashboard shows a DIFFERENT set of expected DNS values than what this
# module assumes, reconcile against that before trusting your production
# domain's deliverability.
resource "aws_sesv2_email_identity" "domain" {
  for_each = toset(var.ses_domains)

  email_identity = each.value

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# --- Cloudflare: DKIM CNAMEs + merged SPF, per domain ---------------------
#
# 3 CNAMEs per domain (AWS always returns 3 DKIM tokens for Easy DKIM) —
# flattened into one map keyed by "domain:token" so a single for_each can
# create all of them across every domain in var.ses_domains.
locals {
  dkim_records = var.manage_dns ? merge([
    for domain, identity in aws_sesv2_email_identity.domain : {
      for token in identity.dkim_signing_attributes[0].tokens :
      "${domain}:${token}" => { domain = domain, token = token }
    }
  ]...) : {}
}

resource "cloudflare_dns_record" "ses_dkim" {
  for_each = local.dkim_records

  zone_id = var.cloudflare_zone_id
  name    = "${each.value.token}._domainkey.${each.value.domain}"
  type    = "CNAME"
  content = "${each.value.token}.dkim.amazonses.com"
  ttl     = 300
  proxied = false
}

# ONE merged SPF record per domain, covering both Resend and SES — a domain
# can only have one `v=spf1` TXT record; a second one breaks SPF for BOTH
# providers. `var.resend_spf_include` defaults to Resend's documented
# include host (UNVERIFIED, see variables.tf); blank it if a given domain
# isn't actually one Resend sends from.
resource "cloudflare_dns_record" "ses_spf" {
  for_each = var.manage_dns ? toset(var.ses_domains) : toset([])

  zone_id = var.cloudflare_zone_id
  name    = each.value
  type    = "TXT"
  content = trimspace(
    "v=spf1 ${var.resend_spf_include != "" ? "include:${var.resend_spf_include} " : ""}include:amazonses.com ~all"
  )
  ttl = 300
}
