#!/usr/bin/env bash
# Prepare a fresh cloud session: Python deps + rmapi logged in from a secret.
set -e
pip install -q -r "$(dirname "$0")/requirements.txt" 2>&1 \
  | grep -v "running pip as the 'root'" || true

if ! command -v rmapi >/dev/null; then
  tmp=$(mktemp -d)
  curl -sSL -o "$tmp/rmapi.tgz" \
    https://github.com/ddvk/rmapi/releases/latest/download/rmapi-linux-amd64.tar.gz
  tar -xzf "$tmp/rmapi.tgz" -C "$tmp"
  install -m 755 "$(find "$tmp" -name rmapi -type f | head -1)" /usr/local/bin/rmapi
fi

# The device token is stored as the environment secret RMAPI_DEVICE_TOKEN
# (the "devicetoken:" value from ~/.rmapi on the Mac). Never commit it.
if [ -z "$RMAPI_DEVICE_TOKEN" ]; then
  echo "RMAPI_DEVICE_TOKEN is not set: add it to the environment's secrets." >&2
  exit 1
fi
mkdir -p ~/.config/rmapi
printf 'devicetoken: %s\nusertoken: ""\n' "$RMAPI_DEVICE_TOKEN" > ~/.config/rmapi/rmapi.conf
cp ~/.config/rmapi/rmapi.conf ~/.rmapi
chmod 600 ~/.config/rmapi/rmapi.conf ~/.rmapi
rmapi -ni ls / >/dev/null && echo "rmapi: logged in"
