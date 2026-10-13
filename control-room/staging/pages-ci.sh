#!/bin/sh
# Build di Cloudflare Pages (Git) per lo staging di Jarvis `renmenu-jarvis-stage`.
# Impostazioni del progetto Pages: directory radice `control-room/cloudflare` (lì c'è `functions/`,
# che Pages compila da solo), comando `sh ../staging/pages-ci.sh`, output `pages-dist`.
# Copia solo la Control Room e le regole di routing: niente sito pubblico, niente segreti.
set -eu
CF=$(CDPATH= cd -- "$(dirname -- "$0")/../cloudflare" && pwd)
OUT="$CF/pages-dist"
case "$OUT" in */control-room/cloudflare/pages-dist) ;; *) echo 'Output non valido' >&2; exit 1 ;; esac
rm -rf "$OUT"
mkdir -p "$OUT/control-room"
cp -R "$CF/../site/." "$OUT/control-room/"
cp "$CF/_routes.json.example" "$OUT/_routes.json"
test -f "$OUT/control-room/index.html"
test -f "$OUT/control-room/preview/index.html"
test -f "$CF/functions/control-room/api/[[route]].js"
test -f "$CF/functions/jarvis-hook/[[route]].js"
test ! -f "$OUT/index.html"
printf 'Pacchetto Pages dello staging pronto in %s\n' "$OUT"
