#!/usr/bin/env bash
set -euo pipefail

workflow_database="${WORKFLOW_DATABASE_NAME:-nusift_workflow}"
if [[ ! "$workflow_database" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "WORKFLOW_DATABASE_NAME must be a PostgreSQL identifier." >&2
  exit 1
fi

if psql --username "$POSTGRES_USER" --dbname postgres --tuples-only --no-align \
  --command "SELECT 1 FROM pg_database WHERE datname = '$workflow_database';" | grep -qx '1'; then
  echo "Workflow database already exists."
else
  createdb --username "$POSTGRES_USER" "$workflow_database"
  echo "Created workflow database '$workflow_database'."
fi
