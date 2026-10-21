#!/usr/bin/env bash
# Mirrors apps/storefront into a throwaway directory OUTSIDE the repo so a second `next dev` can run with its own `.next-dev`
# (apps/storefront/next.config.ts hard-codes distDir, so the running :3000 dev server's artifacts are never touched).
# node_modules is symlinked to the real one (no install). Usage: tests/coa-ui/sync-storefront-copy.sh [dest]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${1:-/var/folders/v9/840n4c810px9_kxb2ntl2xt00000gn/T/opencode/coa-ui-storefront}"
mkdir -p "$DEST"
rsync -a --delete --exclude node_modules --exclude '.next*' --exclude tsconfig.tsbuildinfo --exclude next-env.d.ts "$ROOT/apps/storefront/" "$DEST/"
[ -e "$DEST/node_modules" ] || ln -s "$ROOT/apps/storefront/node_modules" "$DEST/node_modules"
echo "$DEST"
