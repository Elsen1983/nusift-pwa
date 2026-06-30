#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_common.sh"
cd "$REPO_ROOT"
log "Discovery starting"
npm run job:discover -- --limit 20 >> "${LOG_DIR}/discover-pending.log" 2>&1
log "Discovery finished"