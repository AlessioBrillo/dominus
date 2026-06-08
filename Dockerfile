# DOMINUS — Multi-stage production build
# Requires Docker BuildKit (default since Docker 23.0).
#
# Build:    docker build -t dominus .
# Run:      docker run -d -p 3000:3000 -v ./data:/app/data dominus

# ---- Stage 1: Install dependencies ----
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production --ignore-scripts

# ---- Stage 2: Build ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY src/ src/
RUN npm ci && npm run build

# ---- Stage 3: Production ----
FROM node:20-alpine AS production
WORKDIR /app

RUN addgroup -S dominus && adduser -S dominus -G dominus

COPY --from=deps --chown=dominus:dominus /app/node_modules node_modules/
COPY --from=build --chown=dominus:dominus /app/dist dist/
COPY --chown=dominus:dominus package.json tsconfig.json ./

USER dominus

EXPOSE 3000

ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/dominus.db

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node dist/app/healthcheck.js

ENTRYPOINT ["node"]
CMD ["dist/index.js"]
