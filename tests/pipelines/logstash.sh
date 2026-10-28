#!/bin/sh
# Joue dans un seul Logstash tous les pipelines préparés par run.mjs. Chaque entrée est un fichier lu une fois :
# Logstash s'arrête de lui-même quand tous l'ont été.
#   tests/pipelines/logstash.sh <dossier>     le dossier contient pipelines.yml, conf/, in/ et out/
# LOGSTASH_VERSION (défaut 9.5.5) est pris dans l'environnement.
set -eu
LOGSTASH_VERSION="${LOGSTASH_VERSION:-9.5.5}"
DIR="${1:?usage : $0 <dossier>}"
NAME="passerelle-pipelines-logstash"
IMAGE="docker.elastic.co/logstash/logstash:${LOGSTASH_VERSION}"

echo "Logstash ${LOGSTASH_VERSION}"
docker rm -f "$NAME" >/dev/null 2>&1 || true
# Greffons absents de la distribution (bytes…), listés par run.mjs : installés dans le conteneur avant le démarrage
PLUGINS=""
if [ -s "$DIR/plugins.txt" ]; then PLUGINS="$(cat "$DIR/plugins.txt")"; fi
if [ -n "$PLUGINS" ]; then
  set -- --entrypoint /bin/bash "$IMAGE" -c "bin/logstash-plugin install $PLUGINS && exec /usr/local/bin/docker-entrypoint --log.level=warn"
else
  set -- "$IMAGE" --log.level=warn
fi
VOLUMES="-v $DIR:/work -v $DIR/pipelines.yml:/usr/share/logstash/config/pipelines.yml:ro"

if [ ! -s "$DIR/chains.txt" ]; then
  # shellcheck disable=SC2086
  exec docker run --rm --name "$NAME" $VOLUMES -e XPACK_MONITORING_ENABLED=false "$@"
fi

# Des pipelines n'écoutent qu'une adresse (pipeline { address }) : Logstash ne s'arrête pas seul. Le banc attend que
# chaque fichier d'entrée soit lu (file_completed_log_path), laisse les pipelines en aval se vider, puis arrête
# Logstash proprement (SIGTERM), ce qui écoule les événements en cours et ferme les fichiers de sortie.
# shellcheck disable=SC2086
docker run -d --name "$NAME" $VOLUMES -e XPACK_MONITORING_ENABLED=false "$@" >/dev/null
# chains.txt donne le nombre de pipelines qui lisent un fichier : un par cas et par mode ECS
FILES=$(cat "$DIR/chains.txt")
i=0
while [ "$i" -lt 540 ]; do
  [ -n "$(docker ps -q -f "name=^/${NAME}$")" ] || break
  DONE=0
  if [ -f "$DIR/out/.lus" ]; then DONE=$(wc -l < "$DIR/out/.lus" | tr -d " "); fi
  [ "$DONE" -ge "$FILES" ] && break
  sleep 1
  i=$((i + 1))
done
sleep 10
docker stop -t 120 "$NAME" >/dev/null 2>&1 || true
docker logs "$NAME" 2>&1 || true
docker rm "$NAME" >/dev/null 2>&1 || true
