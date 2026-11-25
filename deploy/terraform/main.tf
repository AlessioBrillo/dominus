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
# user_data at apply time. The state file holds the same values, so it
# is a secret store too and must live off the developer machine — see
# backend.hcl.example and docs/operations/secrets.md.
#
# SSH ingress is closed by default: the operator's CIDRs must be listed
# (ssh_allowed_cidrs) or the exposure must be accepted explicitly
# (allow_public_ssh) — an apply that does neither is refused.

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

  # Remote state: the state is not a cache of the plan, it is a secret
  # store. It holds every secret that is rendered into cloud-init
  # user_data — the three DB passwords, the B2 application key and the
  # whole app_env map (STRIPE_*, METRICS_TOKEN, API_KEYS) — and every
  # apply rewrites it. A local terraform.tfstate is therefore plaintext
  # secrets on a machine that can be lost, stolen or swept into a backup
  # service: the state must not live on a laptop. (The Hetzner API token
  # is a provider credential and is not persisted in the state, but it
  # sits in terraform.tfvars on the same machine — the machine holds the
  # whole set either way.)
  #
  # Move it off the machine — Backblaze B2 is the cost-free
  # S3-compatible option. Copy backend.hcl.example to backend.hcl, fill
  # in the bucket, and initialise with the partial configuration:
  #
  #   terraform init -backend-config=backend.hcl
  #
  # backend.hcl carries the bucket coordinates and, if the credentials
  # are written into it, the access key that can read and write the
  # state: gitignore it exactly like terraform.tfvars.
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

variable "ssh_allowed_cidrs" {
  type        = list(string)
  default     = []
  description = <<-EOT
    CIDR allowlist for SSH ingress on both nodes. The default is EMPTY and
    an apply with an empty allowlist is REFUSED (both firewalls carry a
    precondition): an SSH port open to the whole internet is a standing
    invitation, and a permissive default that "existing deployments"
    depend on is a default that never gets restricted. List the
    operator's own networks here — e.g. ["203.0.113.10/32"] — or set
    allow_public_ssh = true and accept the documented risk.

    Caveat: the release pipeline (deploy.yml) reaches the app node over
    SSH from GitHub Actions runners, whose egress IPs are dynamic — a
    restricted app node needs a static-egress runner or another deploy
    transport, while the db node (operator-only SSH) can be restricted
    freely. Until such a runner exists, allow_public_ssh = true is the
    deliberate choice, not an accident.
  EOT
}

variable "allow_public_ssh" {
  type        = bool
  default     = false
  description = <<-EOT
    Explicit opt-in to SSH ingress from any address. When true, the
    effective allowlist is ["0.0.0.0/0", "::/0"] on both nodes and the
    firewall precondition passes. The risk, stated in full: anyone on the
    internet can reach port 22 and try a key. The nodes answer key-only
    (PasswordAuthentication no) and fail2ban throttles the guessing
    (3 attempts, 1h ban), which raises the cost of an attempt without
    removing it — a compromised operator key becomes world-reachable, and
    the scan traffic is not free either. Keep this false and list the
    operator's CIDRs whenever a static-egress deploy runner exists: the
    decision is then recorded in the state instead of being made by
    omission.
  EOT
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
  description = "GHCR image tag rendered into cloud-init user_data at provision time (digest-pinned, ADR-0046). Only consulted at first provision: the rendered compose references DOMINUS_IMAGE_TAG from .env at runtime, and user_data carries ignore_changes so a later `terraform apply` never recreates the node (and destroys its volumes). Release bumps go through the deploy pipeline (deploy.yml → rollout.sh), not a Terraform apply. There is no default on purpose: a default is a release frozen at the time this file was written — the v1.3.0 tree still defaulted to v1.2.0, so a first apply booted the previous release's image while the operator believed they were deploying the current one. The tag is a per-deployment decision, and scripts/check-release-consistency.mjs fails the build if a default comes back."
}

variable "app_env" {
  type        = map(string)
  description = "Extra environment variables for api/worker/scheduler (API_KEYS, STRIPE_*, METRICS_TOKEN, ...)."
  default     = {}
  sensitive   = true
}

variable "alertmanager_webhook_url" {
  type        = string
  default     = ""
  description = "Webhook URL for Alertmanager (replaces the example.com placeholder in alertmanager.yml). Optional: leave empty to keep the placeholder."
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

locals {
  # The effective SSH allowlist, resolved once: the operator's CIDRs, or —
  # only when the operator explicitly opted in — the whole internet. Both
  # firewalls read this instead of the variable, so the precondition and
  # the applied rule can never disagree about what is admitted.
  ssh_allowed_cidrs = var.allow_public_ssh ? ["0.0.0.0/0", "::/0"] : var.ssh_allowed_cidrs
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
    source_ips  = local.ssh_allowed_cidrs
    description = "SSH"
  }

  # Fail closed on the admin port. The rule above is only as safe as the
  # allowlist behind it: an empty list admits nobody (the operator
  # locks themselves out of a node they may have to rebuild), and a
  # silent widening to 0.0.0.0/0 admits everybody. Neither is a decision
  # an apply should make on the operator's behalf, so the apply is
  # refused until the decision is written down.
  lifecycle {
    precondition {
      condition     = var.allow_public_ssh || length(local.ssh_allowed_cidrs) > 0
      error_message = "SSH ingress is undecided on the app node: ssh_allowed_cidrs is empty and allow_public_ssh is false, so port 22 would be closed to every source — including the operator — and the apply is refused rather than shipping that. Set ssh_allowed_cidrs to the operator's own CIDRs (e.g. [\"203.0.113.10/32\"]), or set allow_public_ssh = true to accept the documented risk of key-only SSH with fail2ban throttling from any address."
    }
  }
}

# The database node exposes nothing publicly: SSH for administration only.
# Postgres stays on the private network; without this firewall the 5432
# port would be reachable from the internet. The operator-only SSH surface
# is free to be restricted to static CIDRs (unlike the app node, which the
# GitHub Actions deploy pipeline must reach).
resource "hcloud_firewall" "db_ssh" {
  name = "${var.project}-db-ssh"

  rule {
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = local.ssh_allowed_cidrs
    description = "SSH (administration)"
  }

  # Same fail-closed gate as the app node's firewall, and it matters
  # more here: this node holds the database and the PITR credentials.
  lifecycle {
    precondition {
      condition     = var.allow_public_ssh || length(local.ssh_allowed_cidrs) > 0
      error_message = "SSH ingress is undecided on the db node: ssh_allowed_cidrs is empty and allow_public_ssh is false, so port 22 would be closed to every source — including the operator — and the apply is refused rather than shipping that. Set ssh_allowed_cidrs to the operator's own CIDRs (e.g. [\"203.0.113.10/32\"]), or set allow_public_ssh = true to accept the documented risk of key-only SSH with fail2ban throttling from any address."
    }
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

  project                  = var.project
  location                 = var.location
  server_type              = var.app_server_type
  ssh_key_id               = hcloud_ssh_key.operator.id
  network_id               = hcloud_network.private.id
  firewall_id              = hcloud_firewall.public.id
  domain                   = var.domain
  image_tag                = var.image_tag
  app_env                  = var.app_env
  db_host                  = module.db_node.private_ip
  db_app_password          = var.db_app_password
  alertmanager_webhook_url = var.alertmanager_webhook_url
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