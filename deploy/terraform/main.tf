# DOMINUS Cloud — Hetzner provisioning (v1.0.0).
#
# Two-node topology on a private network, keeping the cost discipline of
# ADR-0001/ADR-0026 (no managed database, no managed load balancer):
#
#   db-node   (CX22)  PostgreSQL 17 + PITR (base backups + WAL to B2)
#   app-node  (CX32)  docker compose (api + worker + scheduler + redis)
#                     + Caddy reverse proxy (TLS via Let's Encrypt)
#
# The Caddy proxy is co-located on the app node: a separate proxy VPS for
# a single origin is overhead, not architecture. The DB listens only on
# the private network (10.0.0.0/16); the public firewall admits 80/443
# and SSH only.
#
# Secrets (B2 keys, DB passwords, Stripe/API keys) are never committed:
# they live in terraform.tfvars (gitignored) and flow into cloud-init
# user_data at apply time.

terraform {
  required_version = ">= 1.6"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.48"
    }
    hetznerdns = {
      source  = "timohirt/hetznerdns"
      version = "~> 2.2"
    }
  }

  # Remote state: keep it off the developer machine. Backblaze B2 is the
  # cost-free option (S3-compatible) — uncomment and fill in credentials
  # before `terraform init` in a team setup:
  #
  # backend "s3" {
  #   bucket                      = "dominus-tfstate"
  #   key                         = "dominus/terraform.tfstate"
  #   region                      = "us-east-005"
  #   endpoint                    = "https://s3.us-east-005.backblazeb2.com"
  #   skip_credentials_validation = true
  #   skip_region_validation      = true
  # }
}

variable "hcloud_token" {
  type        = string
  sensitive   = true
  description = "Hetzner Cloud API token (terraform.tfvars, never committed)."
}

variable "ssh_public_key" {
  type        = string
  description = "Operator SSH public key installed on both nodes."
}

variable "project" {
  type        = string
  default     = "dominus"
  description = "Resource name prefix."
}

variable "location" {
  type        = string
  default     = "fsn1"
  description = "Hetzner location (fsn1 Falkenstein / nbg1 Nuremberg / hel1 Helsinki)."
}

variable "domain" {
  type        = string
  description = "Public DNS name served by Caddy, e.g. app.dominus.example."
}

variable "image_tag" {
  type        = string
  default     = "v0.11.0"
  description = "GHCR image tag to deploy (digest-pinned at apply, ADR-0046). Only consulted at provision time: the rendered compose references DOMINUS_IMAGE_TAG from .env at runtime, so release bumps go through the deploy pipeline (deploy.yml), never a Terraform apply — user_data is ForceNew and an apply would recreate the node and lose the named volumes."
}

variable "app_env" {
  type        = map(string)
  description = "Extra environment variables for api/worker/scheduler (API_KEYS, STRIPE_*, JWT_*, ...)."
  default     = {}
  sensitive   = true
}

variable "db_password" {
  type        = string
  sensitive   = true
  description = "Password for the dominus owner role (db administration; never used by the app)."
}

variable "db_backup_password" {
  type        = string
  sensitive   = true
  description = "Password for the backup role (REPLICATION only, used by the daily PITR cron via /opt/dominus/backup.env, ADR-0054)."
}

variable "db_app_password" {
  type        = string
  sensitive   = true
  description = "Password for the dominus_app role — the RLS-scoped app connection (ADR-0038/0047)."
}

variable "b2_backup" {
  type = object({
    enabled         = bool
    bucket          = string
    account_id      = string
    application_key = string
    endpoint        = string
  })
  default = {
    enabled         = true
    bucket          = ""
    account_id      = ""
    application_key = ""
    endpoint        = "https://s3.eu-central-003.backblazeb2.com"
  }
  sensitive   = true
  description = "Backblaze B2 credentials for the PITR WAL archive (ADR-0054). On by default: an apply with enabled but empty credentials fails via precondition — a db-node loss without an off-host archive is total data loss, so the unprotected state must be an explicit, documented opt-out, never a forgotten flag."
}

variable "app_server_type" {
  type    = string
  default = "cx32"
}

variable "db_server_type" {
  type    = string
  default = "cx22"
}

variable "hetzner_dns_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Hetzner DNS API token. When set, the app A record is managed here; leave empty to use an external registrar (ADR-0051 DNS operated via Hetzner DNS)."
}

variable "dns_zone_name" {
  type        = string
  default     = ""
  description = "Existing Hetzner DNS zone for the A record (required when hetzner_dns_token is set)."
}

provider "hcloud" {
  token = var.hcloud_token
}

provider "hetznerdns" {
  apitoken = var.hetzner_dns_token
}

resource "hcloud_ssh_key" "operator" {
  name       = "${var.project}-operator"
  public_key = var.ssh_public_key
}

resource "hcloud_network" "private" {
  name     = "${var.project}-net"
  ip_range = "10.0.0.0/16"
}

resource "hcloud_network_subnet" "private" {
  network_id   = hcloud_network.private.id
  type         = "server"
  network_zone = "eu-central"
  ip_range     = "10.0.0.0/16"
}

resource "hcloud_firewall" "public" {
  name = "${var.project}-public"

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "HTTP (Caddy ACME + redirect)"
  }
  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "HTTPS"
  }
  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "SSH"
  }
}

# The database node exposes nothing publicly: SSH for administration only.
# Postgres stays on the private network; without this firewall the 5432
# port would be reachable from the internet.
resource "hcloud_firewall" "db_ssh" {
  name = "${var.project}-db-ssh"

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = ["0.0.0.0/0", "::/0"]
    description = "SSH (administration)"
  }
}

module "db_node" {
  source = "./modules/db-node"

  project            = var.project
  location           = var.location
  server_type        = var.db_server_type
  ssh_key_id         = hcloud_ssh_key.operator.id
  network_id         = hcloud_network.private.id
  firewall_id        = hcloud_firewall.db_ssh.id
  image_tag          = var.image_tag
  db_password        = var.db_password
  db_backup_password = var.db_backup_password
  db_app_password    = var.db_app_password
  b2_backup          = var.b2_backup
}

module "app_node" {
  source = "./modules/app-node"

  project         = var.project
  location        = var.location
  server_type     = var.app_server_type
  ssh_key_id      = hcloud_ssh_key.operator.id
  network_id      = hcloud_network.private.id
  firewall_id     = hcloud_firewall.public.id
  domain          = var.domain
  image_tag       = var.image_tag
  app_env         = var.app_env
  db_host         = module.db_node.private_ip
  db_app_password = var.db_app_password
}

# DNS: point the domain at the app node. When a Hetzner DNS token is
# configured, the A record is created here at apply time; otherwise the
# operator points the registrar's record at app_public_ip manually.
data "hetznerdns_zone" "main" {
  count = var.hetzner_dns_token != "" ? 1 : 0
  name  = var.dns_zone_name
}

resource "hetznerdns_record" "app" {
  count   = var.hetzner_dns_token != "" ? 1 : 0
  zone_id = data.hetznerdns_zone.main[0].id
  name    = var.domain != "" ? split(".", var.domain)[0] : "app"
  type    = "A"
  value   = module.app_node.public_ip
  ttl     = 60
}

output "app_public_ip" {
  value = module.app_node.public_ip
}

output "db_private_ip" {
  value = module.db_node.private_ip
}

output "app_url" {
  value       = var.domain != "" ? "https://${var.domain}" : "http://${module.app_node.public_ip}"
  description = "Point the domain A record at app_public_ip, then use this URL."
}