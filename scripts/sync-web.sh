#!/bin/sh
# Copy the built frontend into the Python package so the server ships without node.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
src="$here/web/dist"
dst="$here/src/misaka_web/static"
if [ ! -f "$src/index.html" ]; then
  echo "No build at $src; run: cd web && pnpm install && pnpm exec vite build" >&2
  exit 1
fi
# The service worker must know the hashed asset names before it installs.
if [ -f "$src/sw.js" ]; then
  if command -v node >/dev/null 2>&1; then
    node "$here/web/scripts/stamp-sw.mjs" "$src" || { echo "sync-web: stamping sw.js failed" >&2; exit 1; }
  else
    echo "sync-web: node not found; dist/sw.js is unstamped (offline shell will be incomplete)" >&2
  fi
fi

rm -rf "$dst"
mkdir -p "$dst"
cp -R "$src"/. "$dst"/
echo "Synced $(find "$dst" -type f | wc -l) files into $dst"