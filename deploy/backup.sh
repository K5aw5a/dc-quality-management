#!/usr/bin/env bash
# Nightly consistent SQLite backup, encrypted, then copied off-site.
# Cron: 15 2 * * * /opt/dc-quality/deploy/backup.sh
# Needs: sqlite3, gpg (with BACKUP_GPG_RECIPIENT's public key imported), rclone (with a "offsite" remote configured).
set -euo pipefail

DB_PATH="${DB_PATH:-/var/lib/dc-quality/qm.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/dc-quality}"
RECIPIENT="${BACKUP_GPG_RECIPIENT:?set BACKUP_GPG_RECIPIENT}"
REMOTE="${BACKUP_REMOTE:-offsite:dc-quality-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
snapshot="$BACKUP_DIR/qm-$stamp.db"

# .backup takes a consistent copy even while the app is writing (WAL mode).
sqlite3 "$DB_PATH" ".backup '$snapshot'"
sqlite3 "$snapshot" 'PRAGMA integrity_check;' | grep -qx ok
gzip "$snapshot"
gpg --batch --yes --encrypt --recipient "$RECIPIENT" --output "$snapshot.gz.gpg" "$snapshot.gz"
rm -f "$snapshot.gz"

rclone copy "$snapshot.gz.gpg" "$REMOTE"
find "$BACKUP_DIR" -name 'qm-*.db.gz.gpg' -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $snapshot.gz.gpg"
