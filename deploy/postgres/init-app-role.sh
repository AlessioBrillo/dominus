#!/bin/sh
# Provision the non-superuser application role for multi-tenant isolation.
#
# The app must NOT connect as the POSTGRES_USER superuser: superusers bypass
# row-level security even with FORCE ROW LEVEL SECURITY (migration 0047),
# so tenant isolation would silently rest on application-level filters alone.
#
# This runs once, on first database initialisation (docker-entrypoint-initdb.d).
# Default privileges make every table/sequence created later by migrations
# accessible to the app role automatically.
set -e

: "${DOMINUS_APP_PASSWORD:?DOMINUS_APP_PASSWORD must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dominus_app') THEN
      CREATE ROLE dominus_app LOGIN PASSWORD '${DOMINUS_APP_PASSWORD}';
    END IF;
  END
  \$\$;

  GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO dominus_app;
  GRANT USAGE ON SCHEMA public TO dominus_app;
  GRANT CREATE ON SCHEMA public TO dominus_app;

  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dominus_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dominus_app;

  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dominus_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO dominus_app;

  -- pg_current_wal_lsn() is restricted to the pg_monitor role: the app's
  -- pitr-health job reads WAL lag (ADR-0054), so the app role needs it.
  GRANT pg_monitor TO dominus_app;
EOSQL
