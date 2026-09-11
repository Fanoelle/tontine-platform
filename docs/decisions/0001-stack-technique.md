# 0001 — Stack technique et conventions

- **Statut** : accepté
- **Date** : 11 septembre 2026
- **Exigences concernées** : N-INT-02, N-INT-05, N-SEC, N-USG-01, N-USG-03

## Contexte

Projet neuf, destiné à de vrais utilisateurs, manipulant des données
financières. Il fallait arrêter la stack, la langue du code et les conventions
avant d'écrire la première migration.

## Décision

| Élément | Choix |
|---|---|
| Base de données | PostgreSQL 16, conteneur Docker dédié |
| API | NestJS 10 + TypeScript |
| Accès base | `pg` brut, sans ORM |
| Interface | Web responsive |
| Langue | Français intégral |
| Identifiants | UUID |
| Montants | `BIGINT`, plus petite unité monétaire |
| Migrations | SQL numéroté, idempotent |
| Tests | Jest, en intégration contre une vraie base |

## Justification

**PostgreSQL pour ses garanties, pas pour son stockage.** Le choix est dicté par
N-INT-02 et N-INT-05 : les invariants financiers doivent être tenus par la base.
Contraintes `CHECK`, index uniques partiels, déclencheurs et transactions sont
ici des instruments de correction comptable, pas des détails d'implémentation.

**`pg` brut plutôt qu'un ORM.** Conséquence directe du point précédent. Puisque
le schéma porte la logique métier — équilibre des écritures par déclencheur,
unicité du bénéficiaire par index — un ORM masquerait l'essentiel derrière une
couche d'abstraction, tout en produisant des requêtes que l'on ne contrôle plus.
Le coût assumé : écrire ses requêtes à la main, et déclarer les types de lignes.

**NestJS pour ses gardes globales.** N-SEC-04 demande que les routes soient
protégées par défaut. Des gardes enregistrées globalement, ouvertes route par
route via un décorateur explicite, donnent exactement cette propriété : oublier
d'ouvrir une route la rend inaccessible — visible immédiatement — alors
qu'oublier de protéger exposerait des données en silence.

**Français intégral.** Le vocabulaire métier est nativement français —
cotisation, tour, bénéficiaire, cagnotte, reliquat. Traduire `cotisation` en
`contribution` introduirait une traduction permanente entre le langage des
utilisateurs et celui du code, source d'erreurs d'interprétation. L'interface
étant française (N-USG-03), aligner schéma, code et interface supprime toute
couche de correspondance. Seuls restent en anglais les identifiants imposés par
l'écosystème.

**UUID plutôt qu'entiers séquentiels.** Pas de fuite d'information par
incrément — le nombre de groupes ou de membres n'est pas déductible d'un
identifiant — et fusion de jeux de données sans collision.

**`BIGINT` pour les montants.** Un flottant ne porte jamais de l'argent :
`0.1 + 0.2 ≠ 0.3` en binaire, et une caisse ne tolère pas l'arrondi silencieux
(N-INT-03). Les montants sont des entiers dans la plus petite unité ; le franc
CFA n'ayant pas de sous-unité en pratique, l'unité est le franc.

**Tests d'intégration contre une vraie base.** Puisque les invariants vivent dans
le schéma, des doublures testeraient le code TypeScript en ignorant précisément
ce qui peut casser. Un test qui ne tente pas d'insérer une écriture
déséquilibrée ne prouve rien.

## Conventions

**Nommage SQL** — tables au singulier en `snake_case` (`membre`, `cotisation`,
`ligne_ecriture`) ; vues préfixées `v_` ; index suffixés `_idx` ; types `ENUM` en
`snake_case` à valeurs majuscules ; fonctions à l'infinitif, paramètres `p_`,
variables locales `v_`.

**Colonnes systématiques** — `id UUID PRIMARY KEY`, `cree_le` et `modifie_le` en
`TIMESTAMPTZ NOT NULL DEFAULT now()`. Les tables du journal comptable n'ont pas
de `modifie_le` : elles ne sont jamais modifiées (R-02).

**Suppression logique** pour les entités métier (`supprime BOOLEAN`), afin qu'un
membre radié conserve son historique (R-08). Le journal, lui, n'admet aucune
suppression, même logique.

**API** — réponses en objets nus, sans enveloppe ; `snake_case` à la frontière,
en miroir des colonnes ; codes HTTP porteurs de sens ; erreurs au format
standard NestJS.

**Commentaires** — ils expliquent le *pourquoi*, jamais le *quoi*. Chaque
fichier ouvre sur la justification d'un arbitrage, avec l'alternative écartée et
son coût. Les exigences sont référencées par code (`F-COT-02`, `R-01`), pour
relier le code au cahier des charges dans les deux sens.

**Migrations** — fichiers numérotés à trois chiffres, encadrés d'une
transaction, **ré-exécutables sans effet de bord** : il n'existe pas de table de
suivi, l'ordre et l'idempotence tiennent lieu de mécanisme.

## Conséquences

- Requêtes SQL écrites et maintenues à la main.
- Interfaces de lignes déclarées manuellement en TypeScript.
- Les tests exigent une base démarrée (`./scripts/db.sh demarrer`).
- Une partie de la logique vit en SQL : elle doit être documentée par
  `COMMENT ON`, sans quoi elle deviendrait invisible depuis le code.

## Références

- Contraintes techniques — [`../cahier-des-charges.md`](../cahier-des-charges.md) §8
- Décisions liées — [`0002`](0002-socle-commun-tables-specialisees.md), [`0003`](0003-journal-partie-double.md)
