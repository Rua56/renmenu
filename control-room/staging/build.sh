#!/bin/sh
# Assemble a separate Wrangler Direct Upload workspace. This script NEVER deploys.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
CR="$ROOT/control-room"
TARGET="$CR/.staging"
case "$TARGET" in "$ROOT/control-room/.staging") ;; *) echo 'Invalid staging target' >&2; exit 1 ;; esac
rm -rf "$TARGET"
mkdir -p "$TARGET/dist/control-room" "$TARGET/functions"
cp -R "$CR/site/." "$TARGET/dist/control-room/"
cp -R "$CR/cloudflare/functions/." "$TARGET/functions/"
cp "$CR/cloudflare/_routes.json.example" "$TARGET/dist/_routes.json"
test -f "$TARGET/dist/control-room/index.html"
test -f "$TARGET/dist/control-room/preview/index.html"
test -f "$TARGET/functions/control-room/api/[[route]].js"
test -f "$TARGET/functions/_middleware.js"
test ! -f "$TARGET/dist/index.html"
printf 'Staging bundle assembled at %s (no deployment performed).\n' "$TARGET"
