output "credentials" {
  description = <<-EOT
    The SES-sending-only IAM credential — ONE shared credential across both
    environments (SES's IAM Resource="*" for send actions means separate
    IAM users per environment would give no real blast-radius reduction,
    unlike the R2 module's one-token-per-bucket pattern). Consumed by
    push-infisical-secrets.sh (SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY —
    Infisical/Fly preview) — for production, set the same two values on the
    production Fly app by hand (no Tofu Fly-secrets wiring for this yet). AWS
    only
    returns `secret` once, at creation — if this is ever lost, the fix is
    `tofu taint aws_iam_access_key.ses_sender` + apply to rotate, not trying
    to recover the old value.
  EOT
  sensitive = true
  value = {
    access_key_id     = aws_iam_access_key.ses_sender.id
    secret_access_key = aws_iam_access_key.ses_sender.secret
  }
}

output "ses_domains" {
  description = "Echoes var.ses_domains, for quick `tofu output` inspection without unlocking the sensitive credentials output."
  value       = var.ses_domains
}

output "verified_for_sending_status" {
  description = "SES's own verification status per domain, keyed by domain — should read \"SUCCESS\" once each domain's DKIM CNAMEs have propagated and SES has re-checked (can take up to 72h, usually much faster). NOT the same as sandbox/production sending access — see infra/aws-ses/README.md Part C, which has no Tofu equivalent (a manual AWS Support case)."
  value = {
    for domain, identity in aws_sesv2_email_identity.domain : domain => identity.verified_for_sending_status
  }
}

output "dkim_tokens" {
  description = "The 3 DKIM tokens AWS generated per domain, keyed by domain. Non-sensitive (they're published in DNS anyway) — useful for double-checking the cloudflare_dns_record.ses_dkim resources against what AWS actually expects, or for wiring DNS by hand if var.manage_dns is false."
  value = {
    for domain, identity in aws_sesv2_email_identity.domain : domain => identity.dkim_signing_attributes[0].tokens
  }
}
