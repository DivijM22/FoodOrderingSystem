#!/bin/sh
# Writes the runtime configuration read by index.html (/config.js) from the API_URL environment variable.
# API_URL is the API gateway URL *as the browser reaches it*: an absolute URL (http://localhost:8080 locally) or a
# same-origin path served by this container's /api/ proxy (/api, used in the cloud). Nothing secret goes here.
set -eu
case "$API_URL" in
  http://*|https://*) ;;
  //*) echo "API_URL must not be protocol-relative (got '$API_URL')" >&2; exit 1 ;;
  /*) ;;
  *) echo "API_URL must start with http://, https:// or / (got '$API_URL')" >&2; exit 1 ;;
esac
if printf '%s' "$API_URL" | grep -q "[\"'\\\\<> ]"; then
  echo "API_URL contains characters that are not allowed" >&2
  exit 1
fi
printf "window.__APP_CONFIG__ = { apiUrl: '%s' };\n" "$API_URL" > /usr/share/nginx/html/config.js
echo "frontend: API gateway URL set to $API_URL"
