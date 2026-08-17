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
variable "ssh_key_id" { type = number }
variable "network_id" { type = number }
variable "firewall_id" { type = number }
variable "domain" { type = string }
variable "image_tag" { type = string }
variable "db_host" { type = string }
variable "db_app_password" {
  type      = string
  sensitive = true
}
variable "app_env" {
  type      = map(string)
  sensitive = true
}

variable "alertmanager_webhook_url" {
  type        = string
  default     = ""
  description = "Webhook URL for Alertmanager (replaces the example.com placeholder in alertmanager.yml). Leave empty to keep the placeholder — a deployed node must never alert to a dead URL, so CI verifies the substitution mirrors this block."
}

locals {
  # METRICS_TOKEN with a commented Prometheus authorization block is a
  # silent-alerting trap: every scrape 401s and all rules go quiet. When
  # the token is set, the bearer block in deploy/prometheus/prometheus.yml
  # is activated here (marker lines + uncomment) and cloud-init writes the
  # token file mounted into the prometheus container. Mirrored in
  # .github/workflows/iac.yml so both branches stay render-verified.
  metrics_token = lookup(var.app_env, "METRICS_TOKEN", "")

  # alertmanager.yml ships with an example.com placeholder webhook; the
  # operator's real URL comes from the alertmanager_webhook_url variable.
  # Mirrored in .github/workflows/iac.yml so drift fails CI.
  alertmanager_yml = var.alertmanager_webhook_url != "" ? replace(
    file("${path.module}/../../../prometheus/alertmanager.yml"),
    "https://example.com/your-webhook",
    var.alertmanager_webhook_url,
  ) : file("${path.module}/../../../prometheus/alertmanager.yml")
  prometheus_yml   = local.metrics_token != "" ? replace(
    replace(
      replace(
        replace(
          replace(
            file("${path.module}/../../../prometheus/prometheus.yml"),
            "    # METRICS_TOKEN_RENDER:START\n", "",
          ),
          "    # METRICS_TOKEN_RENDER:END\n", "",
        ),
        "# authorization:", "authorization:",
      ),
      "#   type: Bearer", "  type: Bearer",
    ),
    "#   credentials_file: /etc/prometheus/metrics-token",
    "  credentials_file: /etc/prometheus/metrics-token",
  ) : file("${path.module}/../../../prometheus/prometheus.yml")
}

resource "hcloud_server" "app" {
  name         = "${var.project}-app"
  image        = "ubuntu-24.04"
  server_type  = var.server_type
  location     = var.location
  ssh_keys     = [var.ssh_key_id]
  firewall_ids = [var.firewall_id]
  user_data = templatefile("${path.module}/files/cloud-init.yaml.tftpl", {
    project           = var.project
    domain            = var.domain
    image_tag         = var.image_tag
    db_host           = var.db_host
    db_app_password   = var.db_app_password
    app_env           = var.app_env
    unbound_conf      = file("${path.module}/../../../unbound/unbound.conf")
    prometheus_yml    = local.prometheus_yml
    rules_yml         = file("${path.module}/../../../prometheus/rules.yml")
    alertmanager_yml  = local.alertmanager_yml
    metrics_token     = local.metrics_token
    metrics_token_set = local.metrics_token != ""
  })
  network {
    network_id = var.network_id
    ip         = "10.0.0.2"
    alias_ips  = []
  }
}

output "public_ip" {
  value       = hcloud_server.app.ipv4_address
  description = "Public address serving 80/443 (Caddy terminates TLS)."
}

output "private_ip" {
  value       = tolist(hcloud_server.app.network)[0].ip
  description = "Private address on 10.0.0.0/16."
}