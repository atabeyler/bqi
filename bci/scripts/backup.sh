#!/usr/bin/env bash
set -euo pipefail
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
node "$(dirname "$0")/database-recovery.mjs" backup "$OUT_DIR/bci-backup-$(date -u +%Y%m%dT%H%M%SZ).dump"
