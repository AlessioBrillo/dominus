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
RUN npm ci --only=production --ignore-scripts

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
