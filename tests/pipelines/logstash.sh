#!/bin/sh
# Joue dans un seul Logstash tous les pipelines préparés par run.mjs. Chaque entrée est un fichier lu une fois :
# Logstash s'arrête de lui-même quand tous l'ont été.
#   tests/pipelines/logstash.sh <dossier>     le dossier contient pipelines.yml, conf/, in/ et out/
# LOGSTASH_VERSION (défaut 9.5.5) est pris dans l'environnement.
set -eu
LOGSTASH_VERSION="${LOGSTASH_VERSION:-9.5.5}"
DIR="${1:?usage : $0 <dossier>}"
NAME="passerelle-pipelines-logstash"

echo "Logstash ${LOGSTASH_VERSION}"
docker rm -f "$NAME" >/dev/null 2>&1 || true
exec docker run --rm --name "$NAME" \
  -v "$DIR:/work" -v "$DIR/pipelines.yml:/usr/share/logstash/config/pipelines.yml:ro" \
  -e XPACK_MONITORING_ENABLED=false \
  "docker.elastic.co/logstash/logstash:${LOGSTASH_VERSION}" --log.level=warn
