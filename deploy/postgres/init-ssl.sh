#!/bin/sh
# Enable TLS on the Postgres server (single-node prod compose path).
#
# Runs once from docker-entrypoint-initdb.d on first initialisation. The
# self-signed certificate lives on the pgdata volume, so it survives
# container recreation; a volume wipe generates a fresh one, which is
# fine — nothing pins the cert, the app connects with sslmode=require
# and verifies the server identity (private network, SCRAM auth).
set -e

SSL_DIR=/var/lib/postgresql/ssl
mkdir -p "$SSL_DIR"
chown postgres:postgres "$SSL_DIR"
chmod 700 "$SSL_DIR"

if [ ! -f "$SSL_DIR/server.crt" ]; then
  # postgres:*-alpine does not ship the openssl CLI; the alpine variant
  # of the image has apk, so bootstrap it on first boot only.
  command -v openssl >/dev/null 2>&1 || apk add --no-cache openssl
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -subj "/CN=postgres" \
    -keyout "$SSL_DIR/server.key" \
    -out "$SSL_DIR/server.crt" >/dev/null 2>&1
  chmod 600 "$SSL_DIR/server.key"
  chown postgres:postgres "$SSL_DIR/server.key" "$SSL_DIR/server.crt"
fi

# SSL-preferred ordering: hostssl rows are inserted BEFORE the image's
# default host rows, so TLS-capable clients (the app with
# sslmode=require) always negotiate TLS while pre-existing non-SSL
# clients keep working — enabling TLS is not a breaking change here,
# unlike the terraform path which enforces hostssl-only.
PG_HBA="${PGDATA:-/var/lib/postgresql/data}/pg_hba.conf"
if [ -f "$PG_HBA" ] && ! grep -q '^hostssl all all 0.0.0.0/0' "$PG_HBA"; then
  sed -i \
    -e 's|^host    all             all             0.0.0.0/0            scram-sha-256$|hostssl all all 0.0.0.0/0 scram-sha-256\n&|' \
    -e 's|^host    all             all             ::/0                 scram-sha-256$|hostssl all all ::/0 scram-sha-256\n&|' \
    "$PG_HBA"
fi