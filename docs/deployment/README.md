# Deployment Guide

DOMINUS is designed to run anywhere — from a laptop to a Kubernetes cluster. Choose the option that fits your scale.

## Quick Start (Docker)

```bash
# Build and run
docker compose up -d

# Or use the production profile with resource limits
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

The server listens on `http://localhost:3000` by default. Set `HOST=0.0.0.0` in `.env` to expose on all interfaces (required behind a reverse proxy).

## Options

| Method | When to use | Commands |
|--------|-------------|---------|
| **CLI only** | Personal use, one-off scoring | `dominus run --closeout-csv candidates.csv` |
| **Docker** | Growing portfolio, REST API needed | `docker compose up -d` |
| **Docker + reverse proxy** | Public-facing API | Add nginx/Caddy in front |
| **systemd** | Bare-metal Linux server | `systemctl enable dominus` |
| **PM2** | Node.js process management | `pm2 start ecosystem.config.cjs` |
| **Kubernetes** | Enterprise, high availability | `kubectl apply -f deploy/` |

## Architecture

```
Internet ──► Reverse Proxy (nginx/Caddy) ──► DOMINUS (port 3000) ──► SQLite (data/dominus.db)
                                                      │
                                                      ├── CLI (direct access)
                                                      └── Scheduler (cron jobs)
```

## Reverse Proxy

### Nginx
Copy `docs/deployment/nginx.conf` to your nginx configuration directory, adjust the `server_name` and SSL certificate paths, then reload nginx:

```bash
sudo cp docs/deployment/nginx.conf /etc/nginx/sites-available/dominus
sudo ln -s /etc/nginx/sites-available/dominus /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Caddy
```caddyfile
dominus.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

## Bare Metal

### systemd
```bash
sudo useradd -r -s /bin/false dominus
sudo mkdir -p /opt/dominus/data
sudo cp -r dist node_modules package.json /opt/dominus/
sudo cp docs/deployment/dominus.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dominus
```

### PM2
```bash
npm install -g pm2
cp docs/deployment/ecosystem.config.cjs .
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the instructions to enable boot-start
```

## Data Persistence

The SQLite database lives at `DATABASE_PATH` (default: `./data/dominus.db`). **This file is your entire portfolio and configuration — back it up.**

```bash
# Built-in backup (VACUUM INTO)
dominus maintenance backup ./backups/dominus-$(date +%Y%m%d).db

# Or with SQLite directly
sqlite3 data/dominus.db ".backup ./backups/dominus-$(date +%Y%m%d).db"
```

## Environment Variables

All configuration is via environment variables. See `.env.example` for the full reference.

Key variables for deployment:

| Variable | Default | Notes |
|----------|---------|-------|
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` behind reverse proxy |
| `PORT` | `3000` | Container port mapping |
| `DATABASE_PATH` | `./data/dominus.db` | Must be writable; use a volume mount in Docker |
| `API_KEYS` | (empty) | **Set this in production** to enable authentication |
| `SCHEDULER_ENABLED` | `false` | Enable for automated renewal checks, rescoring, pruning |
| `LOG_LEVEL` | `info` | Set to `warn` in production to reduce noise |

## Security Checklist

- [ ] Set `API_KEYS` to enable REST authentication
- [ ] Run behind a reverse proxy with HTTPS (TLS 1.2+)
- [ ] Restrict `HOST` to `127.0.0.1` unless proxied
- [ ] Set `RATE_LIMIT_MAX` to protect against abuse
- [ ] Use a non-root user (Docker: `USER dominus`, systemd: `User=dominus`)
- [ ] Back up the SQLite database daily
- [ ] Keep the `data/` directory in `.gitignore`
- [ ] Review logs periodically (`journalctl -u dominus`)
