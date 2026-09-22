#!/usr/bin/env bash
# Runs the MkDocs Material docs site locally (docs.spiralclass.com's source).
# Creates a local venv on first run, keeps deps in sync with requirements.txt,
# then starts the hot-reloading dev server. See docs/deployment/DOCS_SITE.md.
set -euo pipefail
cd "$(dirname "$0")/.."

VENV_DIR=".venv-docs"

if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
fi

"$VENV_DIR/bin/pip" install -q -r requirements.txt
exec "$VENV_DIR/bin/mkdocs" serve
