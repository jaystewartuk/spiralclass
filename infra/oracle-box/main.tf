terraform {
  required_version = ">= 1.6"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }

  # LOCAL STATE, DELIBERATELY, AND ONLY FOR THE FIRST APPLY.
  #
  # The deleted infra/oracle-runner module declared an S3 backend against the
  # R2 bucket the sibling modules use (D-49). That is still the
  # right destination and this file should get there. It is not where the
  # FIRST apply happens, for one reason: this module has never been applied,
  # and D-139's whole complaint was a module asserting a state nobody had
  # reconciled. Adding a remote backend — its credentials, its bucket keys,
  # its init dance — to the same apply that first proves the module works
  # means two untested things failing at once with no way to tell which.
  #
  # Migrate with `tofu init -migrate-state` once a clean `tofu plan` is a
  # no-op against the running box, and delete this comment when you do.
  #
  # Until then state lives at $HOME/.tofu-state/spiralclass/oracle-box.tfstate
  # — outside this repository, on a stable path rather than inside a dated
  # capture directory, and holding `tailscale_authkey` in plaintext because
  # that is what OpenTofu does with sensitive variables. See README.
}

# Authenticates via the standard OCI SDK config file (~/.oci/config) or
# OCI_CLI_* env vars. NEVER hardcode API key material here or in tfvars.
#
# ⚠️ `oci session authenticate` writes a SECURITY TOKEN session, not an API
# key pair, and the provider will NOT find it on its own — the default auth
# mode is ApiKey and it fails with a misleading "can not create client"
# rather than saying the credential is the wrong shape. Hence auth being an
# explicit variable rather than a comment telling you to set an env var.
#
# A token session expires after an hour and refreshes (`oci session refresh`)
# to a 24-hour ceiling. Fine for a rebuild; wrong for anything scheduled, and
# wrong for CI. Switch oci_auth to "ApiKey" once a real key pair exists.
provider "oci" {
  auth                = var.oci_auth
  config_file_profile = var.oci_config_profile
  region              = var.region
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_id
}

# All images for the A1.Flex shape are arm64; filter to the aarch64 build
# (Oracle also lists an amd64 "24.04" entry under the same OS/version).
data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

locals {
  image_id = [
    for i in data.oci_core_images.ubuntu.images : i.id
    if strcontains(i.display_name, "aarch64")
  ][0]

  # Stable string keys instead of count's index-based identity, so a future
  # blue-green swap (adding "green" alongside "primary") never risks count's
  # destroy-highest-index-down semantics touching the wrong box.
  #
  # ⚠️ On 2026-09-04 that future is not reachable: Oracle cut the Always Free
  # A1 allowance to 2 OCPUs / 12 GB, measured `available: 0` against a limit
  # of 2, so a second instance cannot be launched at all. The key stays
  # because it costs nothing and the allowance may move again; do not read it
  # as a blue-green capability that exists today.
  instance_keys = toset(["primary"])

  instance_names = {
    for k in local.instance_keys : k => k == "primary" ? var.name_prefix : "${var.name_prefix}-${k}"
  }
}

# ── Networking ───────────────────────────────────────────────────────────
#
# One VCN, one public subnet, default route table pointed at an internet
# gateway. This reproduces what the hand-built box had, read off the running
# tenancy on 2026-09-04 rather than copied from the old module's template.

resource "oci_core_vcn" "box" {
  compartment_id = var.compartment_id
  display_name   = "${var.name_prefix}-vcn"
  cidr_blocks    = ["10.0.0.0/16"]
}

resource "oci_core_internet_gateway" "box" {
  compartment_id = var.compartment_id
  vcn_id         = oci_core_vcn.box.id
  display_name   = "${var.name_prefix}-igw"
  enabled        = true
}

resource "oci_core_default_route_table" "box" {
  manage_default_resource_id = oci_core_vcn.box.default_route_table_id
  display_name               = "${var.name_prefix}-default-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.box.id
  }
}

# ⚠️ The OCI security list is a SEPARATE control plane from the box's own
# iptables. Opening one without the other produces a box that looks correct
# and drops media. These rules are the exact set observed in `iptables -S
# INPUT` on the running box on 2026-09-04, and cloud-init lays down the
# matching iptables rules from the same list.
#
# ⚠️ The OCI default security list opens :22 to 0.0.0.0/0. That is the M-5
# finding and it must not stand: SSH here is Tailscale-only. `ssh_ingress_cidr`
# has NO default on purpose — that is a security decision, not a missing
# parameter, and the old module lost it when it was deleted.
resource "oci_core_default_security_list" "box" {
  manage_default_resource_id = oci_core_vcn.box.default_security_list_id
  display_name               = "${var.name_prefix}-default-seclist"

  egress_security_rules {
    destination      = "0.0.0.0/0"
    destination_type = "CIDR_BLOCK"
    protocol         = "all"
  }

  # ⚠️ THERE IS DELIBERATELY NO INGRESS RULE FOR :22, AND ADDING ONE IS A
  # REGRESSION.
  #
  # Tailscale needs no inbound port — it makes an outbound connection and does
  # its own NAT traversal, falling back to a DERP relay. So the box is fully
  # reachable with :22 closed to the entire internet, which is the whole point
  # of "SSH here is Tailscale-only" in ORACLE_BOX_REBUILD.md and the strong
  # form of the M-5 finding.
  #
  # An earlier draft of this file opened :22 to a single management address as
  # an escape hatch for a failed tailnet join. That was wrong twice over: it
  # spends the security property to buy the hatch, and the operator connects
  # from changing networks so the address goes stale within days. The real
  # out-of-band route is
  # the OCI serial console (see README), which reaches the box through the API
  # with no network, no open port and no fixed address — and which is what the
  # ssh_authorized_keys entry below actually exists for.

  ingress_security_rules {
    protocol    = "1" # ICMP
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    description = "ICMP path-MTU discovery"
    icmp_options {
      type = 3
      code = 4
    }
  }

  ingress_security_rules {
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    description = "HTTPS — LiveKit signaling (wss) and the preview web app, both via Caddy"
    tcp_options {
      min = 443
      max = 443
    }
  }

  ingress_security_rules {
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    description = "HTTP — ACME http-01 challenge, and Cloudflare's origin fetch"
    tcp_options {
      min = 80
      max = 80
    }
  }

  ingress_security_rules {
    protocol    = "6" # TCP
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    description = "LiveKit RTC TCP fallback"
    tcp_options {
      min = 7881
      max = 7881
    }
  }

  ingress_security_rules {
    protocol    = "17" # UDP
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    description = "LiveKit embedded TURN"
    udp_options {
      min = 3478
      max = 3478
    }
  }

  ingress_security_rules {
    protocol    = "17" # UDP
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    description = "LiveKit RTC media + TURN relay"
    udp_options {
      min = 50000
      max = 60000
    }
  }
}

resource "oci_core_subnet" "box" {
  compartment_id             = var.compartment_id
  vcn_id                     = oci_core_vcn.box.id
  display_name               = "${var.name_prefix}-subnet"
  cidr_block                 = "10.0.1.0/24"
  prohibit_public_ip_on_vnic = false
  route_table_id             = oci_core_vcn.box.default_route_table_id
}

# ── The box ──────────────────────────────────────────────────────────────

resource "oci_core_instance" "box" {
  for_each = local.instance_keys

  compartment_id      = var.compartment_id
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[0].name
  display_name        = local.instance_names[each.key]
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_in_gbs
  }

  create_vnic_details {
    subnet_id = oci_core_subnet.box.id

    # ⚠️ FALSE on purpose, and this is the one line most likely to be
    # "corrected" by a later reader. An ephemeral public IP dies with the
    # instance — that is how the old box's address was lost in this rebuild, and
    # OCI has no operation to convert an ephemeral address to a reserved
    # one. The reserved IP below is attached instead, so this box's address
    # survives the NEXT rebuild and DNS never has to move again.
    #
    # The cost is a window at first boot where the instance has no route to
    # the internet, because a subnet with only an internet gateway gives a
    # private-IP-only VNIC no egress. cloud-init blocks on connectivity
    # before it installs anything — see the wait loop at the top of
    # cloud-init.yaml.tftpl. Do not remove one without the other.
    assign_public_ip = false

    hostname_label = replace(local.instance_names[each.key], "_", "-")
  }

  source_details {
    source_type             = "image"
    source_id               = local.image_id
    boot_volume_size_in_gbs = var.boot_volume_gb
  }

  metadata = {
    # ⚠️ This key is NOT for :22 — that port is closed to the internet and
    # stays closed. It is the key the OCI **serial console** authenticates
    # with, which is the only way into a box whose tailnet join failed.
    #
    # The old box had no key at all (`~/.ssh/oracle_a1` never existed,
    # whatever the retired CI-runner runbook said), so a failed join meant a
    # rebuild. Creating the console connection is a separate, deliberate
    # act — see README — so this costs nothing while things are working.
    ssh_authorized_keys = file(pathexpand(var.ssh_public_key_file))

    user_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", {
      tailscale_authkey  = var.tailscale_authkey
      tailscale_hostname = local.instance_names[each.key]
      swap_gb            = var.swap_gb
    }))
  }

  # A1 capacity is contended in small regions and Querétaro has proved it —
  # the runbook says to expect retries. tofu does NOT retry "Out of host
  # capacity" itself; wrap `apply` in a retry loop rather than raising this.
  timeouts {
    create = "30m"
  }

  # ⚠️ TWO SEPARATE SOURCES OF SILENT DESTROY/RECREATE ARE PINNED HERE, AND
  # BOTH ARE FORCE-NEW ATTRIBUTES ON A BOX THAT CARRIES EVERY LIVE CLASS.
  #
  # `metadata` — the WHOLE map, not just user_data. Any drift in the rendered
  # cloud-init, or in the ssh key file, would otherwise force a replace.
  #
  # `source_details[0].source_id` — this is the one that would have bitten
  # without anyone touching the module. `local.image_id` takes the NEWEST
  # aarch64 Ubuntu 24.04 image (`sort_by = TIMECREATED`, `DESC`, then `[0]`),
  # so it changes on Canonical's release schedule rather than on a commit. The
  # attribute is ForceNew, so the first `tofu apply` run after any 24.04
  # respin plans a destroy and a recreate — and it fires at exactly the moment
  # README.md tells you to look for one: "migrate the state once a clean plan
  # is a no-op against the running box". Pinned to what is in state, so the
  # data source now only chooses the image for the FIRST apply.
  #
  # Rebuilding onto a newer image is therefore a deliberate `-replace`, which
  # is what it should have been all along. Note what that costs on this
  # tenancy: with `standard-a1-core-count` available 0, a replace destroys
  # before it creates and re-enters the "Out of host capacity" lottery with
  # nothing running. Read CUTOVER.md before you do it.
  #
  # Changing what the box RUNS is the deploy script's job, not this module's.
  lifecycle {
    ignore_changes = [
      metadata,
      source_details[0].source_id,
    ]
  }
}

# ── The address ──────────────────────────────────────────────────────────
#
# The tenancy allows exactly one reserved public IP (`reserved-public-ip-count`
# = 1, measured 2026-09-04) and used none. Spending it here is what makes the
# box's address outlive the box.

data "oci_core_vnic_attachments" "box" {
  for_each = local.instance_keys

  compartment_id = var.compartment_id
  instance_id    = oci_core_instance.box[each.key].id
}

data "oci_core_private_ips" "box" {
  for_each = local.instance_keys

  vnic_id = data.oci_core_vnic_attachments.box[each.key].vnic_attachments[0].vnic_id
}

resource "oci_core_public_ip" "box" {
  for_each = local.instance_keys

  compartment_id = var.compartment_id
  display_name   = "${local.instance_names[each.key]}-ip"
  lifetime       = "RESERVED"
  private_ip_id  = data.oci_core_private_ips.box[each.key].private_ips[0].id
}
