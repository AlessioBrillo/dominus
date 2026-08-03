# DOMINUS — Multi-stage production build
# Requires Docker BuildKit (default since Docker 23.0).
#
# Build targets:
#   docker build --target api    -t dominus-api:latest .
#   docker build --target worker -t dominus-worker:latest .
#   docker build --target scheduler -t dominus-scheduler:latest .
#
# Run:
#   docker run -d -p 3000:3000 -v ./data:/app/data dominus-api
#   docker run -d -v ./data:/app/data dominus-worker
#   docker run -d -v ./data:/app/data dominus-scheduler

ARG NODE_VERSION=22

# ---- Stage 1: Install production dependencies ----
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts keeps arbitrary install scripts from running during the
# build (supply-chain hygiene). better-sqlite3 is the deliberate exception:
# its native binding is produced by its install script (prebuild-install),
# which --ignore-scripts skips — without an explicit rebuild the runtime
# images would crash on require('better-sqlite3'). The toolchain is a safety
# net for the node-gyp fallback when no prebuilt binary matches the target;
# it lives only in this stage and never reaches the runtime images (only
# node_modules is copied out of it).
RUN npm ci --only=production --ignore-scripts \
  && apk add --no-cache python3 make g++ \
  && npm rebuild better-sqlite3

# ---- Stage 2: Backend Build ----
FROM node:${NODE_VERSION}-alpine AS backend-build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src/ src/
RUN npm ci && npm run build

# ---- Stage 3: Frontend Build (API only) ----
FROM node:${NODE_VERSION}-alpine AS frontend-build
WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ---- Stage 4: API Server (Express + SPA) ----
FROM node:${NODE_VERSION}-alpine AS api
WORKDIR /app

RUN addgroup -S dominus && adduser -S dominus -G dominus

COPY --from=deps --chown=dominus:dominus /app/node_modules node_modules/
COPY --from=backend-build --chown=dominus:dominus /app/dist dist/
COPY --from=frontend-build --chown=dominus:dominus /app/dist frontend/dist/
COPY --chown=dominus:dominus package.json ./
COPY --chown=dominus:dominus LICENSE THIRD-PARTY-NOTICES.md /licenses/

USER dominus

EXPOSE 3000

ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/dominus.db \
    FRONTEND_DIST_PATH=./frontend/dist \
    WORKER_ENABLED=false \
    SCHEDULER_ENABLED=false

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node dist/app/healthcheck-cli.js

ENTRYPOINT ["node"]
CMD ["dist/index.js"]

# ---- Stage 5: Job Worker (no HTTP listener) ----
FROM node:${NODE_VERSION}-alpine AS worker
WORKDIR /app

RUN addgroup -S dominus && adduser -S dominus -G dominus

COPY --from=deps --chown=dominus:dominus /app/node_modules node_modules/
COPY --from=backend-build --chown=dominus:dominus /app/dist dist/
COPY --chown=dominus:dominus package.json ./
COPY --chown=dominus:dominus LICENSE THIRD-PARTY-NOTICES.md /licenses/

# Backup mount point: pre-created with the runtime user's ownership so a
# fresh named volume (`docker compose ... up -d`) inherits dominus:dominus
# on first mount and BACKUP_DIR stays writable for the non-root user.
RUN mkdir -p /backups && chown dominus:dominus /backups
VOLUME ["/backups"]

USER dominus

ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/dominus.db \
    WORKER_ENABLED=true \
    SCHEDULER_ENABLED=false \
    PORT=0

# Internal healthcheck HTTP listener on loopback (9090) — not exposed

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9090/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node"]
CMD ["dist/worker-entrypoint.js"]

# ---- Stage 6: Scheduler (lightweight cron container) ----
FROM node:${NODE_VERSION}-alpine AS scheduler
WORKDIR /app

RUN addgroup -S dominus && adduser -S dominus -G dominus

COPY --from=deps --chown=dominus:dominus /app/node_modules node_modules/
COPY --from=backend-build --chown=dominus:dominus /app/dist dist/
COPY --chown=dominus:dominus package.json ./
COPY --chown=dominus:dominus LICENSE THIRD-PARTY-NOTICES.md /licenses/

# Backup mount point: pre-created with the runtime user's ownership so a
# fresh named volume (`docker compose ... up -d`) inherits dominus:dominus
# on first mount and BACKUP_DIR stays writable for the non-root user.
RUN mkdir -p /backups && chown dominus:dominus /backups
VOLUME ["/backups"]

USER dominus

ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/dominus.db \
    WORKER_ENABLED=false \
    SCHEDULER_ENABLED=true \
    PORT=0

# Internal healthcheck HTTP listener on loopback (9091) — not exposed

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9091/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node"]
CMD ["dist/scheduler-entrypoint.js"]
