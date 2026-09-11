# 0003 — Journal comptable immuable en partie double

- **Statut** : accepté
- **Date** : 11 septembre 2026
- **Exigences concernées** : F-TRX-01 à F-TRX-05, F-COT-05, N-INT-01, N-INT-02, R-01, R-02

## Contexte

La plateforme enregistre des mouvements d'argent réels appartenant à des
personnes réelles. Le trésorier doit pouvoir rendre des comptes, et un membre
qui conteste un solde doit pouvoir obtenir une réponse vérifiable, pas une
affirmation.

Trois niveaux de rigueur étaient envisageables :

1. **Table de mouvements simple.** Une ligne par transaction, modifiable.
2. **Mouvements + journal d'audit.** Idem, doublé d'une trace des modifications.
3. **Journal immuable en partie double.** Toute somme est portée au débit d'un
   compte et au crédit d'un autre ; rien n'est jamais modifié.

## Décision

Nous retenons le **journal immuable en partie double**.

Chaque opération donne lieu à une **écriture** composée d'au moins deux
**lignes**, dont la somme des débits égale la somme des crédits. Une écriture
validée n'est jamais modifiée ni supprimée : une erreur se corrige par une
**écriture inverse** qui référence l'écriture d'origine.

Chaque groupe dispose d'un plan de comptes : caisse, banque, épargne par membre,
créances de prêt, produits d'intérêt, fonds d'aide.

```
Exemple — cotisation de 5 000 F du membre Awa, réglée en espèces

  Écriture #412  « Cotisation mars 2026 — Awa »   (F-COT-02)
    ├─ DÉBIT   caisse_espèces        5 000
    └─ CRÉDIT  cotisations_membre_Awa 5 000
                                     ─────
                        équilibre :      0  ✓
```

## Justification

**Un solde faux devient structurellement impossible.** Avec une table simple, un
solde est une valeur que l'on maintient — donc que l'on peut désynchroniser. En
partie double, un solde se *recalcule* à partir du journal. Un écart cesse
d'être une opinion : c'est un déséquilibre arithmétique, localisable à
l'écriture près.

**La détection d'anomalies y gagne sa rigueur.** C'est l'argument décisif, et il
n'est pas évident au premier abord : l'exigence F-ANO-04 (« incohérence de
solde ») n'a de sens que s'il existe une vérité comptable à laquelle se
comparer. Sans partie double, détecter une incohérence reviendrait à comparer
une somme à elle-même. Avec elle, la vérification est une identité qui tient ou
ne tient pas.

**L'immuabilité protège le trésorier autant que les membres.** Un registre
modifiable expose son gestionnaire au soupçon, puisque rien ne prouve qu'une
ligne n'a pas été retouchée. Un registre immuable rend le soupçon sans objet :
l'historique complet, corrections comprises, reste visible de tous.

**C'est la pratique comptable universelle.** Sept siècles d'usage, un vocabulaire
partagé, et une compatibilité naturelle avec tout audit externe ou obligation
déclarative ultérieure.

## Conséquences

### Positives

- Comptes vérifiables par reconstruction intégrale.
- Piste d'audit complète, corrections incluses.
- Base solide et non ambiguë pour le moteur d'anomalies.
- Situation de caisse disponible à n'importe quelle date passée.

### Négatives, et leur traitement

| Coût | Traitement |
|---|---|
| Modèle plus abstrait qu'une table de mouvements | Documenté ici et dans le MCD ; l'interface ne l'expose jamais tel quel (N-USG-05) |
| Une correction demande deux écritures au lieu d'une modification | L'application propose « annuler et ressaisir » ; l'utilisateur ne manipule pas les écritures inverses à la main |
| Le journal croît sans jamais décroître | Volume négligeable : un groupe de 50 membres génère ~1 200 écritures par an |
| Recalculer un solde coûte plus cher qu'une lecture | Index adaptés et vue matérialisée si nécessaire (N-PRF-02) |

### Règles d'implémentation

1. L'équilibre est vérifié par **déclencheur SQL**, pas seulement par
   l'application (N-INT-02). Une écriture déséquilibrée est rejetée par la base.
2. `UPDATE` et `DELETE` sont **révoqués** sur les tables du journal pour le rôle
   applicatif (R-02). Le refus ne dépend pas de la discipline du code.
3. Une écriture inverse porte `ecriture_corrigee_id` (N-TRC-02).
4. Toute écriture porte auteur et horodatage (N-TRC-01).
5. Les montants sont des `BIGINT` en plus petite unité (N-INT-03).

## Alternatives écartées

**Table de mouvements simple.** Écartée : rien n'empêche un solde de diverger, et
F-ANO-04 perdrait son fondement. Acceptable pour un prototype, pas pour un
produit manipulant l'argent de tiers.

**Mouvements + journal d'audit.** Écartée : l'audit dit *qui a changé quoi*,
mais ne garantit pas que les comptes soient justes. Il documente la dérive au
lieu de l'empêcher — et il suppose que l'on pense à consulter le journal.

**Comptabilité en partie double avec écritures modifiables.** Écartée :
l'équilibre serait garanti, mais l'historique resterait réinscriptible, ce qui
ruine la valeur probante recherchée.

## Références

- Exigences F-TRX, F-ANO-04, N-INT, R-01, R-02 — [`../cahier-des-charges.md`](../cahier-des-charges.md)
- Schéma du journal — [`../modele-de-donnees.md`](../modele-de-donnees.md)
- Décision liée — [`0002-socle-commun-tables-specialisees.md`](0002-socle-commun-tables-specialisees.md)
