#!/usr/bin/env bash
# Local demo of the portal: a throwaway PostgreSQL (deleted when you stop this
# script), migrations, the built web app and the API on http://127.0.0.1:3000.
# Development only — emails (verification, invitations) are printed to this
# terminal instead of being sent. Never use with real customer data.
#
# Requirements: Node >= 22.22, pnpm 10, PostgreSQL 16+ server binaries
# (initdb/pg_ctl; set PG_BINDIR if they are not found automatically).
#
# Usage:   scripts/dev-local.sh          then open http://127.0.0.1:3000
# Stop:    Ctrl+C
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm -F @lbgos/web build >/dev/null
SESSION_SECRET=${SESSION_SECRET:-$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))")}
export SESSION_SECRET

scripts/with-throwaway-pg.sh bash -c '
  set -euo pipefail
  node packages/db/src/migrate-cli.ts >/dev/null
  cat <<INFO

  Portal: http://127.0.0.1:3000   (use exactly this address; the CSRF check compares origins)

  1. Sign up in the browser. The verification link is printed below as "[dev email]".
  2. To review applications you need a platform admin. After signing up, run in
     another terminal (replace the email):

       psql -h $PGHOST -p $PGPORT -U postgres -c "insert into lbg.platform_admins (user_id) select id from lbg.users where email = '"'"'you@example.com'"'"'"

     then sign out and in again; you will be asked to set up two-step verification.

INFO
  # Real OCR when Tesseract is installed (sudo apt install tesseract-ocr), else the test adapter.
  if command -v tesseract >/dev/null; then export OCR_ENGINE=tesseract; else echo "  (OCR: test adapter only — install tesseract-ocr for real photos)"; fi
  PUBLIC_BASE_URL=http://127.0.0.1:3000 HOST=127.0.0.1 PORT=3000 LOG_LEVEL=warn node apps/api/src/server.ts
'
