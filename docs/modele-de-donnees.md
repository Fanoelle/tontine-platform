# Modèle de données

> **Version** 1.0 — 11 septembre 2026
> **Documents liés** : [cahier des charges](cahier-des-charges.md) · [décision 0002](decisions/0002-socle-commun-tables-specialisees.md) · [décision 0003](decisions/0003-journal-partie-double.md)

Ce document décrit le schéma PostgreSQL : les entités, leurs relations, le
dictionnaire des données et surtout **les invariants tenus par la base**.

Il ne décrit pas l'API ni l'interface. Le journal en partie double est un
mécanisme interne : l'utilisateur ne voit jamais un débit ni un crédit (N-USG-05).

---

## 1. Vue d'ensemble

```
                           ┌─────────────┐
                           │   groupe    │  type: ROSCA | ASCA | MUTUELLE
                           └──────┬──────┘
                                  │
     ┌──────────────┬─────────────┼─────────────┬──────────────┐
     │              │             │             │              │
┌────┴─────┐  ┌─────┴─────┐  ┌────┴────┐  ┌─────┴─────┐  ┌─────┴──────┐
│  membre  │  │ regle_    │  │  cycle  │  │  compte   │  │  ecriture  │
│          │  │ groupe    │  │         │  │           │  │            │
└────┬─────┘  └───────────┘  └────┬────┘  └─────┬─────┘  └─────┬──────┘
     │                            │             │              │
     │  ┌──────────────┐          │             │        ┌─────┴──────────┐
     ├──┤ membre_role  ├── role   │             └────────┤ ligne_ecriture │
     │  └──────────────┘          │                      └────────────────┘
     │                            │                        Σ débits = Σ crédits
     │                       ┌────┴─────┐
     │                       │ echeance │
     │                       └────┬─────┘
     │                            │
     │                     ┌──────┴──────┐
     └─────────────────────┤ cotisation  │
                           └─────────────┘

   ── SPÉCIALISATIONS ────────────────────────────────────────────
   ROSCA      tour (rang, beneficiaire_id, cagnotte_remise)
   ASCA       epargne_membre (solde, parts) · pret · echeance_pret
   MUTUELLE   aide (motif, montant, decideur_id)

   ── TRANSVERSE ─────────────────────────────────────────────────
   anomalie (type, gravite, statut, ecriture_id?, membre_id?)
   utilisateur · journal_acces
```

**Lecture.** Le socle commun (haut) vaut pour les trois mécanismes. Les
spécialisations (bas) n'existent que pour le type de groupe correspondant, ce
qu'une contrainte de cohérence garantit. Le journal — `compte`, `ecriture`,
`ligne_ecriture` — est commun aux trois : c'est lui qui porte l'argent, tous
mécanismes confondus.

---

## 2. Types énumérés

| Type | Valeurs | Usage |
|---|---|---|
| `type_groupe` | `ROSCA`, `ASCA`, `MUTUELLE` | Mécanisme du groupe (F-GRP-01) |
| `periodicite` | `HEBDOMADAIRE`, `QUINZAINE`, `MENSUELLE`, `TRIMESTRIELLE` | Rythme des échéances (F-GRP-02) |
| `role_membre` | `MEMBRE`, `TRESORIER`, `PRESIDENT`, `COMMISSAIRE` | Habilitations (F-MBR-02) |
| `statut_membre` | `ACTIF`, `SUSPENDU`, `RADIE` | Cycle de vie (F-MBR-04) |
| `statut_cycle` | `PREPARATION`, `EN_COURS`, `CLOTURE` | Cycle de vie (F-GRP-05) |
| `statut_echeance` | `ATTENDUE`, `PARTIELLE`, `REGLEE`, `IMPAYEE`, `DISPENSEE` | Suivi (F-COT-04) |
| `moyen_paiement` | `ESPECES`, `MOBILE_MONEY`, `VIREMENT`, `COMPENSATION` | Traçabilité (F-COT-02) |
| `sens_ecriture` | `DEBIT`, `CREDIT` | Partie double (F-TRX-01) |
| `nature_compte` | `CAISSE`, `BANQUE`, `EPARGNE_MEMBRE`, `CREANCE_PRET`, `PRODUIT_INTERET`, `FONDS_AIDE`, `COTISATION_MEMBRE` | Plan de comptes |
| `statut_pret` | `DEMANDE`, `APPROUVE`, `REFUSE`, `EN_REMBOURSEMENT`, `SOLDE`, `EN_RETARD`, `REECHELONNE` | Cycle de vie (F-PRE) |
| `type_anomalie` | `COTISATION_MANQUANTE`, `REMBOURSEMENT_RETARD`, `MONTANT_INHABITUEL`, `SOLDE_INCOHERENT`, `DOUBLE_SAISIE`, `SAISIE_TARDIVE` | F-ANO-01 à 06 |
| `gravite_anomalie` | `INFORMATION`, `AVERTISSEMENT`, `CRITIQUE` | F-ANO-07 |
| `statut_anomalie` | `DETECTEE`, `EN_VERIFICATION`, `CONFIRMEE`, `LEVEE` | F-ANO-08 |

> **Pourquoi `COMPENSATION`.** Une cotisation est parfois réglée en retenant la
> somme sur une cagnotte à recevoir — aucun argent ne change de main. L'écriture
> existe pourtant, sans mouvement de caisse. L'omettre forcerait le trésorier à
> inventer un versement fictif.

---

## 3. Socle commun

### 3.1 `groupe`

L'entité racine. Tout est cloisonné par elle (N-SEC-02).

| Colonne | Type | Contrainte | Description |
|---|---|---|---|
| `id` | `UUID` | PK | |
| `nom` | `TEXT` | `NOT NULL` | |
| `type` | `type_groupe` | `NOT NULL` | Détermine les spécialisations applicables |
| `devise` | `CHAR(3)` | `NOT NULL DEFAULT 'XAF'` | Code ISO 4217 |
| `date_creation` | `DATE` | `NOT NULL` | |
| `statut` | `TEXT` | `NOT NULL DEFAULT 'ACTIF'` | |
| `cree_le` / `modifie_le` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | |

> **Le type est immuable après création.** Un groupe ROSCA ne devient pas une
> mutuelle : les règles d'argent diffèrent et les écritures passées deviendraient
> ininterprétables. Un déclencheur refuse le changement.

### 3.2 `regle_groupe`

Les règles sont **datées**, jamais modifiées en place (F-GRP-04, R-09).

| Colonne | Type | Contrainte | Description |
|---|---|---|---|
| `id` | `UUID` | PK | |
| `groupe_id` | `UUID` | FK, `NOT NULL` | |
| `montant_cotisation` | `BIGINT` | `CHECK > 0` | Par échéance |
| `periodicite` | `periodicite` | `NOT NULL` | |
| `taux_interet_pret` | `NUMERIC(5,4)` | `CHECK >= 0` | Par période, `NULL` si sans intérêt |
| `penalite_retard` | `BIGINT` | `CHECK >= 0` | Forfait |
| `date_effet` | `DATE` | `NOT NULL` | |
| `date_fin_effet` | `DATE` | `CHECK > date_effet` | `NULL` = en vigueur |

**Invariant.** Les périodes d'effet d'un même groupe ne se chevauchent pas —
contrainte d'exclusion sur `(groupe_id, daterange(date_effet, date_fin_effet))`.

> **Pourquoi dater plutôt que modifier.** Si le groupe passe la cotisation de
> 5 000 à 7 000 F en mars, les échéances de janvier restent dues à 5 000 F.
> Modifier la règle en place réécrirait le passé et rendrait tout arriéré faux.
> C'est le même raisonnement que l'immuabilité du journal, appliqué aux règles.

### 3.3 `membre`

| Colonne | Type | Contrainte | Description |
|---|---|---|---|
| `id` | `UUID` | PK | |
| `groupe_id` | `UUID` | FK, `NOT NULL` | |
| `nom_complet` | `TEXT` | `NOT NULL` | |
| `telephone` | `TEXT` | `NOT NULL`, format `^\+[1-9]\d{7,14}$` | Identifiant naturel |
| `email` | `TEXT` | | Optionnel (F-NOT-04) |
| `date_adhesion` | `DATE` | `NOT NULL` | |
| `statut` | `statut_membre` | `NOT NULL DEFAULT 'ACTIF'` | |
| `supprime` | `BOOLEAN` | `NOT NULL DEFAULT false` | Suppression logique (R-08) |

**Invariant R-10.** Index unique partiel sur `(groupe_id, telephone) WHERE NOT supprime`.

> **Le téléphone, pas l'e-mail.** Beaucoup de membres n'ont pas d'adresse
> électronique ; le numéro est stable, connu du groupe, et sert de canal de
> rappel. Il est normalisé au format international avant stockage, faute de quoi
> `+237690...`, `690...` et `00237 690...` créeraient trois membres distincts.

### 3.4 `role` et `membre_role`

Une personne peut cumuler plusieurs rôles (F-MBR-02), d'où une table
d'association plutôt qu'une colonne.

`membre_role` : `membre_id`, `role`, `attribue_le`, `attribue_par`, `retire_le`.

**Invariant.** Unique sur `(membre_id, role) WHERE retire_le IS NULL`.

> **Le retrait est daté, pas supprimé.** Savoir qui était trésorier en mars est
> nécessaire pour interpréter les écritures de mars (N-TRC-01).

### 3.5 `cycle`

| Colonne | Type | Contrainte |
|---|---|---|
| `id` | `UUID` | PK |
| `groupe_id` | `UUID` | FK, `NOT NULL` |
| `numero` | `INTEGER` | `CHECK > 0`, unique par groupe |
| `date_debut` | `DATE` | `NOT NULL` |
| `date_fin_prevue` | `DATE` | `CHECK > date_debut` |
| `date_cloture` | `DATE` | `NULL` tant qu'ouvert |
| `statut` | `statut_cycle` | `NOT NULL DEFAULT 'PREPARATION'` |

**Invariant.** Un seul cycle `EN_COURS` par groupe — index unique partiel.

### 3.6 `echeance`

Les échéances **attendues**, générées à l'ouverture du cycle (F-COT-01).

| Colonne | Type | Contrainte | Description |
|---|---|---|---|
| `id` | `UUID` | PK | |
| `cycle_id` | `UUID` | FK, `NOT NULL` | |
| `membre_id` | `UUID` | FK, `NOT NULL` | |
| `tour_id` | `UUID` | FK | ROSCA uniquement |
| `date_echeance` | `DATE` | `NOT NULL` | |
| `montant_attendu` | `BIGINT` | `CHECK > 0` | Figé à la génération (R-09) |
| `montant_regle` | `BIGINT` | `NOT NULL DEFAULT 0`, `CHECK >= 0` | Somme des cotisations |
| `statut` | `statut_echeance` | `NOT NULL DEFAULT 'ATTENDUE'` | |

**Invariants.** Unique sur `(cycle_id, membre_id, date_echeance)`.
`montant_regle` est recalculé par déclencheur depuis `cotisation` — jamais écrit
par l'application. Le `statut` en découle : `REGLEE` si `montant_regle >=
montant_attendu`, `PARTIELLE` si `> 0`, `IMPAYEE` si nul et date dépassée.

> **Pourquoi figer `montant_attendu`.** Il recopie la règle en vigueur au moment
> de la génération. Sans cela, changer la règle modifierait rétroactivement les
> arriérés de tous les membres.

> **Pourquoi `montant_regle` est dénormalisé.** C'est une redondance assumée :
> la lecture est constante alors que le recalcul serait une agrégation à chaque
> affichage (N-PRF-02). Elle n'est sûre que parce qu'un déclencheur en est le
> seul auteur. Un écart entre ce champ et la somme réelle est précisément ce que
> détecte F-ANO-04.

### 3.7 `cotisation`

Les versements **réellement effectués** (F-COT-02).

| Colonne | Type | Contrainte |
|---|---|---|
| `id` | `UUID` | PK |
| `echeance_id` | `UUID` | FK, `NOT NULL` |
| `montant` | `BIGINT` | `CHECK > 0` (R-03) |
| `date_versement` | `DATE` | `NOT NULL` |
| `moyen` | `moyen_paiement` | `NOT NULL` |
| `reference_externe` | `TEXT` | Référence Mobile Money (F-TRX-06) |
| `ecriture_id` | `UUID` | FK, `NOT NULL` |
| `saisi_par` | `UUID` | FK utilisateur, `NOT NULL` |

> **Échéance et cotisation sont distinctes.** L'échéance est ce qui *doit* être
> versé, la cotisation ce qui l'*a été*. Les confondre interdirait les versements
> partiels (F-COT-03) et surtout rendrait indétectable la cotisation manquante
> (F-ANO-01) : on ne peut constater l'absence que si l'attendu est matérialisé.

---

## 4. Journal comptable

Cœur du modèle. Voir [décision 0003](decisions/0003-journal-partie-double.md).

### 4.1 `compte`

Plan de comptes, propre à chaque groupe.

| Colonne | Type | Contrainte |
|---|---|---|
| `id` | `UUID` | PK |
| `groupe_id` | `UUID` | FK, `NOT NULL` |
| `nature` | `nature_compte` | `NOT NULL` |
| `libelle` | `TEXT` | `NOT NULL` |
| `membre_id` | `UUID` | FK, `NULL` si collectif |

**Invariant.** Les comptes de nature `EPARGNE_MEMBRE`, `COTISATION_MEMBRE` et
`CREANCE_PRET` exigent `membre_id NOT NULL` ; les autres l'interdisent.

### 4.2 `ecriture`

| Colonne | Type | Contrainte | Description |
|---|---|---|---|
| `id` | `UUID` | PK | |
| `groupe_id` | `UUID` | FK, `NOT NULL` | |
| `numero` | `BIGINT` | Séquentiel par groupe | Numérotation continue |
| `date_operation` | `DATE` | `NOT NULL` | Date réelle du mouvement |
| `libelle` | `TEXT` | `NOT NULL` | |
| `ecriture_corrigee_id` | `UUID` | FK auto-référente | Si écriture inverse (N-TRC-02) |
| `motif_correction` | `TEXT` | Obligatoire si correction | |
| `saisi_par` | `UUID` | FK, `NOT NULL` | N-TRC-01 |
| `cree_le` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` | |

**Pas de `modifie_le` : une écriture n'est jamais modifiée.**

### 4.3 `ligne_ecriture`

| Colonne | Type | Contrainte |
|---|---|---|
| `id` | `UUID` | PK |
| `ecriture_id` | `UUID` | FK, `NOT NULL` |
| `compte_id` | `UUID` | FK, `NOT NULL` |
| `sens` | `sens_ecriture` | `NOT NULL` |
| `montant` | `BIGINT` | `CHECK > 0` |

### 4.4 Invariants du journal

**R-01 — équilibre.** Pour toute écriture, Σ débits = Σ crédits, avec au moins
deux lignes. Vérifié par déclencheur `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY
DEFERRED` : le contrôle s'exécute en fin de transaction, une fois toutes les
lignes insérées. Un déclencheur immédiat rejetterait la première ligne, puisqu'une
écriture est nécessairement déséquilibrée tant qu'elle est incomplète.

**R-02 — immuabilité.** `UPDATE` et `DELETE` sont révoqués sur `ecriture` et
`ligne_ecriture` pour le rôle applicatif, doublés d'un déclencheur `BEFORE UPDATE
OR DELETE` qui lève une exception. Deux verrous : le privilège protège contre
l'erreur de code, le déclencheur contre une configuration de privilèges erronée.

**Correction.** Une écriture inverse reprend les mêmes comptes et montants, sens
inversés, et porte `ecriture_corrigee_id` + `motif_correction`. Une même écriture
ne peut être corrigée qu'une fois — index unique.

### 4.5 Soldes

```sql
CREATE VIEW v_solde_compte AS
SELECT c.id AS compte_id, c.groupe_id, c.nature, c.libelle, c.membre_id,
       COALESCE(SUM(CASE l.sens WHEN 'DEBIT'  THEN l.montant ELSE 0 END), 0)
     - COALESCE(SUM(CASE l.sens WHEN 'CREDIT' THEN l.montant ELSE 0 END), 0)
       AS solde
FROM compte c
LEFT JOIN ligne_ecriture l ON l.compte_id = c.id
GROUP BY c.id;
```

Le solde est **toujours recalculé**, jamais stocké. C'est ce qui rend la
divergence impossible — et donne à F-ANO-04 une référence sûre. Une fonction
`solde_a_date(p_compte_id, p_date)` filtre sur `date_operation` pour la situation
de caisse à une date passée (F-TRX-04).

---

## 5. Spécialisations

### 5.1 ROSCA — `tour`

| Colonne | Type | Contrainte |
|---|---|---|
| `id` | `UUID` | PK |
| `cycle_id` | `UUID` | FK, `NOT NULL` |
| `rang` | `INTEGER` | `CHECK > 0`, unique par cycle |
| `beneficiaire_id` | `UUID` | FK membre, `NOT NULL` |
| `date_remise_prevue` | `DATE` | `NOT NULL` |
| `date_remise_reelle` | `DATE` | `NULL` tant que non remis |
| `montant_cagnotte` | `BIGINT` | `CHECK > 0`, `NULL` avant remise |
| `ecriture_remise_id` | `UUID` | FK, `NULL` avant remise |

**Invariant R-04.** Unique sur `(cycle_id, beneficiaire_id)` — un membre ne
bénéficie qu'une fois par cycle (F-TOU-05).

**Cohérence de type.** Une contrainte vérifie que le groupe du cycle est de type
`ROSCA`.

**R-05.** À la remise, la cagnotte doit égaler la somme des cotisations du tour.
L'écart n'est pas rejeté — il peut être légitime (dispense accordée) — mais
déclenche une anomalie `SOLDE_INCOHERENT` à vérifier.

### 5.2 ASCA — `epargne_membre`, `pret`, `echeance_pret`

`epargne_membre` : `membre_id`, `cycle_id`, `parts`, `solde_calcule`
(dénormalisé depuis le journal), `interets_acquis`.

`pret` : `membre_id`, `montant_accorde`, `taux_interet`, `date_approbation`,
`approuve_par`, `statut`, `capital_restant_du`.

**Invariant R-07.** `CHECK (capital_restant_du >= 0 AND capital_restant_du <= montant_accorde)`.

`echeance_pret` : `pret_id`, `numero`, `date_echeance`, `montant_capital`,
`montant_interet`, `montant_regle`, `statut`.

> **Le prêt porte deux vérités.** `capital_restant_du` sert au suivi courant ;
> le journal en porte la version comptable, via le compte `CREANCE_PRET` du
> membre. Leur écart est exactement ce que surveille F-ANO-04.

### 5.3 MUTUELLE — `aide`

| Colonne | Type | Contrainte |
|---|---|---|
| `id` | `UUID` | PK |
| `groupe_id` | `UUID` | FK, `NOT NULL` |
| `beneficiaire_id` | `UUID` | FK membre, `NOT NULL` |
| `motif` | `TEXT` | `NOT NULL` |
| `montant_demande` | `BIGINT` | `CHECK > 0` |
| `montant_accorde` | `BIGINT` | `CHECK >= 0` |
| `decide_par` | `UUID` | FK, `NULL` tant qu'indécis |
| `date_decision` | `DATE` | |
| `ecriture_id` | `UUID` | FK, `NULL` avant versement |

> **Une aide n'est pas un prêt.** Elle n'ouvre aucune créance et n'est pas
> remboursable. D'où une table distincte : mêler les deux obligerait à une
> colonne « remboursable » dont dépendrait la moitié des règles.

---

## 6. Anomalies

### `anomalie`

| Colonne | Type | Contrainte |
|---|---|---|
| `id` | `UUID` | PK |
| `groupe_id` | `UUID` | FK, `NOT NULL` |
| `type` | `type_anomalie` | `NOT NULL` |
| `gravite` | `gravite_anomalie` | `NOT NULL` |
| `statut` | `statut_anomalie` | `NOT NULL DEFAULT 'DETECTEE'` |
| `detectee_le` | `TIMESTAMPTZ` | `NOT NULL DEFAULT now()` |
| `description` | `TEXT` | `NOT NULL` |
| `donnees` | `JSONB` | Valeurs constatée et attendue |
| `membre_id` / `echeance_id` / `ecriture_id` / `pret_id` | `UUID` | FK, nullables |
| `levee_par` | `UUID` | FK, `NULL` si non levée |
| `motif_levee` | `TEXT` | Obligatoire si `LEVEE` (F-ANO-08) |

**Invariant.** Index unique partiel empêchant de recréer une anomalie identique
déjà ouverte — sans quoi chaque passage du détecteur dupliquerait les mêmes
signalements.

> **`donnees` en JSONB, seule entorse au typage strict.** Chaque type d'anomalie
> a des attributs propres : un montant inhabituel porte la moyenne historique et
> l'écart-type, une cotisation manquante une date. Quinze colonnes nullables
> seraient pires. Ce champ est descriptif et n'entre dans aucun calcul financier.

---

## 7. Utilisateurs et accès

`utilisateur` : `id`, `membre_id`, `email`, `telephone`, `mot_de_passe_hash`
(bcrypt, N-SEC-01), `dernier_acces_le`, `actif`.

> **Membre et utilisateur sont distincts.** Tout membre n'a pas de compte — dans
> beaucoup de groupes, seul le bureau se connecte. Et un membre radié conserve
> son historique alors que son accès est révoqué (R-08).

`journal_acces` : `utilisateur_id`, `action`, `ressource`, `horodatage`,
`adresse_ip` (N-SEC-06).

---

## 8. Récapitulatif des invariants

| Règle | Mécanisme | Portée |
|---|---|---|
| R-01 équilibre des écritures | `CONSTRAINT TRIGGER` différé | Base |
| R-02 immuabilité du journal | Privilèges révoqués + déclencheur | Base |
| R-03 montants positifs | `CHECK` | Base |
| R-04 un bénéfice par cycle | Index unique | Base |
| R-05 cagnotte = cotisations | Contrôle applicatif → anomalie | Application |
| R-06 prêt ≤ avoir disponible | Contrôle à l'approbation | Application |
| R-07 capital restant borné | `CHECK` | Base |
| R-08 historique préservé | Suppression logique | Base |
| R-09 règles datées | Contrainte d'exclusion | Base |
| R-10 téléphone unique | Index unique partiel | Base |

**Huit des dix règles sont tenues par la base** (N-INT-05). Les deux restantes
dépendent d'un calcul contextuel : elles sont vérifiées par l'application et,
surtout, **surveillées en continu** par le moteur d'anomalies. Une règle non
garantie par le schéma doit être détectable a posteriori ; c'est le principe qui
relie le modèle de données à la détection d'anomalies.

---

## 9. Index prévus

| Index | Justification |
|---|---|
| `ligne_ecriture (compte_id)` | Calcul de solde (N-PRF-02) |
| `ecriture (groupe_id, date_operation)` | Journal filtré, situation à date |
| `echeance (cycle_id, statut)` | Impayés (F-COT-04) |
| `echeance (membre_id, date_echeance)` | Relevé individuel (F-RAP-01) |
| `anomalie (groupe_id, statut, gravite)` | Tableau de bord (F-TDB-04) |
| `membre (groupe_id) WHERE NOT supprime` | Liste des membres |
| `tour (cycle_id, rang)` | Tour courant et suivant (F-TOU-02) |

---

## 10. Ce que le modèle ne fait pas

- **Aucun solde n'est stocké comme source de vérité.** Les champs dénormalisés
  (`montant_regle`, `solde_calcule`) sont des caches maintenus par déclencheur ;
  le journal reste la référence.
- **Aucun flottant.** Tous les montants sont des `BIGINT` (N-INT-03). Seul
  `taux_interet` est un `NUMERIC`, et il n'est jamais stocké comme résultat.
- **Aucune suppression physique de donnée financière.**
- **Aucun identifiant de groupe transmis par l'URL** : il vient du jeton
  (N-SEC-03).
