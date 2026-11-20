#!/usr/bin/env bash
# Prints the CHANGELOG.md section for one version, e.g. scripts/release-notes.sh 4.0.0
set -euo pipefail
cd "$(dirname "$0")/.."
awk -v v="$1" '
  /^## / { if (found) exit; if (index($0, "## " v) == 1) { found = 1; next } }
  found { print }
' CHANGELOG.md
