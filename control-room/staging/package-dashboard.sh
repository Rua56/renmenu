#!/bin/sh
# Prepare a Cloudflare Pages dashboard Direct Upload zip with compiled Functions.
# The output contains only the private Control Room. This script never deploys.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
STAGE="$ROOT/control-room/.staging"
ZIP=${1:-/tmp/renmenu-jarvis-stage-upload.zip}
case "$ZIP" in /*.zip) ;; *) echo 'Provide an absolute .zip path outside the repository.' >&2; exit 1 ;; esac
case "$ZIP" in "$ROOT"/*) echo 'Do not store deployment archives in the repository.' >&2; exit 1 ;; esac
sh "$ROOT/control-room/staging/build.sh"
(cd "$STAGE" && wrangler pages functions build --outdir .wrangler/functions-check --compatibility-date 2026-10-01)
test -s "$STAGE/.wrangler/functions-check/index.js"
cp "$STAGE/.wrangler/functions-check/index.js" "$STAGE/dist/_worker.js"
test -s "$STAGE/dist/_routes.json"
test -s "$STAGE/dist/control-room/index.html"
test ! -e "$STAGE/dist/index.html"
test ! -e "$STAGE/dist/functions"
if find "$STAGE/dist" -name '.env*' -o -name '*.pem' -o -name '*.key' | grep -q .; then
  echo 'Secrets or key-like files detected in bundle; aborting.' >&2
  exit 1
fi
rm -f "$ZIP"
(cd "$STAGE/dist" && zip -q -r "$ZIP" .)
unzip -l "$ZIP" | grep -q '_worker.js'
unzip -l "$ZIP" | grep -q '_routes.json'
unzip -l "$ZIP" | grep -q 'control-room/index.html'
printf 'Private staging upload archive ready: %s (%s bytes); no deployment performed.\n' "$ZIP" "$(stat -c %s "$ZIP")"
