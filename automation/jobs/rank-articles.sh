#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_common.sh"
cd "$REPO_ROOT"
log "Article ranking starting"
npm run job:rank -- --article-limit 100 >> "${LOG_DIR}/rank-articles.log" 2>&1
log "Article ranking finished"