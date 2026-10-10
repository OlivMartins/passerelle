#!/bin/sh
# Extrait le binaire ClickHouse d'une version précise de son image Docker officielle.
#   tests/differential/clickhouse.sh [version] [destination]
# Le binaire sert de clickhouse-local, sans serveur :
#   CLICKHOUSE_LOCAL="$PWD/clickhouse local" npm run test:diff
# Hors ligne, il suffit de copier ce fichier sur la machine : il n'a aucune dépendance.
set -eu
VERSION="${1:-26.9}"
TARGET="${2:-./clickhouse}"

id=$(docker create "clickhouse/clickhouse-server:${VERSION}")
docker cp -L "${id}:/usr/bin/clickhouse" "$TARGET" >/dev/null
docker rm "$id" >/dev/null
chmod +x "$TARGET"
"$TARGET" local --version
