# 0002 — Socle commun et tables spécialisées par mécanisme

- **Statut** : accepté
- **Date** : 11 septembre 2026
- **Exigences concernées** : F-GRP-01, F-TOU, F-EPA, F-AID, R-04, N-INT-05

## Contexte

La plateforme doit couvrir trois mécanismes : tontine rotative (ROSCA), caisse
d'épargne cumulative (ASCA) et association mutualiste. Ils partagent beaucoup —
des groupes, des membres, des rôles, des cotisations, un journal comptable — mais
leurs **règles d'argent sont incompatibles** :

| | ROSCA | ASCA | Mutuelle |
|---|---|---|---|
| Devenir de la caisse | vidée à chaque tour | croît puis est redistribuée | croît et se dépense |
| Droit du membre | recevoir la cagnotte une fois | solde d'épargne individuel | aucun droit individuel |
| Solde théorique | retombe à zéro | somme des épargnes | cotisations − aides |
| Fin de cycle | tous ont bénéficié | redistribution au prorata | pas de fin naturelle |

Un même schéma doit représenter les trois sans que les règles de l'un
contaminent les autres.

## Décision

**Un socle commun de tables partagées, plus une table spécialisée par
mécanisme.**

```
                    groupe (type: ROSCA | ASCA | MUTUELLE)
                           │
        ┌──────────────────┼──────────────────┐
        │      SOCLE COMMUN — toujours présent │
        │  membre · role · membre_role         │
        │  cycle · echeance · cotisation       │
        │  compte · ecriture · ligne_ecriture  │
        └──────────────────┬──────────────────┘
                           │
      ┌────────────────────┼────────────────────┐
      │                    │                    │
 ┌────┴─────┐      ┌───────┴──────┐      ┌──────┴──────┐
 │  ROSCA   │      │     ASCA     │      │  MUTUELLE   │
 │ tour     │      │ epargne_     │      │ aide        │
 │ (rang,   │      │ membre       │      │ (motif,     │
 │  benef.) │      │ (solde,parts)│      │  montant)   │
 └──────────┘      └──────────────┘      └─────────────┘
```

Une table spécialisée n'existe que pour les groupes du type correspondant. Une
contrainte vérifie cette cohérence : une ligne de `tour` ne peut référencer qu'un
groupe de type `ROSCA`.

## Justification

**Chaque règle reste exprimable en contrainte SQL.** C'est l'argument décisif, et
il découle de N-INT-05. « Un membre ne bénéficie qu'une fois par cycle » (R-04)
s'écrit comme un index unique sur `(cycle_id, beneficiaire_id)` — la base la
refuse, quoi que fasse l'application. Dans un modèle générique piloté par
configuration, cette règle ne serait qu'une ligne de code, contournable par tout
chemin d'écriture qui l'oublierait.

**Le schéma reste lisible.** Un développeur qui ouvre `tour` voit immédiatement
ce qu'est un tour de rôle. Une table `evenement_financier` générique portant
quinze colonnes nullables selon le contexte n'apprend rien à personne, et son
sens véritable vit ailleurs, dans du code.

**Les trois mécanismes évoluent indépendamment.** Ajouter les enchères au tour de
rôle — pratique courante où le bénéficiaire se désigne par offre — touche `tour`
seule. Aucun risque de régression sur les mutuelles.

**Le socle commun évite la triple implémentation.** Membres, rôles, cotisations
et surtout le journal comptable sont écrits une fois. Un groupe ASCA et une
mutuelle partagent exactement le même mécanisme d'écritures équilibrées.

## Conséquences

### Positives

- Invariants financiers garantis par la base, pas par convention.
- Schéma auto-documenté, lisible sans mode d'emploi.
- Évolution d'un mécanisme sans effet de bord sur les autres.
- Requêtes transverses simples : le journal est commun aux trois.

### Négatives, et leur traitement

| Coût | Traitement |
|---|---|
| Un nouveau mécanisme demande une migration, pas une simple configuration | Assumé : trois mécanismes couvrent l'immense majorité des usages, et un quatrième mérite qu'on l'étudie |
| Le code applicatif branche selon le type de groupe | Un service par mécanisme, derrière une interface commune ; l'aiguillage se fait en un seul point |
| Les variantes locales ne sont pas paramétrables à l'infini | Les variantes fréquentes (ordre de passage, taux d'intérêt) sont des colonnes ; les autres attendent d'être rencontrées |

## Alternatives écartées

**Moteur de règles configurable (`regles JSONB`).** Séduisant sur le papier :
tout groupe devient représentable sans migration. Écarté pour une raison
dirimante — **aucun invariant financier ne peut plus être garanti par le
schéma**. Une contrainte `CHECK` ne peut pas s'appuyer sur des règles qui
changent à l'exécution. Pour un produit qui manipule l'argent de tiers, déplacer
les garde-fous du schéma vers du code interprété est un mauvais échange :
l'erreur devient silencieuse et ne se révèle qu'en production, sur des comptes
réels. La flexibilité gagnée ne compense pas la garantie perdue.

**Table unique avec colonnes nullables.** Une seule table couvrant les trois
mécanismes, chaque colonne servant selon le type. Écartée : les colonnes
nullables rendent toute contrainte conditionnelle, le sens de chaque champ
dépend d'une autre colonne, et rien n'empêche un groupe mutualiste de porter un
rang de tour de rôle.

**Trois schémas entièrement séparés.** Écartée : triple implémentation du
journal comptable, des membres et des cotisations, pour un bénéfice
d'isolation qu'une contrainte de cohérence de type procure déjà.

**Modéliser un seul mécanisme d'abord.** Raisonnable, mais le socle commun est
précisément ce qui demande à être pensé pour les trois dès le départ : le
rétro-adapter coûterait plus cher que de le concevoir correctement une fois.

## Références

- Typologie des groupes — [`../cahier-des-charges.md`](../cahier-des-charges.md) §3
- Schéma détaillé — [`../modele-de-donnees.md`](../modele-de-donnees.md)
- Décision liée — [`0003-journal-partie-double.md`](0003-journal-partie-double.md)
