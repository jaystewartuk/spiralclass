variable "compartment_id" {
  description = <<-EOT
    OCID of the compartment the box lives in. On this tenancy that is the
    tenancy OCID itself — there are no sub-compartments.
  EOT
  type        = string
}

variable "name_prefix" {
  description = <<-EOT
    Display-name prefix for every resource, and the box's Tailscale hostname.

    The running box is called `oracle-a1-runner`, which is a fossil: the CI
    runner role it names was retired in 2026-07, after three reversals in as
    many days. Keeping the old name would carry a lie into a file whose whole
    purpose is to describe the box accurately, so the default is the honest
    one — but changing it changes the tailnet hostname, and anything that
    reaches the box by name has to move with it.
  EOT
  type        = string
  default     = "spiralclass-box"
}

variable "ocpus" {
  description = <<-EOT
    A1 cores. 2 is both what the box has and, since Oracle halved the Always
    Free allowance, the entire tenancy limit — `standard-a1-core-count` reads
    2 with 2 used and 0 available. Raising this cannot work without a service
    limit increase, and the launch is REJECTED rather than billed.
  EOT
  type        = number
  default     = 2
}

variable "memory_in_gbs" {
  description = <<-EOT
    Memory. As with ocpus, 12 is the whole Always Free allowance now, not half
    of it. Measured on the running box: 11,927 MB total, 2,119 MB used, with
    all five LiveKit containers together holding 703 MB.
  EOT
  type        = number
  default     = 12
}

variable "boot_volume_gb" {
  description = <<-EOT
    Boot volume size. The old box's was 47 GB and ran at 63% with 17 GB free,
    of which about 7 GB was reclaimable stale images and build cache.

    200 — the entire Always Free block-storage allowance, on one volume.

    ⚠️ THIS COUPLES TO THE TERMINATE, and getting the order wrong fails the
    apply. `total-storage-gb` is a hard 200. The old box's boot volume is
    47 GB, so 200 + 47 does not fit: the old volume must be GONE, not
    preserved, before this can be created. The operator chose that
    deliberately on 2026-09-04 — terminate without `--preserve-boot-volume`.

    That trade is smaller than it sounds. A preserved boot volume only helps
    if an instance can be launched to attach it to, and the failure this
    rebuild is actually exposed to is "Out of host capacity" — where a spare
    volume is worth nothing. The real fallback is the capture in
    ~/oracle-capture-2026-09-04: config, the ACME account key and
    certificates, both images, and a scripted deploy.

    ⚠️ The reason to want the maximum is NOT space. Realistic consumption is
    30-40 GB: about 8.5 GB of images (egress alone is 4.59 GB), image churn on
    each deploy, the preview database, and logs. The old box sat at 63% of
    47 GB carrying LiveKit alone.

    The reason is IOPS. At a fixed `vpus-per-gb` — 10, Balanced, as the old box
    ran — OCI scales a volume's performance with its SIZE, so the largest
    volume the allowance permits is also the fastest one it permits. That
    matters now that this machine runs Postgres and Docker beside a video
    relay rather than LiveKit alone, and it costs nothing, because unused
    allowance is not banked for anything else.
  EOT
  type        = number
  default     = 200
}

variable "swap_gb" {
  description = <<-EOT
    Swap file size. The running box had a 4 GB swapfile that appears in no
    decision record and no runbook — found by reading the box on 2026-09-04.
    It was barely touched (27 MB) but it is real headroom on a machine with
    no memory to spare, so it is reproduced rather than quietly dropped.
  EOT
  type        = number
  default     = 4
}

variable "ssh_public_key_file" {
  description = <<-EOT
    Public key placed in the instance's authorized_keys at launch.

    ⚠️ NOT for tcp/22 — that port is closed to the internet in the security
    list and stays closed. This is the key the OCI **serial console**
    authenticates with, and the serial console is the only way into a box
    whose tailnet join failed: it goes through the OCI API, needs no network
    on the instance, no open port, and no fixed address on the operator's
    side.

    The old box had no key at all, so a failed join there meant a rebuild.
  EOT
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "tailscale_authkey" {
  description = <<-EOT
    Tailscale auth key used by cloud-init to join the tailnet.

    ⚠️ ORACLE_BOX_REBUILD.md and the private rotation runbook both claim Infisical
    holds this as `tailscale_authkey_oracle`. On 2026-09-04 it did not, and
    neither did anything else — production Infisical has exactly two paths,
    `/` with 22 secrets and `/config` with 15, and the key is in neither.
    That claim was discovered to be false in the middle of a rebuild, which
    is the worst moment to discover it. Fix the docs, or put a key there.

    Pass via TF_VAR_tailscale_authkey from a file, never in tfvars.
  EOT
  type        = string
  sensitive   = true
}

variable "region" {
  description = <<-EOT
    OCI region. ⚠️ Not a free choice: Always Free resources can only exist in
    the tenancy's HOME region, and this tenancy's home is Querétaro. D-150
    measured what that costs — 58 ms to Neon's aws-us-east-2 against the Fly
    machine's 12 ms — and concluded nothing available fixes it.
  EOT
  type        = string
  default     = "mx-queretaro-1"
}

variable "oci_auth" {
  description = <<-EOT
    Provider auth mode. "SecurityToken" matches what `oci session
    authenticate` produces; "ApiKey" is the durable form and is what CI or
    anything scheduled needs, since a token session dies within 24 hours.
  EOT
  type        = string
  default     = "SecurityToken"

  validation {
    condition     = contains(["SecurityToken", "ApiKey", "InstancePrincipal"], var.oci_auth)
    error_message = "oci_auth must be SecurityToken, ApiKey or InstancePrincipal."
  }
}

variable "oci_config_profile" {
  description = "Profile name inside ~/.oci/config."
  type        = string
  default     = "DEFAULT"
}
