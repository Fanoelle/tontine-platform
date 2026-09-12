#!/usr/bin/env bash
# =============================================================================
# Génère les diagrammes UML en PNG
#
# POURQUOI PLANTUML ET NON MERMAID-CLI. Trois tentatives d'installation de
# @mermaid-js/mermaid-cli ont échoué sur ce poste — arbre de dépendances lourd
# (React, Puppeteer) et réseau intermittent. PlantUML est déjà installé, ne
# dépend que de Java et Graphviz, et rend HORS LIGNE.
#
# Le gain n'est pas seulement pratique : PlantUML produit la notation UML
# standard, avec acteurs en bonhommes et relations <<include>>, là où Mermaid
# n'a pas de diagramme de cas d'utilisation du tout.
#
# Usage :  ./scripts/generer-uml.sh
# =============================================================================

set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCES="$RACINE/docs/uml"
IMAGES="$RACINE/docs/uml/images"

bannière() { printf '\n===== %s =====\n' "$1"; }
erreur()   { printf '\e[31mErreur :\e[0m %s\n' "$1" >&2; exit 1; }
succès()   { printf '\e[32m✓\e[0m %s\n' "$1"; }

command -v plantuml > /dev/null 2>&1 \
  || erreur "plantuml absent — installez-le : sudo apt install plantuml"

command -v dot > /dev/null 2>&1 \
  || erreur "graphviz absent — requis pour les diagrammes de classes et d'états"

mkdir -p "$IMAGES"

bannière 'Génération des diagrammes UML'

compteur=0
echecs=0

for source in "$SOURCES"/*.puml; do
  [ -e "$source" ] || continue
  fichier="$(basename "$source" .puml)"

  # LE NOM DU PNG VIENT DE LA DIRECTIVE @startuml, PAS DU NOM DE FICHIER.
  #
  # `@startuml cas-utilisation` produit cas-utilisation.png, quel que soit le
  # nom du .puml. Chercher "01-cas-utilisation.png" faisait donc conclure à un
  # échec sur sept diagrammes parfaitement générés — le script se trompait, pas
  # PlantUML. Les journaux d'erreur vides le disaient déjà.
  nom="$(sed -n 's/^@startuml[[:space:]]\+\([^[:space:]]\+\).*/\1/p' "$source" | head -1)"
  [ -n "$nom" ] || nom="$fichier"

  printf '  %-28s ' "$fichier"

  # -tpng : PNG plutôt que SVG. Un PNG s'insère dans un PDF sans surprise de
  # police ; un SVG y dépend des polices de la machine qui imprime.
  if plantuml -tpng -o "$IMAGES" "$source" 2> "$IMAGES/.$fichier.log"; then
    if [ -f "$IMAGES/$nom.png" ]; then
      taille="$(du -h "$IMAGES/$nom.png" | cut -f1)"
      printf '\e[32mOK\e[0m  %-6s -> %s.png\n' "$taille" "$nom"
      compteur=$((compteur + 1))
      rm -f "$IMAGES/.$fichier.log"
    else
      printf '\e[31mpas de PNG produit\e[0m\n'
      echecs=$((echecs + 1))
    fi
  else
    printf '\e[31mECHEC\e[0m\n'
    head -3 "$IMAGES/.$fichier.log" | sed 's/^/      /'
    echecs=$((echecs + 1))
  fi
done

printf '\n'
[ "$echecs" -eq 0 ] || erreur "$echecs diagramme(s) en échec"
succès "$compteur diagramme(s) générés dans docs/uml/images/"
