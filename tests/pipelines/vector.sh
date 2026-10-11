#!/bin/sh
# Joue dans Vector chaque configuration traduite, l'une après l'autre : conf/<cas>.yaml reçoit in/<cas>.ndjson
# sur son entrée standard et s'arrête à la fin. La configuration est celle que produit Passerelle, sans retouche.
#   tests/pipelines/vector.sh <dossier>     le dossier contient conf/, in/, out/, log/ et data/
# VECTOR_VERSION (défaut 0.59.0) est pris dans l'environnement.
set -eu
VECTOR_VERSION="${VECTOR_VERSION:-0.59.0}"
DIR="${1:?usage : $0 <dossier>}"
NAME="passerelle-pipelines-vector"

docker rm -f "$NAME" >/dev/null 2>&1 || true
# data/ tient lieu de /var/lib/vector : le conteneur tourne avec l'utilisateur courant, pas en root
exec docker run --rm --name "$NAME" --user "$(id -u):$(id -g)" \
  -v "$DIR:/work" -v "$DIR/data:/var/lib/vector" --entrypoint /bin/sh \
  "timberio/vector:${VECTOR_VERSION}-debian" -c '
    vector --version
    for conf in /work/conf/*.yaml; do
      [ -e "$conf" ] || continue
      cas=$(basename "$conf" .yaml)
      code=0
      vector --quiet --color never --config "$conf" < "/work/in/$cas.ndjson" > "/work/log/$cas.log" 2>&1 || code=$?
      echo "$cas $code" >> /work/codes
    done'
