# syntax=docker/dockerfile:1

# MonetPlane runtime image. Two deployment modes share this image:
#   1. external PostgreSQL  — run with DATABASE_URL pointing at your DB,
#      apply migrations explicitly:  docker run --rm <image> migrate
#   2. docker-compose.yaml  — bundled PostgreSQL 17 + one-shot migrate service
# Secrets are injected at runtime only (the app reads them fail-closed in
# src/config/env.ts: a missing AUTH_SECRET/DATABASE_URL crashes the process).

# ---- deps: locked full install (dev + prod) for the build ----
FROM node:22-alpine AS deps
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="/pnpm:$PATH"
RUN corepack enable
# Canonical registry by default; pass
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
# on networks where registry.npmjs.org is unreliable. Lockfile sha512
# integrity hashes are verified regardless of registry used.
ARG NPM_REGISTRY=https://registry.npmjs.org
# Workspace manifests are required for install: pnpm-workspace.yaml carries
# the settings home (onlyBuiltDependencies) and the member manifests satisfy
# frozen-lockfile workspace resolution.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json ./packages/sdk/
COPY examples/basic-server/package.json ./examples/basic-server/
COPY examples/credits-usage-demo/package.json ./examples/credits-usage-demo/
# Shared store cache (id=pnpm-store) — resilient to registry hiccups on retry
# and reused by the prune step below.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir /pnpm/store --registry="$NPM_REGISTRY"

# ---- build ----
FROM node:22-alpine AS builder
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="/pnpm:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
# Reuse the deps stage's corepack cache: pnpm itself must not be re-downloaded
# here (registry flakiness must not be able to fail the build step).
COPY --from=deps /root/.cache/node/corepack /root/.cache/node/corepack
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time-only placeholder (AUTH_SECRET is module-evaluated in
# src/auth.config.ts during `next build`); the real secret is injected at
# runtime and never baked into any image layer.
ARG PLACEHOLDER_AUTH=build-only-value-never-used-at-runtime
RUN AUTH_SECRET="${PLACEHOLDER_AUTH}" pnpm build
# Runtime migrator deps: standalone bundles drizzle-orm/postgres into server
# chunks, so they are absent from the traced node_modules. Both packages are
# transitive-dependency-free — dereferenced copies (cp -rL resolves the pnpm
# symlinks) are sufficient for scripts/migrate.mts.
RUN mkdir /migrator-deps \
  && cp -rL node_modules/drizzle-orm /migrator-deps/drizzle-orm \
  && cp -rL node_modules/postgres /migrator-deps/postgres

# ---- runner: standalone server bundle (Next runtime-file tracing) ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S nextjs && adduser -S nextjs -G nextjs
# Standalone layout: server.js + traced node_modules; static assets copied
# next to it per Next's standalone contract (this app has no public/ dir).
COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
COPY --chown=nextjs:nextjs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
# Migrator tree: deps + script + shared fail-closed env validation. Bare
# imports in migrate.mts resolve against migrator/node_modules.
COPY --from=builder --chown=nextjs:nextjs /migrator-deps ./migrator/node_modules
COPY --chown=nextjs:nextjs scripts/migrate.mts scripts/preflight-env.mts ./migrator/scripts/
COPY --chown=nextjs:nextjs src/config/env.ts ./migrator/src/config/env.ts
COPY --chown=nextjs:nextjs drizzle ./drizzle
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" >/dev/null || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["serve"]
