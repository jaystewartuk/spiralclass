output "instance_ids" {
  description = "OCIDs of the box(es), keyed as in local.instance_keys."
  value       = { for k, v in oci_core_instance.box : k => v.id }
}

output "public_ips" {
  description = <<-EOT
    The RESERVED public addresses. These are what Cloudflare's A records
    point at, and — unlike the ephemeral address this rebuild lost — they
    survive the next rebuild, so DNS should never need to move again.
  EOT
  value       = { for k, v in oci_core_public_ip.box : k => v.ip_address }
}

output "private_ips" {
  description = "In-VCN addresses, for reference when reading the VNIC."
  value       = { for k, v in data.oci_core_private_ips.box : k => v.private_ips[0].ip_address }
}

output "tailscale_hostnames" {
  description = <<-EOT
    The names the box joins the tailnet under. `ssh ubuntu@<name>` is the
    normal way in; the reserved public IP is for Cloudflare, not for humans.
  EOT
  value       = local.instance_names
}

output "next_steps" {
  description = "What is deliberately NOT done by this module."
  value       = <<-EOT
    1. Disable Tailscale key expiry for the node, in the admin console.
       cloud-init cannot do it, and skipping it lapses SSH in 180 days.
    2. Run scripts/oracle-deploy.sh to lay down the LiveKit stack, the
       preview web app and preview's Postgres. Production is on Fly and is
       not deployed from here.
    3. Point the livekit and preview A records at public_ips above. NOT the
       apex — spiralclass.com stays on Fly.
    4. Migrate this module's state off the local file — see main.tf.
  EOT
}
