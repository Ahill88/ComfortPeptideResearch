# syntax=docker/dockerfile:1.7
# Helix & Field storefront (Next.js 15) - pnpm monorepo, multi-stage.
# Build from the REPO ROOT:  docker build -f apps/storefront/Dockerfile --build-arg NEXT_PUBLIC_API_URL=... -t helix-storefront .
#
# NOT VERIFIED BY A REAL `docker build` (no Docker in the authoring environment). See infrastructure/docker/README.md.
#
# Why `next start` and not `output: 'standalone'`: next.config.ts sets outputFileTracingRoot to the app directory, and the
# generated .next/standalone/node_modules/* symlinks into ../../../node_modules/.pnpm (inspected locally: they dangle
# for a pnpm workspace). Until outputFileTracingRoot points at the repo root, the standalone folder is not runnable.

ARG NODE_VERSION=22
ARG PNPM_VERSION=12.14.0

FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/storefront/package.json apps/storefront/package.json
# --ignore-scripts: no storefront dependency needs a build script, and it keeps the ROOT `postinstall`
# (`prisma generate` for the API) from running in an image that deliberately does not contain the API.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm/store --filter "@helix-field/storefront..."

FROM deps AS build
# NEXT_PUBLIC_* values are inlined into the browser bundle at BUILD time. This is a public URL, not a secret.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001/v1
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
COPY apps/storefront apps/storefront
RUN pnpm --filter "@helix-field/storefront..." build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app/apps/storefront
# Same relative layout as the build stage so pnpm's relative node_modules symlinks keep resolving.
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/apps/storefront/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/storefront/.next ./.next
COPY --from=build --chown=node:node /app/apps/storefront/public ./public
COPY --from=build --chown=node:node /app/apps/storefront/package.json /app/apps/storefront/next.config.ts ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "require('http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/',timeout:4000},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"]
CMD ["sh", "-c", "exec node node_modules/next/dist/bin/next start -p \"${PORT}\" -H \"${HOSTNAME}\""]
