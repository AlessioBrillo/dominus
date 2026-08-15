terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.48"
    }
  }
}

variable "project" { type = string }
variable "location" { type = string }
variable "server_type" { type = string }
variable "image_tag" { type = string }
variable "ssh_key_id" { type = number }
variable "network_id" { type = number }
variable "firewall_id" { type = number }
variable "db_password" {
  type      = string
  sensitive = true
}
variable "b2_backup" {
  type = object({
    enabled         = bool
    bucket          = string
    account_id      = string
    application_key = string
    endpoint        = string
  })
  sensitive = true
}

resource "hcloud_server" "db" {
  name         = "${var.project}-db"
  image        = "ubuntu-24.04"
  server_type  = var.server_type
  location     = var.location
  ssh_keys     = [var.ssh_key_id]
  firewall_ids = [var.firewall_id]
  user_data = templatefile("${path.module}/files/cloud-init.yaml.tftpl", {
    project       = var.project
    image_tag     = var.image_tag
    db_password   = var.db_password
    b2_enabled    = var.b2_backup.enabled
    b2_bucket     = var.b2_backup.bucket
    b2_account_id = var.b2_backup.account_id
    b2_app_key    = var.b2_backup.application_key
    b2_endpoint   = var.b2_backup.endpoint
  })
  network {
    network_id = var.network_id
    ip         = "10.0.0.3"
    alias_ips  = []
  }
  lifecycle {
    # The DB node must survive env rotations; rotate via SSH/cloud-init rerun
    # rather than a destructive recreate.
    ignore_changes = [user_data]
  }
}

output "private_ip" {
  value       = tolist(hcloud_server.db.network)[0].ip
  description = "Private address the app node connects to (10.0.0.3)."
}

output "public_ip" {
  value       = hcloud_server.db.ipv4_address
  description = "Public address (SSH administration only)."
}