#!/usr/bin/env bash
# Restores a BCI database backup produced by backup.sh. Restores into
# BCI_DATABASE_URL, which must point at an EMPTY database (pg_restore
# --clean drops existing objects first, but only ones this dump itself
# created -- run this against a fresh database, not a live one, unless you
# mean to overwrite it).
set -euo pipefail

if [ -z "${BCI_DATABASE_URL:-}" ]; then
  echo "BCI_DATABASE_URL is not set" >&2
  exit 1
fi

DUMP_FILE="${1:?Usage: restore.sh <dump-file>}"

pg_restore --clean --if-exists --no-owner --dbname="$BCI_DATABASE_URL" "$DUMP_FILE"
echo "Restored from $DUMP_FILE"
