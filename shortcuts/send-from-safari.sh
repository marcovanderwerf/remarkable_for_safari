#!/usr/bin/env bash
# Called by the "Send to reMarkable" Shortcut on the Mac.
#
# Reads the page Safari has open as JSON {"url": ..., "html": ...} on stdin,
# renders it with email-pipeline/send.py (same PDF as the email pipeline) and
# uploads it to /Articles with rmapi.
#
# Usage: send-from-safari.sh [folder]      (default folder: /Articles)
# Env:   RM_PYTHON     Python that has send.py's dependencies (default: python3)
#        RM_NO_UPLOAD  set to 1 to render only (for testing)
set -euo pipefail

# Shortcuts runs scripts with a minimal PATH; add the usual install locations
# of python3 and rmapi (Homebrew, go install).
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/go/bin:$HOME/.local/bin:$PATH"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PY="${RM_PYTHON:-python3}"
FOLDER="${1:-/Articles}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/page.json"

if [ ! -s "$tmp/page.json" ]; then
  echo "No page received from Safari." >&2
  exit 1
fi

extra=()
if [ "${RM_NO_UPLOAD:-}" = "1" ]; then
  extra+=(--no-upload --out "$HOME/Desktop/reMarkable-test.pdf")
fi

"$PY" "$REPO/email-pipeline/send.py" --page-json "$tmp/page.json" --folder "$FOLDER" ${extra[@]+"${extra[@]}"} 2>&1
