#!/bin/sh
# Helix & Field API container entrypoint.
#
# Database migrations are NEVER implicit. They only run when you ask for them:
#   * one-off:      docker compose run --rm api migrate          (applies `prisma migrate deploy`, then exits)
#   * on start-up:  RUN_MIGRATIONS=true                           (applies migrations, then starts the API)
# With neither, the container only starts the API and never touches the schema.
#
# `prisma migrate deploy` applies committed migrations only. It never creates migrations, never resets the
# database and never prompts. Run it from exactly ONE place per release (a release task or the one-off
# command above), not from every replica; use RUN_MIGRATIONS=true only for single-instance/local setups.
set -eu

cd "$(dirname "$0")"

run_migrations() {
  if [ ! -x node_modules/.bin/prisma ]; then
    echo "docker-entrypoint: prisma CLI not found in this image; cannot run migrations." >&2
    exit 1
  fi
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "docker-entrypoint: DATABASE_URL is not set; refusing to run migrations." >&2
    exit 1
  fi
  echo "docker-entrypoint: running prisma migrate deploy"
  node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
}

if [ "${1:-}" = "migrate" ]; then
  run_migrations
  exit 0
fi

if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  run_migrations
fi

exec "$@"
