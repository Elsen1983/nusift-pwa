#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_common.sh"
cd "$REPO_ROOT"
log "RSS ingest starting"
npm run job:ingest -- --limit 50 --lookback-hours 72 >> "${LOG_DIR}/ingest-rss.log" 2>&1
log "RSS ingest finished"