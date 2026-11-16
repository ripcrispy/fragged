#!/usr/bin/env bash
# Started by Playwright (playwright.config.ts): reset an isolated database, seed it, serve on :3200.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/node/bin:$PATH"
[ -f .env ] && set -a && . ./.env && set +a
export NODE_ENV=development DATA_DIR=data/e2e PGLITE_DIR=data/e2e/pglite PORT=3200 APP_URL=http://localhost:3200 AUTH_DEV_PROVIDER=1 LOG_LEVEL=warn
if [ -n "${TEST_DATABASE_URL:-}" ]; then
  export DATABASE_URL="$(node -e 'const u=new URL(process.env.TEST_DATABASE_URL);u.pathname="/fragged_e2e";console.log(u.toString())')"
else
  unset DATABASE_URL
fi
node --import tsx scripts/e2e-reset.ts
node --import tsx scripts/seed.ts
node --import tsx scripts/demo-lan.ts
node scripts/build.mjs --client >/dev/null
exec node --import tsx src/server.ts
