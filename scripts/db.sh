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

commande_verifier() {
  conteneur_tourne || erreur "le conteneur n'est pas démarré — lancez : $0 demarrer"
  bannière 'Vérification des invariants'

  # Ces contrôles reproduisent ce qu'une application boguée tenterait de faire.
  # Un invariant qui n'a jamais été mis à l'épreuve n'est pas un invariant :
  # c'est une intention.
  local echecs=0

  verifier_refus() {
    local libelle="$1" sql="$2"
    printf '  %-46s' "$libelle"
    if psql_base -q -c "$sql" > /dev/null 2>&1; then
      printf '\e[31mACCEPTÉ (anormal)\e[0m\n'
      echecs=$((echecs + 1))
    else
      printf '\e[32mrefusé\e[0m\n'
    fi
  }

  verifier_refus 'R-02 modification d une écriture' \
    "UPDATE ecriture SET libelle = 'x' WHERE id = (SELECT id FROM ecriture LIMIT 1);"
  verifier_refus 'R-02 suppression d une ligne' \
    "DELETE FROM ligne_ecriture WHERE id = (SELECT id FROM ligne_ecriture LIMIT 1);"
  verifier_refus 'R-03 montant négatif' \
    "INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant)
     SELECT (SELECT id FROM ecriture LIMIT 1), (SELECT id FROM compte LIMIT 1), 'DEBIT', -1;"
  verifier_refus 'R-04 deux tours pour un même membre' \
    "INSERT INTO tour (cycle_id, rang, beneficiaire_id, date_remise_prevue)
     SELECT cycle_id, 99, beneficiaire_id, CURRENT_DATE FROM tour LIMIT 1;"
  verifier_refus 'R-10 téléphone dupliqué' \
    "INSERT INTO membre (groupe_id, nom_complet, telephone, date_adhesion)
     SELECT groupe_id, 'Doublon', telephone, CURRENT_DATE FROM membre LIMIT 1;"
  verifier_refus 'F-GRP-01 changement de type de groupe' \
    "UPDATE groupe SET type = 'MUTUELLE' WHERE id = (SELECT id FROM groupe LIMIT 1);"

  printf '\n  Équilibre global du journal : '
  local ecart
  ecart=$(psql_base -tAc \
    "SELECT COALESCE(SUM(CASE sens WHEN 'DEBIT' THEN montant ELSE -montant END), 0)
       FROM ligne_ecriture;")
  if [ "$ecart" = '0' ]; then
    printf '\e[32m0 — équilibré\e[0m\n'
  else
    printf '\e[31mécart de %s\e[0m\n' "$ecart"
    echecs=$((echecs + 1))
  fi

  printf '\n'
  [ "$echecs" -eq 0 ] || erreur "$echecs contrôle(s) en échec"
  succès 'tous les invariants tiennent'
}

commande_recette() {
  conteneur_tourne || erreur "le conteneur n'est pas démarré — lancez : $0 demarrer"

  # La recette CONSOMME le jeu de données : elle mène le cycle jusqu'à sa
  # clôture. On repart donc d'un état neuf, sans quoi un second passage
  # trouverait un cycle déjà clôturé et échouerait pour une mauvaise raison.
  commande_reinitialiser > /dev/null

  bannière 'Recette — critère du jalon 1'
  psql_base -q < "$RACINE/db/recette/001_cycle_complet.sql"
}

commande_recette_jalon2() {
  conteneur_tourne || erreur "le conteneur n'est pas démarré — lancez : $0 demarrer"

  # Comme la recette du jalon 1, celle-ci CONSOMME le jeu de données : elle
  # solde un prêt, verse une aide et provoque un déséquilibre. On repart donc
  # d'un état neuf, sans quoi un second passage échouerait pour une mauvaise
  # raison — un prêt déjà soldé, une anomalie déjà levée.
  commande_reinitialiser > /dev/null

  bannière 'Recette — critère du jalon 2'
  psql_base -q < "$RACINE/db/recette/002_jalon2.sql"
}

commande_aide() {
  cat <<'AIDE'
Usage : ./scripts/db.sh <commande>

  demarrer        Démarre la base, applique migrations et jeux de données
  arreter         Arrête le conteneur en conservant les données
  reinitialiser   Vide le schéma et réapplique tout
  verifier        Éprouve les invariants : tente des violations, attend un refus
  recette         Mène un cycle ROSCA complet et vérifie le critère du jalon 1
  recette-jalon2  Prêt ASCA soldé, aide versée, anomalies détectées (jalon 2)
  console         Ouvre une console psql
  tester          Vérifie la connexion
  supprimer       Supprime le conteneur et ses données (confirmation demandée)
AIDE
}

case "${1:-aide}" in
  demarrer)      commande_demarrer ;;
  arreter)       commande_arreter ;;
  reinitialiser) commande_reinitialiser ;;
  verifier)      commande_verifier ;;
  recette)         commande_recette ;;
  recette-jalon2)  commande_recette_jalon2 ;;
  console)       commande_console ;;
  tester)        commande_tester ;;
  supprimer)     commande_supprimer ;;
  aide|--help|-h) commande_aide ;;
  *) erreur "commande inconnue : $1 (voir : $0 aide)" ;;
esac
