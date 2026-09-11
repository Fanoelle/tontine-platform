#!/usr/bin/env bash
# =============================================================================
# Pilotage de la base PostgreSQL de développement
#
# La base tourne dans un conteneur DÉDIÉ à ce projet. Le port hôte 55433 est
# choisi pour n'entrer en conflit ni avec le PostgreSQL local (5432), ni avec
# les conteneurs d'autres projets de la machine (55432 est déjà pris).
#
# Les migrations n'ont pas de table de suivi : elles sont appliquées dans
# l'ordre numérique et doivent être RÉ-EXÉCUTABLES sans effet de bord. Un outil
# de migration serait plus confortable, mais il masquerait le SQL — or ici le
# schéma porte les invariants financiers (décision 0001), il doit rester lisible.
# =============================================================================

set -euo pipefail

CONTENEUR="tontine-db"
IMAGE="postgres:16-alpine"
PORT=55433
BASE="tontine"
UTILISATEUR="postgres"
MOT_DE_PASSE="dev"

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bannière() { printf '\n===== %s =====\n' "$1"; }
erreur()   { printf '\e[31mErreur :\e[0m %s\n' "$1" >&2; exit 1; }
succès()   { printf '\e[32m✓\e[0m %s\n' "$1"; }

conteneur_existe() { docker ps -a --format '{{.Names}}' | grep -qx "$CONTENEUR"; }
conteneur_tourne() { docker ps    --format '{{.Names}}' | grep -qx "$CONTENEUR"; }

psql_base() {
  docker exec -i -e PGPASSWORD="$MOT_DE_PASSE" "$CONTENEUR" \
    psql -v ON_ERROR_STOP=1 -U "$UTILISATEUR" -d "$BASE" "$@"
}

attendre_disponibilite() {
  printf 'Attente de la base'
  for _ in $(seq 1 30); do
    if docker exec "$CONTENEUR" pg_isready -U "$UTILISATEUR" -q 2>/dev/null; then
      printf '\n'; succès 'base prête'; return 0
    fi
    printf '.'; sleep 1
  done
  printf '\n'; erreur "la base n'a pas répondu après 30 secondes"
}

appliquer_migrations() {
  bannière 'Migrations'
  # Identifiant sans accent : « local » n'accepte que des caractères ASCII.
  local trouve=0
  for fichier in "$RACINE"/db/migrations/*.sql; do
    [ -e "$fichier" ] || continue
    trouve=1
    printf '  %s ... ' "$(basename "$fichier")"
    psql_base -q < "$fichier" && printf 'ok\n'
  done
  [ "$trouve" -eq 1 ] || printf '  (aucune migration)\n'
}

appliquer_seeds() {
  bannière 'Jeux de données'
  local trouve=0
  for fichier in "$RACINE"/db/seeds/*.sql; do
    [ -e "$fichier" ] || continue
    trouve=1
    printf '  %s ... ' "$(basename "$fichier")"
    psql_base -q < "$fichier" && printf 'ok\n'
  done
  [ "$trouve" -eq 1 ] || printf '  (aucun jeu de données)\n'
}

commande_demarrer() {
  if conteneur_tourne; then
    succès "conteneur $CONTENEUR déjà démarré"
  elif conteneur_existe; then
    bannière 'Redémarrage'
    docker start "$CONTENEUR" > /dev/null
    attendre_disponibilite
  else
    bannière "Création du conteneur $CONTENEUR"
    docker run -d --name "$CONTENEUR" \
      -e POSTGRES_PASSWORD="$MOT_DE_PASSE" \
      -e POSTGRES_DB="$BASE" \
      -p "$PORT:5432" \
      "$IMAGE" > /dev/null
    attendre_disponibilite
  fi
  appliquer_migrations
  appliquer_seeds
  bannière 'Prêt'
  printf 'DSN : postgresql://%s:%s@localhost:%s/%s\n' \
    "$UTILISATEUR" "$MOT_DE_PASSE" "$PORT" "$BASE"
}

commande_arreter() {
  conteneur_tourne || { succès 'conteneur déjà arrêté'; return; }
  docker stop "$CONTENEUR" > /dev/null
  succès 'conteneur arrêté (les données sont conservées)'
}

commande_reinitialiser() {
  conteneur_tourne || erreur "le conteneur n'est pas démarré"
  bannière 'Réinitialisation du schéma'
  psql_base -q -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
  succès 'schéma vidé'
  appliquer_migrations
  appliquer_seeds
}

commande_console()  { docker exec -it "$CONTENEUR" psql -U "$UTILISATEUR" -d "$BASE"; }

commande_tester() {
  conteneur_tourne || erreur "le conteneur n'est pas démarré — lancez : $0 demarrer"
  psql_base -q -c 'SELECT 1;' > /dev/null
  succès "connexion à $BASE sur le port $PORT"
}

commande_supprimer() {
  conteneur_existe || { succès "aucun conteneur $CONTENEUR"; return; }
  printf 'Supprimer le conteneur %s et TOUTES ses données ? [o/N] ' "$CONTENEUR"
  # Identifiant sans accent : « read » n'accepte que des noms ASCII.
  read -r reponse
  [ "$reponse" = 'o' ] || { printf 'Annulé.\n'; return; }
  docker rm -f "$CONTENEUR" > /dev/null
  succès 'conteneur supprimé'
}

commande_aide() {
  cat <<'AIDE'
Usage : ./scripts/db.sh <commande>

  demarrer        Démarre la base, applique migrations et jeux de données
  arreter         Arrête le conteneur en conservant les données
  reinitialiser   Vide le schéma et réapplique tout
  console         Ouvre une console psql
  tester          Vérifie la connexion
  supprimer       Supprime le conteneur et ses données (confirmation demandée)
AIDE
}

case "${1:-aide}" in
  demarrer)      commande_demarrer ;;
  arreter)       commande_arreter ;;
  reinitialiser) commande_reinitialiser ;;
  console)       commande_console ;;
  tester)        commande_tester ;;
  supprimer)     commande_supprimer ;;
  aide|--help|-h) commande_aide ;;
  *) erreur "commande inconnue : $1 (voir : $0 aide)" ;;
esac
