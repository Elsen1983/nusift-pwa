#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
docker compose -f "${DIR}/docker-compose.yml" up -d
echo "PostgreSQL ready on localhost:5433"