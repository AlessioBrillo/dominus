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

# Immutable base image (ADR-0046): pinned by digest so a retagged
# node:22-alpine cannot silently inject new CVEs into the build. Bump the
# digest deliberately along with an upstream release with:
#   docker buildx imagetools inspect node:22-alpine --format '{{.Manifest.Digest}}'
ARG NODE_IMAGE=node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

# ---- Stage 1: Install production dependencies ----
FROM ${NODE_IMAGE} AS deps
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
RUN npm ci --omit=dev --ignore-scripts \
  && apk add --no-cache python3 make g++ \
  && npm rebuild better-sqlite3

# ---- Stage 2: Backend Build ----
FROM ${NODE_IMAGE} AS backend-build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src/ src/
RUN npm ci && npm run build

# ---- Stage 3: Frontend Build (API only) ----
FROM ${NODE_IMAGE} AS frontend-build
WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ---- Stage 4: API Server (Express + SPA) ----
FROM ${NODE_IMAGE} AS api
WORKDIR /app

# Alpine v3.24's own package repo already carries the fix for 10 libssl3/
# libcrypto3 CVEs (incl. CVE-2026-14456, HIGH) that shipped baked into
# NODE_IMAGE's libssl3-3.5.7-r0. Require at least the patched release via a
# version floor (not an exact pin): exact pins rot when Alpine drops the old
# minor from the repo (3.5.8-r0 broke the build once 3.5.9-r0 landed) while a
# floor keeps the CVE guarantee and survives repo updates (ADR-0046) —
# drop this once a NODE_IMAGE digest bump picks up libssl3 >= 3.5.8-r0 baked in.
# zlib >= 1.3.2-r1 fixes CVE-2026-85091 (Trivy, medium) in the same way; drop it with the
# next NODE_IMAGE digest bump that ships it.
RUN apk add --no-cache --upgrade 'libssl3>=3.5.8-r0' 'libcrypto3>=3.5.8-r0' 'zlib>=1.3.2-r1'

# Runtime strip (ADR-0046): the base image bundles the npm CLI with its own
# dependency tree (/usr/local/lib/node_modules/npm). The runtime never
# invokes npm — entrypoint and healthchecks are plain `node` — so the
# bundled tree is pure attack surface. Removing it eliminates the entire
# class of bundled-npm CVEs (e.g. ip-address, brace-expansion) from the
# shipped image. Build stages keep npm: they run `npm ci`/`npm run build`.
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack

RUN addgroup -S dominus && adduser -S dominus -G dominus

COPY --from=deps --chown=dominus:dominus /app/node_modules node_modules/
COPY --from=backend-build --chown=dominus:dominus /app/dist dist/
COPY --from=frontend-build --chown=dominus:dominus /app/dist frontend/dist/
# CSS for the server-rendered public pages (/public/s/:slug, compare pages).
# The server serves ./public/static relative to the working directory.
COPY --chown=dominus:dominus public/ public/
COPY --chown=dominus:dominus package.json ./
COPY --chown=dominus:dominus LICENSE THIRD-PARTY-NOTICES.md /licenses/

# Database mount point owned by the runtime user, so a fresh bind/volume
# mount at /app/data is writable (docker run -v ./data:/app/data ...).
RUN mkdir -p /app/data && chown dominus:dominus /app/data

LABEL org.opencontainers.image.title="dominus-api" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/AlessioBrillo/dominus"

USER dominus

EXPOSE 3000

# Reachable from outside the container. Safe: the server refuses to start on
# 0.0.0.0 unless API authentication is configured (API_KEYS / AUTH_PROVIDER).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/dominus.db \
    FRONTEND_DIST_PATH=./frontend/dist \
    WORKER_ENABLED=false \
    SCHEDULER_ENABLED=false

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node dist/app/healthcheck-cli.js

ENTRYPOINT ["node"]
CMD ["dist/index.js"]

# ---- Stage 5: Job Worker (no HTTP listener) ----
FROM ${NODE_IMAGE} AS worker
WORKDIR /app

# Patched libssl3/libcrypto3 floor — see the comment in the api stage.
RUN apk add --no-cache --upgrade 'libssl3>=3.5.8-r0' 'libcrypto3>=3.5.8-r0' 'zlib>=1.3.2-r1'

# Runtime strip (ADR-0046): npm/corepack are unused at runtime — see the
# comment in the api stage. Removes the bundled-npm CVE surface class from
# the shipped image.
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack

RUN addgroup -S dominus && adduser -S dominus -G dominus

COPY --from=deps --chown=dominus:dominus /app/node_modules node_modules/
COPY --from=backend-build --chown=dominus:dominus /app/dist dist/
COPY --chown=dominus:dominus package.json ./
COPY --chown=dominus:dominus LICENSE THIRD-PARTY-NOTICES.md /licenses/

# Backup mount point: pre-created with the runtime user's ownership so a
# fresh named volume (`docker compose ... up -d`) inherits dominus:dominus
# on first mount and BACKUP_DIR stays writable for the non-root user.
RUN mkdir -p /backups /app/data && chown dominus:dominus /backups /app/data
VOLUME ["/backups"]

LABEL org.opencontainers.image.title="dominus-worker" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/AlessioBrillo/dominus"

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
FROM ${NODE_IMAGE} AS scheduler
WORKDIR /app

# Patched libssl3/libcrypto3 floor — see the comment in the api stage.
RUN apk add --no-cache --upgrade 'libssl3>=3.5.8-r0' 'libcrypto3>=3.5.8-r0' 'zlib>=1.3.2-r1'

# Runtime strip (ADR-0046): npm/corepack/npx are never used at runtime —
# see the comment in the api stage.
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack

RUN addgroup -S dominus && adduser -S dominus -G dominus

COPY --from=deps --chown=dominus:dominus /app/node_modules node_modules/
COPY --from=backend-build --chown=dominus:dominus /app/dist dist/
COPY --chown=dominus:dominus package.json ./
COPY --chown=dominus:dominus LICENSE THIRD-PARTY-NOTICES.md /licenses/

# Backup mount point: pre-created with the runtime user's ownership so a
# fresh named volume (`docker compose ... up -d`) inherits dominus:dominus
# on first mount and BACKUP_DIR stays writable for the non-root user.
RUN mkdir -p /backups /app/data && chown dominus:dominus /backups /app/data
VOLUME ["/backups"]

LABEL org.opencontainers.image.title="dominus-scheduler" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/AlessioBrillo/dominus"

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
