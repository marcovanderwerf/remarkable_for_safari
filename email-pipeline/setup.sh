#!/usr/bin/env bash
# Install what send.py needs in a fresh cloud session.
set -e
pip install -q weasyprint trafilatura beautifulsoup4 markdown requests 2>&1 | grep -v "running pip as the 'root'" || true
