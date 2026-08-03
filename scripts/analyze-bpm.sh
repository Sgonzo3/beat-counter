#!/usr/bin/env bash
set -euo pipefail
export PATH="${HOME}/.local/bin:${HOME}/.deno/bin:${PATH:-}"
exec python3 "$(dirname "$0")/../python/analyze_bpm.py" "$@"
