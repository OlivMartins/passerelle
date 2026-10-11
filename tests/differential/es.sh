#!/bin/sh
# Démarre ou arrête l'Elasticsearch du banc différentiel dans Docker.
#   tests/differential/es.sh up     nœud unique, sans sécurité, lié à 127.0.0.1
#   tests/differential/es.sh down
# ES_VERSION (défaut 8.19.22) et ES_PORT (défaut 9200) sont pris dans l'environnement.
set -eu
ES_VERSION="${ES_VERSION:-8.19.22}"
ES_PORT="${ES_PORT:-9200}"
NAME="passerelle-diff-es"

case "${1:-}" in
  up)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p "127.0.0.1:${ES_PORT}:9200" \
      -e discovery.type=single-node -e xpack.security.enabled=false \
      -e ES_JAVA_OPTS="-Xms1g -Xmx1g" -e cluster.routing.allocation.disk.threshold_enabled=false \
      "docker.elastic.co/elasticsearch/elasticsearch:${ES_VERSION}" >/dev/null
    i=0
    while [ "$i" -lt 90 ]; do
      if curl -s "http://127.0.0.1:${ES_PORT}/_cluster/health" | grep -q '"status":"\(green\|yellow\)"'; then
        echo "Elasticsearch ${ES_VERSION} prêt sur http://127.0.0.1:${ES_PORT}"
        exit 0
      fi
      i=$((i + 1))
      sleep 2
    done
    echo "Elasticsearch ${ES_VERSION} ne répond pas :" >&2
    docker logs --tail 20 "$NAME" >&2
    exit 1
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "Elasticsearch arrêté"
    ;;
  *)
    echo "usage : $0 up|down" >&2
    exit 2
    ;;
esac
