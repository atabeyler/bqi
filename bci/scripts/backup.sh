#!/usr/bin/env bash
# Backs up the BCI database to a timestamped, compressed pg_dump custom-
# format archive. Requires BCI_DATABASE_URL (same var the API itself
# reads) and the postgresql-client tools (pg_dump) on PATH.
set -euo pipefail

if [ -z "${BCI_DATABASE_URL:-}" ]; then
  echo "BCI_DATABASE_URL is not set" >&2
  exit 1
fi

OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/bci-backup-$(date -u +%Y%m%dT%H%M%SZ).dump"

pg_dump --format=custom --compress=9 --dbname="$BCI_DATABASE_URL" --file="$OUT_FILE"
echo "Backup written to $OUT_FILE"
