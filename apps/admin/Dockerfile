# syntax=docker/dockerfile:1.7
# Helix & Field admin console (Next.js 15) - pnpm monorepo, multi-stage.
# Build from the REPO ROOT:  docker build -f apps/admin/Dockerfile -t helix-admin .
#
# NOT VERIFIED BY A REAL `docker build` (no Docker in the authoring environment). See infrastructure/docker/README.md.
#
# The admin app does not set `output: 'standalone'`, so the runtime image runs `next start` against the built .next.
# Runtime configuration (server-side only, never baked into the image): API_URL (e.g. http://api:3001/v1) and
# ADMIN_API_TOKEN (wallet reporting only). Sign-in uses the API's admin auth; the session cookie is Secure in production,
# so serve the admin over HTTPS (a reverse proxy is fine). There is no development-session bypass any more.

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
COPY apps/admin/package.json apps/admin/package.json
# --ignore-scripts: no admin dependency needs a build script, and it keeps the ROOT `postinstall`
# (`prisma generate` for the API) from running in an image that deliberately does not contain the API.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --store-dir /pnpm/store --filter "@helix-field/admin..."

FROM deps AS build
COPY apps/admin apps/admin
RUN pnpm --filter "@helix-field/admin..." build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3002 \
    HOSTNAME=0.0.0.0
WORKDIR /app/apps/admin
# Same relative layout as the build stage so pnpm's relative node_modules symlinks keep resolving.
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/apps/admin/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/admin/.next ./.next
COPY --from=build --chown=node:node /app/apps/admin/package.json /app/apps/admin/next.config.ts ./
USER node
EXPOSE 3002
# Any status below 500 counts as alive: `/` may redirect unauthenticated visitors to /sign-in.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "require('http').get({host:'127.0.0.1',port:process.env.PORT||3002,path:'/',timeout:4000},r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"]
CMD ["sh", "-c", "exec node node_modules/next/dist/bin/next start -p \"${PORT}\" -H \"${HOSTNAME}\""]
