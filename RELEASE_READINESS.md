# DOMINUS v1.0.0 — Release Readiness Checklist

This document outlines the mandatory operational tasks to finalize the DOMINUS v1.0.0 public release.

## 1. Environment Preparation (Staging/Production)
Before deploying to production, ensure the following environment variables are set in your `.env`:
- `PUBLIC_APP_URL`: Set to your production domain (e.g., `https://dominus.example.com`)
- `TRUST_PROXY_DEPTH`: Set if behind a reverse proxy (e.g., `1`)
- `METRICS_TOKEN`: Secure token for metrics endpoint access.
- `SENTRY_DSN`: (Cloud Only) Set to enable sanitized telemetry.

## 2. PostgreSQL Operations (DOMINUS Cloud)
Ensure the database node is initialized:
```bash
# Initialize application roles
./deploy/postgres/init-app-role.sh

# Run initial base backup for PITR
./deploy/postgres/base-backup.sh
```

## 3. Monitoring & Observability
Ensure Grafana and Prometheus are correctly provisioned:
- Verify `deploy/prometheus/prometheus.yml` targets.
- Grafana dashboards are automatically provisioned via `deploy/grafana/provisioning/dashboards/`.

## 4. Release Validation
Before tagging the final `v1.0.0`:
1. Run local smoke tests: `npm run gate:docker`
2. Run healthcheck: `npm run launch:check -- --url <your-production-url>`
3. Check legal compliance: `npm run license:check`

## 5. Deployment
- Tag the repository: `git tag -a v1.0.0 -m "Release v1.0.0"`
- Push to origin: `git push origin v1.0.0`
- Build and publish Docker images.
