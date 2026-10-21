# syntax=docker/dockerfile:1.7
# Helix & Field API (NestJS + Prisma) - pnpm monorepo, multi-stage.
# Build from the REPO ROOT:  docker build -f apps/api/Dockerfile -t helix-api .
#
# NOT VERIFIED BY A REAL `docker build` (no Docker in the authoring environment). See infrastructure/docker/README.md.

ARG NODE_VERSION=22
ARG PNPM_VERSION=12.14.0

# ---- base: node + pinned pnpm via corepack (version must match root package.json "packageManager") -----------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# ---- deps: install workspace deps for the API only (cached until manifests/lockfile change) ----------------------
FROM base AS deps
# openssl: Prisma's query/schema engines link against libssl at install-time generate.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
# The root "postinstall" runs `prisma generate`, so the schema must exist before install.
COPY apps/api/prisma apps/api/prisma
# Build scripts (prisma, @prisma/client, @nestjs/core, msgpackr-extract) are allowed by pnpm.allowBuilds in
# pnpm-workspace.yaml; everything else (bufferutil, utf-8-validate, bigint-buffer) is explicitly denied there.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store --filter "@helix-field/api..."

# ---- build: generate Prisma client and compile TypeScript -------------------------------------------------------
FROM deps AS build
COPY apps/api apps/api
RUN pnpm --filter @helix-field/api exec prisma generate --schema prisma/schema.prisma \
    && pnpm --filter "@helix-field/api..." build

# ---- runtime ---------------------------------------------------------------------------------------------------
# Deliberately NOT based on `base`: no corepack/pnpm, no apt cache, no sources or tests.
# Trade-off (documented): node_modules is copied whole from the build stage (including dev dependencies) because the
# generated Prisma client lives inside it and `prisma` (a devDependency) is needed for `migrate deploy`. Slimming this
# further (move `prisma` to dependencies, then `pnpm deploy --prod`) needs a real build to verify.
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app/apps/api
# Same relative layout as the build stage so pnpm's relative node_modules symlinks keep resolving.
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/apps/api/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./dist
COPY --from=build --chown=node:node /app/apps/api/prisma ./prisma
COPY --from=build --chown=node:node /app/apps/api/package.json ./package.json
COPY --chown=node:node apps/api/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod 0755 docker-entrypoint.sh
USER node
EXPOSE 3001
# Liveness probe: GET /health (always 200 while the process serves HTTP; it does not touch Postgres/Redis so a database
# blip never restarts the container). Use GET /health/ready (Postgres SELECT 1, 503 on failure) for orchestrator readiness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "require('http').get({host:'127.0.0.1',port:process.env.PORT||3001,path:'/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
