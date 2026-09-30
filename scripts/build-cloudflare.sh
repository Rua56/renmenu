#!/bin/sh
# Build the public RenMenu site for Cloudflare Pages. Run from any directory.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
rm -rf dist
mkdir -p dist/blanch/assets dist/blanch/data dist/blanch/qr
# Keep all public pages and demos reachable at the same path relative to site root.
cp index.html 404.html manifest.webmanifest dist/
cp -R assets anteprima crea demo menu menus paga casi-studio dist/
cp blanch/index.html dist/blanch/index.html
cp blanch/assets/* dist/blanch/assets/
cp blanch/data/menu.json dist/blanch/data/menu.json
cp blanch/qr/trattoria-blanch-qr.png blanch/qr/trattoria-blanch-qr.svg dist/blanch/qr/

# The existing GitHub Pages 404 links use /renmenu/ because it is a project site.
# On Cloudflare Pages the same content is hosted from /; change only the build copy.
sed -i 's#="/renmenu/#="/#g' dist/404.html

# Revalidate mutable menu data and HTML so updates appear without a new QR.
cat > dist/_headers <<'EOF'
/*.html
  Cache-Control: public, max-age=0, must-revalidate
/menus/*.json
  Cache-Control: public, max-age=0, must-revalidate
/blanch/data/menu.json
  Cache-Control: public, max-age=0, must-revalidate
EOF

# Search Console: only marketing pages with substantial HTML are submitted.
# Keep transactional pages, embedded demos and customer menus out of the sitemap.
cat > dist/robots.txt <<'EOF'
User-agent: *
Allow: /
Sitemap: https://renmenu.pages.dev/sitemap.xml
EOF

cat > dist/sitemap.xml <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://renmenu.pages.dev/</loc></url>
  <url><loc>https://renmenu.pages.dev/anteprima/</loc></url>
  <url><loc>https://renmenu.pages.dev/casi-studio/trattoria-blanch/</loc></url>
</urlset>
EOF

[ -s dist/index.html ]
[ -s dist/blanch/data/menu.json ]
[ -s dist/sitemap.xml ]
printf 'Built Cloudflare Pages output: %s files\n' "$(find dist -type f | wc -l | tr -d ' ')"
