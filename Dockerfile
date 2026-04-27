# ---- Stage 1: Build frontend ----
FROM oven/bun:1 AS builder
WORKDIR /build

# Install all dependencies (layer cache: lockfile changes rarely)
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/docs/package.json apps/docs/
RUN bun install --frozen-lockfile

# Build web app
COPY apps/web/ apps/web/
RUN cd apps/web && bun run build

# ---- Stage 2: Production ----
FROM oven/bun:1-alpine
WORKDIR /app

# Production-only dependencies (web deps not needed — frontend is pre-built)
COPY package.json ./
COPY apps/server/package.json apps/server/
RUN bun install --production && rm -rf /root/.bun/install/cache /tmp/*

# Server source + migrations
COPY apps/server/src/ apps/server/src/
COPY apps/server/drizzle/ apps/server/drizzle/

# Built frontend from builder stage
COPY --from=builder /build/apps/web/dist/ apps/web/dist/

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["bun", "run", "apps/server/src/index.ts"]
