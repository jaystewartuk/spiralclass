variable "aws_region" {
  type        = string
  description = "SES is regional. us-east-1 default per infra/aws-ses/README.md Part B (most mature region, cheapest, no meaningful latency difference for transactional email to Mexican inboxes)."
  default     = "us-east-1"
}

variable "ses_domains" {
  type        = list(string)
  description = <<-EOT
    One SES domain identity per environment that needs its own SES_FROM.
    Confirmed 2026-07-13 via the Resend dashboard: production's Resend
    account has verified "updates.spiralclass.com"; preview's has verified
    "updates.staging.spiralclass.com" — these are Resend's TWO SEPARATE
    accounts (not one account with two domains), each with its own
    verification state, which is why this is a list rather than a single
    value with an environment split done some other way.

    UNRESOLVED as of the same date: a live DNS check (public resolver +
    authoritative trace against Cloudflare) found ZERO records at EITHER
    domain — no SPF, no DKIM CNAME — despite Resend showing both as
    verified. This module was applied before that contradiction was
    checked against Resend's live per-domain DNS-status page (a deliberate
    choice, not an oversight — see infra/aws-ses/README.md's top
    note). Reconcile it before fully trusting production deliverability;
    it does not block this module from working correctly for SES's own
    records, since there's nothing live to collide with either way.
  EOT
  default     = ["updates.spiralclass.com", "updates.staging.spiralclass.com"]
}

variable "ses_user_name" {
  type        = string
  description = "IAM user name for the SES-sending-only credential."
  default     = "agendaprofe-ses-sender"
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Zone ID for spiralclass.com (Cloudflare dashboard → spiralclass.com → Overview, right sidebar → API section → Zone ID). Different from the account_id the other Cloudflare modules use — this is zone-scoped, not account-scoped."
}

variable "manage_dns" {
  type        = bool
  description = <<-EOT
    Whether this module also creates the DKIM CNAMEs + merged SPF TXT
    records in Cloudflare (true) or only provisions the AWS side, leaving
    DNS as a manual step per infra/aws-ses/README.md Part B (false).
    Default true because a live DNS check (2026-07-13) found both confirmed
    domains in var.ses_domains are currently blank slates — safe to create
    fresh records. If a later check (e.g. Resend's own live DNS-status page)
    finds either domain unexpectedly already has live records this module
    doesn't know about, set this to false until you've read README.md
    "Adopting an existing subdomain."
  EOT
  default     = true
}

variable "resend_spf_include" {
  type        = string
  description = <<-EOT
    Resend's SPF include host, merged into the same TXT record as SES's (a
    domain can only have ONE v=spf1 record). UNVERIFIED — "_spf.resend.com"
    is a best-effort default, not confirmed against Resend's current docs
    or a live record in this session. Before applying, check Resend's own
    domain-setup instructions (dashboard → Domains → your domain → DNS
    records tab shows the exact SPF value it wants) and override this
    variable to match exactly. Applies to every domain in var.ses_domains
    uniformly — set to "" if none of them are actually a domain Resend
    sends from.
  EOT
  default     = "_spf.resend.com"
}
