#!/usr/bin/env bash
set -euo pipefail
DUMP_FILE="${1:?Usage: restore.sh <dump-file> <expected-sha256>}"
EXPECTED_SHA256="${2:?A trusted backup SHA-256 is required}"
node "$(dirname "$0")/database-recovery.mjs" restore "$DUMP_FILE" "$EXPECTED_SHA256"
