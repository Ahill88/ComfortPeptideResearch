# Docker

Images and the local stack for Helix & Field. Everything here is for local development and CI-style checks.
**Nothing is deployed anywhere** and none of it is a production hardening claim.

## Status: not build-verified

The authoring environment had no `docker` binary, so **no image has been built and `docker compose` has never been run**
against these files. What *was* checked offline: YAML parses, every `COPY` source path exists, `docker-entrypoint.sh`
passes `sh -n` and behaves as documented when run directly, and `next start` + the health probe work against an
existing local storefront build. A first real `docker compose build` may still surface problems (see "Known risks").

## Layout

| File | Purpose |
| --- | --- |
| `apps/api/Dockerfile` | NestJS API. Stages: `base` (corepack + pnpm@12.14.0) -> `deps` -> `build` -> `runtime`. |
| `apps/storefront/Dockerfile` | Next.js storefront on port 3000. `NEXT_PUBLIC_API_URL` build arg. |
| `apps/admin/Dockerfile` | Next.js admin console on port 3002. |
| `apps/api/docker-entrypoint.sh` | Optional, explicit `prisma migrate deploy`, then `exec`s the API. |
| `docker-compose.yml` | postgres 16, redis 7, api, storefront, admin, plus a `test`-profile Postgres. |
| `.dockerignore` | Keeps `node_modules`, build output, `.git` and every `.env*` except `.env.example` out of the context. |

All builds use the repository root as context: `docker build -f apps/api/Dockerfile .`

## Common design

- pnpm comes from `corepack enable && corepack prepare pnpm@${PNPM_VERSION}`; `PNPM_VERSION` defaults to `12.14.0`
  and must stay equal to the root `package.json` `packageManager`.
- `pnpm install --frozen-lockfile --filter "<pkg>..."` installs only that app's dependency closure, after copying just
  manifests + lockfile + `pnpm-workspace.yaml` (so the layer is cached until dependencies change).
- `pnpm.allowBuilds` in `pnpm-workspace.yaml` is honoured for the API (prisma, @prisma/client, @nestjs/core,
  msgpackr-extract may run scripts; bufferutil, utf-8-validate, bigint-buffer are denied). The Next.js images install
  with `--ignore-scripts` so the root `postinstall` (`prisma generate`) does not run in images without the API.
- Base image is `node:22-bookworm-slim` (glibc + OpenSSL for Prisma engines; the old `alpine` images are gone).
- Runtime stages run as the unprivileged `node` user, and have a `HEALTHCHECK` (a Node one-liner; no curl installed).
- No secrets in any image or in compose. `NEXT_PUBLIC_API_URL` is the only build arg and is a public URL.

## Running locally

```sh
cp .env.example .env                       # .env is git-ignored; edit values locally
docker compose up --build                  # postgres, redis, api, storefront, admin
docker compose run --rm api migrate        # apply migrations (explicit; never implicit)
```

Published ports are bound to `127.0.0.1`: storefront 3000, api 3001, admin 3002, postgres 5432, redis 6379.

### Migrations

Migrations are never run implicitly. Two explicit ways:

1. One-off: `docker compose run --rm api migrate` (entrypoint runs `prisma migrate deploy` and exits).
2. On start: set `RUN_MIGRATIONS=true` (default `false`). Intended for single-instance local use only. For anything with
   more than one replica, run the one-off command once per release instead.

`prisma migrate deploy` only applies committed migrations; it never creates migrations or resets data.

### Integration-test database

```sh
docker compose --profile test up -d postgres-test        # host port 54329, db helix_field_test, no volume
export TEST_DATABASE_URL="postgresql://helix:helix@127.0.0.1:54329/helix_field_test?schema=public"
DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter @helix-field/api exec prisma migrate deploy
node tests/run-all.mjs integration
docker compose --profile test down
```

(Use your own `POSTGRES_USER`/`POSTGRES_PASSWORD` from `.env` in the URL.) The wallet e2e suite TRUNCATES tables and
refuses any database that is not on `localhost`/`127.0.0.1` with `helix` or `test` in its name.

## Known risks / things to check on first real build

1. **API refuses `NODE_ENV=production` by design** (`AUTH_BACKEND` gate, plus env validation requiring a treasury key,
   `WALLET_CHAIN_MODE=devnet`, etc.). The image sets `NODE_ENV=production`, so a bare `docker run` of the API exits at
   startup. Compose overrides it to `development` (`API_NODE_ENV`). That is intentional fail-closed behaviour, not a bug.
2. **Storefront uses `next start`, not `output: 'standalone'`.** `next.config.ts` sets `outputFileTracingRoot` to the app
   directory, and the generated `.next/standalone/node_modules` symlinks dangle in this pnpm workspace (checked on the
   existing build). `next start` prints a warning about `standalone` but serves correctly (verified locally). If the
   config owner changes `outputFileTracingRoot` to the repo root, the runtime stage can switch to
   `node apps/storefront/server.js` and drop most of `node_modules`.
3. **API runtime image is not minimal.** `node_modules` is copied whole from the build stage (including dev
   dependencies) because the generated Prisma client lives inside it and `prisma` is a devDependency needed for
   `migrate deploy`. To slim it: move `prisma` to `dependencies`, then try `pnpm deploy --prod`, and verify with a build.
4. **corepack + pnpm 12.14.0**: relies on the Node 22 image shipping corepack and corepack being able to fetch this
   pnpm version. Unverified.
5. **API health check is liveness only** (`GET /health`, 200). `GET /health/ready` (Postgres `SELECT 1`, 503 on failure) is available for readiness; Redis is not checked. Both are unprefixed (no `/v1`).
6. Filtered `pnpm install --frozen-lockfile --filter "...<pkg>..."` and the BuildKit cache mount were not exercised.
