#!/bin/sh
# Installation de Passerelle 1.0.0 — Linux x86_64 avec systemd
# Usage : sudo ./install.sh [--no-start] | sudo ./install.sh --uninstall [--purge]
set -eu

PREFIX=/usr/local
BIN="$PREFIX/bin/passerelle"
DOC="$PREFIX/share/doc/passerelle"
ETC=/etc/passerelle
UNIT=/etc/systemd/system/passerelle.service
HERE=$(cd "$(dirname "$0")" && pwd)
START=1; ACTION=install; PURGE=0

usage() {
  cat <<'USAGE'
Usage :
  sudo ./install.sh              installe ou met à jour, puis démarre le service
  sudo ./install.sh --no-start   installe sans activer le service (image, Ansible…)
  sudo ./install.sh --uninstall  supprime le binaire et le service, garde /etc/passerelle
  sudo ./install.sh --uninstall --purge   supprime aussi la configuration et l’utilisateur
USAGE
}
say() { printf '%s\n' "$*"; }
die() { printf 'erreur : %s\n' "$*" >&2; exit 1; }

for a in "$@"; do
  case "$a" in
    --no-start) START=0 ;;
    --uninstall) ACTION=uninstall ;;
    --purge) PURGE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "option inconnue : $a" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "lancez ce script avec sudo"
has_systemd() { [ -d /run/systemd/system ]; }

if [ "$ACTION" = uninstall ]; then
  if has_systemd; then systemctl disable --now passerelle 2>/dev/null || true; fi
  rm -f "$UNIT" "$BIN"; rm -rf "$DOC"
  if has_systemd; then systemctl daemon-reload; fi
  if [ "$PURGE" -eq 1 ]; then
    rm -rf "$ETC"; userdel passerelle 2>/dev/null || true
    say "Passerelle supprimée, configuration et utilisateur compris."
  else
    say "Passerelle supprimée. Configuration conservée dans $ETC (--purge pour l’effacer)."
  fi
  exit 0
fi

# --- Prérequis ---------------------------------------------------------------
[ "$(uname -m)" = x86_64 ] || die "architecture $(uname -m) non prise en charge : x86_64 requis"
GLIBC=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}') || true
[ -n "${GLIBC:-}" ] || die "glibc introuvable : les distributions musl (Alpine) ne sont pas prises en charge"
MAJ=${GLIBC%%.*}; MIN=${GLIBC#*.}; MIN=${MIN%%.*}
if [ "$MAJ" -lt 2 ] || { [ "$MAJ" -eq 2 ] && [ "$MIN" -lt 28 ]; }; then
  die "glibc $GLIBC trop ancienne : 2.28 minimum (RHEL 8, Debian 10, Ubuntu 20.04 ou plus récent)"
fi
if [ "$START" -eq 1 ] && ! has_systemd; then
  die "systemd n’est pas actif sur cette machine : relancez avec --no-start"
fi
if [ -f "$HERE/SHA256SUMS" ] && command -v sha256sum >/dev/null 2>&1; then
  (cd "$HERE" && sha256sum -c --quiet SHA256SUMS) || die "somme de contrôle invalide : archive corrompue ou modifiée"
fi

# --- Utilisateur système -------------------------------------------------------
if ! getent passwd passerelle >/dev/null 2>&1; then
  NOLOGIN=$(command -v nologin 2>/dev/null || echo /usr/sbin/nologin)
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell "$NOLOGIN" passerelle
  say "Utilisateur système passerelle créé."
fi

# --- Fichiers ----------------------------------------------------------------
install -m 0755 "$HERE/bin/passerelle" "$BIN.new" && mv -f "$BIN.new" "$BIN"
install -d -m 0750 -o root -g passerelle "$ETC"
if [ ! -f "$ETC/passerelle.yaml" ]; then
  install -m 0640 -o root -g passerelle "$HERE/etc/passerelle.yaml" "$ETC/passerelle.yaml"
  say "Configuration d’exemple installée : $ETC/passerelle.yaml"
else
  say "Configuration existante conservée : $ETC/passerelle.yaml"
fi
if [ ! -f "$ETC/passerelle.env" ]; then
  TOKEN=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  ( umask 077; sed "s/^PASSERELLE_TOKEN=.*/PASSERELLE_TOKEN=$TOKEN/" "$HERE/etc/passerelle.env.example" > "$ETC/passerelle.env" )
  chown root:passerelle "$ETC/passerelle.env"; chmod 0640 "$ETC/passerelle.env"
  say "Jeton d’API généré dans $ETC/passerelle.env"
fi
install -d -m 0755 "$DOC"
install -m 0644 "$HERE/README.md" "$DOC/README.md"
for f in LICENSE NOTICE THIRD_PARTY_LICENSES/nodejs.txt; do
  if [ -f "$HERE/$f" ]; then install -m 0644 "$HERE/$f" "$DOC/$(basename "$f")"; fi
done
install -m 0644 "$HERE/systemd/passerelle.service" "$UNIT"

"$BIN" check-config --quiet --config "$ETC/passerelle.yaml" 2>/dev/null || { "$BIN" check-config --quiet --config "$ETC/passerelle.yaml" || true; die "la configuration $ETC/passerelle.yaml est invalide"; }

# --- Service -----------------------------------------------------------------
if [ "$START" -eq 1 ]; then
  systemctl daemon-reload
  systemctl enable passerelle >/dev/null 2>&1
  if systemctl is-active --quiet passerelle; then systemctl restart passerelle; else systemctl start passerelle; fi
  sleep 1
  if systemctl is-active --quiet passerelle; then
    say "Passerelle $("$BIN" version | awk '{print $2}') est démarrée sur 127.0.0.1:8080."
    say "Journal : journalctl -u passerelle -f"
  else
    journalctl -u passerelle -n 20 --no-pager >&2 || true
    die "le service n’a pas démarré"
  fi
else
  say "Installation terminée sans démarrage. Pour lancer : systemctl daemon-reload && systemctl enable --now passerelle"
fi
