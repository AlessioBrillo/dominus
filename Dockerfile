# DOMINUS — Multi-stage production build
# Requires Docker BuildKit (default since Docker 23.0).
#
# Build:    docker build --build-arg NODE_VERSION=22 -t dominus .
# Run:      docker run -d -p 3000:3000 -v ./data:/app/data dominus

ARG NODE_VERSION=20

# ---- Stage 1: Install dependencies ----
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

# ---- Stage 3: Frontend Build ----
FROM node:${NODE_VERSION}-alpine AS frontend-build
WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ---- Stage 4: Production ----
FROM node:${NODE_VERSION}-alpine AS production
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
    FRONTEND_DIST_PATH=./frontend/dist

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node dist/app/healthcheck-cli.js

ENTRYPOINT ["node"]
CMD ["dist/index.js"]
