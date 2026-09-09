variable "account_id" {
  type        = string
  description = "Cloudflare account ID (same account as infra/cloudflare). Not secret; find it in the dashboard URL or `wrangler whoami`."
}

variable "buckets" {
  type = list(object({
    name        = string
    env_prefix  = string
    environment = optional(string, "production")
    public      = optional(bool, false)
  }))
  description = <<-EOT
    One entry per R2 bucket to manage.

    `env_prefix` is the full env-var prefix consuming code reads config
    from (e.g. "TEACHER_PHOTOS_R2" for TEACHER_PHOTOS_R2_BUCKET/_ENDPOINT/
    _REGION/_ACCESS_KEY/_SECRET) — kept explicit rather than derived from
    `name` because the app's three existing env-var families
    (`apps/web/src/lib/storage/provider.ts`'s R2_ENV_PREFIX map,
    `chat-audio.ts`/`chat-video.ts`'s hardcoded CHAT_AUDIO_R2_*, and
    `recording.ts`/`lesson-audio-store.ts`'s hardcoded LIVEKIT_EGRESS_S3_*)
    don't follow one consistent naming rule — LIVEKIT_EGRESS_S3 in
    particular doesn't even share the R2 bucket's own name.

    `environment` is "production" or "preview" — it doesn't change what
    this module provisions (every entry gets its own real bucket + token
    either way), only which Fly app push-fly-secrets.sh pushes its creds to
    (preview app today; production app once that path is wired at cutover).
    See D-65.

    `public` is metadata only (surfaced in the `buckets` output for
    push-fly-secrets.sh and for humans) — this module does not provision
    public access (custom domain / r2.dev) for a bucket; that stays a manual
    Cloudflare-dashboard step, same as today.

    Adding a bucket is a one-line diff here; see README.md for the import
    step required before the first apply that adds an entry for an
    already-existing (dashboard-created) bucket.
  EOT
  # Production buckets carry an explicit `agendaprofe-production-*` prefix so
  # every managed bucket names its environment (matching the preview twins).
  # The original bare-named buckets (agendaprofe-teacher-photos, etc.) are
  # deliberately NOT in this list — they are the pre-convention live buckets
  # and are left untouched; these fresh `-production-` buckets replace them on
  # a deliberate cutover (repoint the production Fly app's *_R2_BUCKET env
  # vars + migrate objects), never a silent rename.
  default = [
    { name = "agendaprofe-production-class-materials", env_prefix = "CLASS_MATERIALS_R2", environment = "production", public = false },
    { name = "agendaprofe-production-teacher-photos", env_prefix = "TEACHER_PHOTOS_R2", environment = "production", public = true },
    { name = "agendaprofe-production-teacher-videos", env_prefix = "TEACHER_VIDEOS_R2", environment = "production", public = true },
    { name = "agendaprofe-production-student-photos", env_prefix = "STUDENT_PHOTOS_R2", environment = "production", public = false },
    { name = "agendaprofe-production-chat-audio", env_prefix = "CHAT_AUDIO_R2", environment = "production", public = false },
    { name = "agendaprofe-production-material-podcasts", env_prefix = "MATERIAL_PODCASTS_R2", environment = "production", public = false },
    { name = "agendaprofe-production-recordings", env_prefix = "LIVEKIT_EGRESS_S3", environment = "production", public = false },

    { name = "agendaprofe-preview-class-materials", env_prefix = "CLASS_MATERIALS_R2", environment = "preview", public = false },
    { name = "agendaprofe-preview-teacher-photos", env_prefix = "TEACHER_PHOTOS_R2", environment = "preview", public = true },
    { name = "agendaprofe-preview-teacher-videos", env_prefix = "TEACHER_VIDEOS_R2", environment = "preview", public = true },
    { name = "agendaprofe-preview-student-photos", env_prefix = "STUDENT_PHOTOS_R2", environment = "preview", public = false },
    { name = "agendaprofe-preview-chat-audio", env_prefix = "CHAT_AUDIO_R2", environment = "preview", public = false },
    { name = "agendaprofe-preview-material-podcasts", env_prefix = "MATERIAL_PODCASTS_R2", environment = "preview", public = false },
    { name = "agendaprofe-preview-recordings", env_prefix = "LIVEKIT_EGRESS_S3", environment = "preview", public = false },
  ]
}
