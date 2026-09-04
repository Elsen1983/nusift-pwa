#!/bin/sh
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

case "$RETENTION_DAYS" in
  ''|*[!0-9]*)
    echo "[backup] BACKUP_RETENTION_DAYS must be a non-negative integer." >&2
    exit 1
    ;;
esac

umask 077
mkdir -p "$BACKUP_DIR"

backup_database() {
  label="$1"
  database="$2"
  timestamp="$3"
  output="$BACKUP_DIR/nusift-${label}-${timestamp}.dump"
  partial="$output.partial"

  rm -f "$partial"
  echo "[backup] creating ${label} database backup"
  if ! pg_dump --no-password --format=custom --dbname="$database" --file="$partial"; then
    rm -f "$partial"
    return 1
  fi
  if ! pg_restore --list "$partial" >/dev/null; then
    rm -f "$partial"
    echo "[backup] validation failed for ${label} database backup" >&2
    return 1
  fi

  mv "$partial" "$output"
  echo "[backup] completed $(basename "$output") ($(du -h "$output" | cut -f1), $(sha256sum "$output" | cut -d' ' -f1))"
}

run_backup() {
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_database "app" "$APP_DATABASE_NAME" "$timestamp"
  backup_database "workflow" "$WORKFLOW_DATABASE_NAME" "$timestamp"
  find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'nusift-app-*.dump' -o -name 'nusift-workflow-*.dump' \) \
    -mtime "+$RETENTION_DAYS" -delete
  echo "[backup] retention cleanup complete (${RETENTION_DAYS} days)"
}

run_backup

while :; do
  now="$(date -u +%s)"
  next="$(date -u -d 'tomorrow 02:00' +%s)"
  delay="$((next - now))"
  echo "[backup] next run at $(date -u -d "@$next" +%Y-%m-%dT%H:%M:%SZ)"
  sleep "$delay" &
  wait "$!" || exit 0
  run_backup
done
