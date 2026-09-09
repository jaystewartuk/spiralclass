output "buckets" {
  description = <<-EOT
    Per-bucket R2 config + derived S3-compatible credentials, keyed by the
    real Cloudflare bucket name (e.g. "agendaprofe-teacher-photos").
    Consumed by push-fly-secrets.sh, which filters by `environment` and
    pushes each set to the matching Fly app (preview today; production once
    that path is wired at cutover) — do not rename these fields without
    updating that script.

    `bucket`/`access_key_id`/`secret_access_key` are wrapped in `try(...,
    null)` because during the ADOPTION phase (importing existing buckets
    one at a time per README.md) most `buckets` entries won't be in state
    yet — indexing a for_each resource for a not-yet-created instance
    errors plan-time otherwise, breaking the "import one, `tofu plan`,
    verify, repeat" workflow the READMEs describe. Once every bucket is
    imported/applied, every entry resolves to a real value; the downstream
    consumer (push-fly-secrets.sh) should only run after that point, not
    mid-adoption.
  EOT
  sensitive = true
  value = {
    for name, b in local.buckets_by_name : name => {
      bucket            = try(cloudflare_r2_bucket.this[name].name, null)
      endpoint          = "https://${var.account_id}.r2.cloudflarestorage.com"
      region            = "auto"
      access_key_id     = try(local.r2_credentials[name].access_key_id, null)
      secret_access_key = try(local.r2_credentials[name].secret_access_key, null)
      env_prefix        = b.env_prefix
      environment       = b.environment
      public            = b.public
    }
  }
}

output "bucket_names" {
  description = "Non-sensitive list of managed bucket names, for quick `tofu output` inspection without unlocking the sensitive `buckets` output."
  value       = keys(local.buckets_by_name)
}
