#!/bin/sh
# Monetplane container entrypoint.
#
#   serve (default)  start the standalone Next.js server (server.js) bound to
#                    0.0.0.0:${PORT:-3000}
#   migrate          apply the drizzle journal to DATABASE_URL, then exit
#
# Migrations are NEVER applied implicitly on `serve`: money-system schema
# changes are a deliberate operator step (read back the applied history first
# — see docs/docker-deployment.md). docker-compose.yaml runs the one-shot
# `migrate` service before `app` via service_completed_successfully.
set -e

case "${1:-serve}" in
  serve)
    # Restore process-level fail-closed: standalone lazy-loads env checks
    # into route chunks, so validate before serving (see
    # scripts/preflight-env.mts).
    node --experimental-strip-types migrator/scripts/preflight-env.mts
    exec env HOSTNAME=0.0.0.0 PORT="${PORT:-3000}" node server.js
    ;;
  migrate)
    exec node --experimental-strip-types migrator/scripts/migrate.mts
    ;;
  *)
    exec "$@"
    ;;
esac
