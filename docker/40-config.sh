#!/bin/sh
# Generates assets/config.json from $API_URL at container start.
# If API_URL is empty, the default baked in at build time is kept.
set -eu

CONFIG=/usr/share/nginx/html/assets/config.json

if [ -n "${API_URL:-}" ]; then
  case "$API_URL" in
    http://*|https://*) ;;
    *) echo "40-config.sh: API_URL must start with http:// or https://" >&2; exit 1 ;;
  esac
  # Reject characters that could break out of the JSON string
  case "$API_URL" in
    *\"*|*\\*) echo "40-config.sh: API_URL contains invalid characters" >&2; exit 1 ;;
  esac
  printf '{\n  "apiUrl": "%s"\n}\n' "$API_URL" > "$CONFIG"
  echo "40-config.sh: apiUrl set to $API_URL"
fi
