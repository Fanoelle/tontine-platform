# Cahier des charges — Plateforme de gestion des tontines et associations

> **Version** 1.0 — 11 septembre 2026
> **Statut** Socle validé, en cours de réalisation
> **Périmètre de ce document** Jalon 1 (socle) et cadrage des jalons ultérieurs

---

## 1. Présentation

### 1.1 Contexte

Les tontines, associations et mutuelles communautaires reposent sur un mécanisme
de confiance collective : des membres versent régulièrement de l'argent dans une
caisse commune, gérée par un trésorier, selon des règles convenues entre eux.

La gestion est aujourd'hui presque toujours manuelle : cahier papier, tableau
Excel, ou mémoire du trésorier. Trois conséquences se retrouvent partout :

- **L'opacité.** Les membres ne connaissent pas l'état réel de la caisse. Ils
  découvrent un écart lors de l'assemblée, souvent trop tard.
- **L'erreur non détectée.** Une cotisation oubliée, un remboursement mal
  imputé, une double saisie : rien ne signale l'anomalie avant l'arrêté des
  comptes, quand la reconstitution est devenue coûteuse.
- **La dépendance au trésorier.** Si le cahier se perd ou si le trésorier
  s'absente, l'historique disparaît avec lui.

La conséquence sociale dépasse la comptabilité : un litige non résolu dissout le
groupe. La plateforme vise donc moins la performance de gestion que **la
restitution d'une confiance vérifiable**.

### 1.2 Objectif

Fournir aux groupes un registre **transparent, vérifiable et partagé** de leurs
mouvements financiers, qui détecte automatiquement les incohérences avant
qu'elles ne deviennent des conflits.

### 1.3 Ce que la plateforme n'est pas

Cadrage explicite, pour écarter toute ambiguïté sur le périmètre :

| Hors périmètre | Raison |
|---|---|
| **Établissement de paiement** | L'argent ne transite jamais par la plateforme. Elle enregistre des mouvements réalisés ailleurs (espèces, Mobile Money). Aucun agrément financier n'est requis. |
| **Portefeuille électronique** | Aucun solde n'est détenu ni mobilisable. Les soldes affichés sont comptables, pas des avoirs. |
| **Substitut aux règles du groupe** | La plateforme applique les règles que le groupe s'est données ; elle ne les édicte pas. |
| **Autorité d'arbitrage** | Elle signale une anomalie, elle ne tranche pas un litige. La décision reste humaine. |

---

## 2. Acteurs

| Acteur | Description | Responsabilité principale |
|---|---|---|
| **Membre** | Personne physique appartenant à un groupe | Cotise, consulte sa situation, conteste une écriture |
| **Trésorier** | Membre chargé des finances | Saisit les mouvements, produit les arrêtés |
| **Président** | Membre dirigeant le groupe | Valide les décisions (prêts, aides), arbitre |
| **Commissaire aux comptes** | Membre chargé du contrôle | Vérifie les comptes, lève ou confirme les anomalies |
| **Administrateur plateforme** | Exploitant technique | Maintient le service, n'accède pas aux données des groupes |

> **Cumul des rôles.** Dans les petits groupes, une même personne est souvent
> présidente et trésorière. Le modèle l'autorise (voir MCD, relation
> `membre_role`), mais l'interface avertit lorsqu'un cumul affaiblit le contrôle
> — notamment trésorier et commissaire aux comptes, dont la séparation est la
> garantie du contrôle mutuel.

---

## 3. Typologie des groupes

Trois mécanismes sont couverts. Leurs règles d'argent sont **incompatibles entre
elles**, ce qui justifie un socle commun et des tables spécialisées plutôt qu'une
abstraction unique (voir [`decisions/0002-socle-commun-tables-specialisees.md`](decisions/0002-socle-commun-tables-specialisees.md)).

### 3.1 Tontine rotative — ROSCA

Chaque membre verse un montant fixe à chaque échéance. À chaque tour, **un seul
membre reçoit la totalité de la cagnotte**. Le cycle s'achève quand tous les
membres ont bénéficié d'un tour.

- La caisse est **vidée à chaque échéance** : son solde théorique retombe à zéro.
- L'ordre de passage est déterminé à l'avance (tirage au sort, ancienneté,
  enchère selon les groupes).
- **Invariant** : somme des cotisations d'un tour = montant remis au bénéficiaire.

### 3.2 Caisse d'épargne cumulative — ASCA

Les cotisations **s'accumulent**. Chaque membre détient un solde d'épargne
individuel. La caisse consent des prêts, avec ou sans intérêt. En fin de cycle,
le capital et les intérêts sont redistribués au prorata des parts.

- La caisse **croît** dans le temps.
- **Invariant** : avoir de la caisse = somme des épargnes individuelles + intérêts non distribués.

### 3.3 Association / mutuelle

Cotisations régulières alimentant un fonds **collectif et non individualisé**,
mobilisé lors d'événements (décès, mariage, maladie, scolarité).

- Aucun droit individuel sur le fonds : cotiser n'ouvre pas de créance.
- **Invariant** : fonds = cotisations encaissées − aides versées − frais.

---

## 4. Exigences fonctionnelles

Chaque exigence porte un code stable, référencé dans le code source et les tests.
`[J1]` marque le périmètre du premier jalon.

### 4.1 Groupes — `F-GRP`

| Code | Exigence | Jalon |
|---|---|---|
| F-GRP-01 | Créer un groupe en choisissant son mécanisme (ROSCA, ASCA, mutuelle) | J1 |
| F-GRP-02 | Définir les règles : montant, périodicité, devise, date de début | J1 |
| F-GRP-03 | Consulter la fiche et les règles en vigueur | J1 |
| F-GRP-04 | Modifier les règles, avec conservation de l'historique et date d'effet | J2 |
| F-GRP-05 | Ouvrir et clôturer un cycle | J2 |
| F-GRP-06 | Archiver un groupe sans perte d'historique | J3 |

> **F-GRP-04 — point de vigilance.** Changer le montant d'une cotisation ne doit
> jamais réécrire le passé : les échéances déjà appelées restent au montant
> d'alors. D'où une règle **datée**, jamais modifiée en place.

### 4.2 Membres et rôles — `F-MBR`

| Code | Exigence | Jalon |
|---|---|---|
| F-MBR-01 | Ajouter un membre (nom, téléphone, date d'adhésion) | J1 |
| F-MBR-02 | Attribuer un ou plusieurs rôles | J1 |
| F-MBR-03 | Lister les membres et leur situation | J1 |
| F-MBR-04 | Suspendre ou radier un membre sans effacer son historique | J2 |
| F-MBR-05 | Consulter la fiche individuelle et son relevé | J1 |
| F-MBR-06 | Avertir en cas de cumul de rôles affaiblissant le contrôle | J2 |

> **Le téléphone est l'identifiant naturel.** Beaucoup de membres n'ont pas
> d'adresse e-mail ; le numéro est stable, connu de tous et sert de canal de
> notification. Il est unique par groupe, au format international normalisé.

### 4.3 Cotisations — `F-COT`

| Code | Exigence | Jalon |
|---|---|---|
| F-COT-01 | Générer les échéances attendues selon la périodicité | J1 |
| F-COT-02 | Enregistrer un versement (montant, date, moyen) | J1 |
| F-COT-03 | Gérer les versements partiels et le reliquat | J1 |
| F-COT-04 | Identifier les échéances impayées | J1 |
| F-COT-05 | Corriger une saisie erronée par écriture inverse, sans suppression | J1 |
| F-COT-06 | Envoyer des rappels avant et après échéance | J2 |
| F-COT-07 | Enregistrer une dispense accordée par le groupe | J2 |

> **F-COT-05 est structurante.** Une écriture n'est jamais modifiée ni
> supprimée : on l'annule par une écriture inverse. C'est la condition pour que
> les comptes restent vérifiables (voir
> [`decisions/0003-journal-partie-double.md`](decisions/0003-journal-partie-double.md)).

### 4.4 Tour de rôle ROSCA — `F-TOU`

| Code | Exigence | Jalon |
|---|---|---|
| F-TOU-01 | Définir l'ordre de passage des bénéficiaires | J1 |
| F-TOU-02 | Consulter le tour courant et le prochain bénéficiaire | J1 |
| F-TOU-03 | Enregistrer la remise de la cagnotte au bénéficiaire | J1 |
| F-TOU-04 | Permuter deux bénéficiaires, avec motif tracé | J2 |
| F-TOU-05 | Vérifier que chaque membre ne bénéficie qu'une fois par cycle | J1 |

### 4.5 Épargne ASCA — `F-EPA`

| Code | Exigence | Jalon |
|---|---|---|
| F-EPA-01 | Tenir le solde d'épargne de chaque membre | J2 |
| F-EPA-02 | Calculer les parts détenues | J2 |
| F-EPA-03 | Répartir les intérêts au prorata | J3 |
| F-EPA-04 | Produire le décompte de redistribution en fin de cycle | J3 |

### 4.6 Prêts — `F-PRE`

| Code | Exigence | Jalon |
|---|---|---|
| F-PRE-01 | Enregistrer une demande de prêt | J2 |
| F-PRE-02 | Approuver ou refuser, avec traçabilité du décideur | J2 |
| F-PRE-03 | Produire l'échéancier de remboursement | J2 |
| F-PRE-04 | Enregistrer les remboursements et le capital restant dû | J2 |
| F-PRE-05 | Calculer les intérêts selon la règle du groupe | J2 |
| F-PRE-06 | Signaler les échéances en retard | J2 |
| F-PRE-07 | Rééchelonner un prêt, avec motif | J3 |

### 4.7 Aides mutualistes — `F-AID`

| Code | Exigence | Jalon |
|---|---|---|
| F-AID-01 | Enregistrer une demande d'aide et son motif | J2 |
| F-AID-02 | Approuver et verser une aide | J2 |
| F-AID-03 | Vérifier l'éligibilité (ancienneté, cotisations à jour) | J3 |

### 4.8 Transactions et comptabilité — `F-TRX`

| Code | Exigence | Jalon |
|---|---|---|
| F-TRX-01 | Journaliser tout mouvement en partie double | J1 |
| F-TRX-02 | Interdire toute modification ou suppression d'écriture | J1 |
| F-TRX-03 | Consulter le journal, filtré et daté | J1 |
| F-TRX-04 | Produire le solde de chaque compte à une date donnée | J1 |
| F-TRX-05 | Garantir l'équilibre débit/crédit de chaque écriture | J1 |
| F-TRX-06 | Rapprocher un relevé Mobile Money | J3 |

### 4.9 Détection d'anomalies — `F-ANO`

C'est l'apport différenciant de la plateforme.

| Code | Exigence | Jalon |
|---|---|---|
| F-ANO-01 | Détecter une cotisation attendue non versée | J2 |
| F-ANO-02 | Détecter un remboursement en retard | J2 |
| F-ANO-03 | Détecter un montant inhabituel au regard de l'historique | J2 |
| F-ANO-04 | Détecter une incohérence de solde (déséquilibre comptable) | J2 |
| F-ANO-05 | Détecter une double saisie probable | J2 |
| F-ANO-06 | Détecter une saisie tardive ou antidatée | J3 |
| F-ANO-07 | Classer chaque anomalie par gravité | J2 |
| F-ANO-08 | Permettre de justifier une anomalie (levée motivée) | J2 |
| F-ANO-09 | Notifier le commissaire aux comptes des anomalies graves | J3 |

> **Une anomalie est un signalement, jamais une accusation.** Le vocabulaire de
> l'interface l'impose : « à vérifier », jamais « fraude ». Une anomalie levée
> reste consignée avec son motif — la levée fait partie de la piste d'audit.

### 4.10 Rapports — `F-RAP`

| Code | Exigence | Jalon |
|---|---|---|
| F-RAP-01 | Relevé individuel par membre | J1 |
| F-RAP-02 | Situation de caisse à une date | J1 |
| F-RAP-03 | État des cotisations du cycle | J2 |
| F-RAP-04 | État des prêts en cours | J2 |
| F-RAP-05 | Rapport d'assemblée générale | J3 |
| F-RAP-06 | Export PDF et tableur | J3 |

### 4.11 Notifications — `F-NOT`

| Code | Exigence | Jalon |
|---|---|---|
| F-NOT-01 | Rappel avant échéance | J2 |
| F-NOT-02 | Accusé de réception d'un versement | J2 |
| F-NOT-03 | Alerte d'anomalie au trésorier et au commissaire | J2 |
| F-NOT-04 | Canal e-mail | J2 |
| F-NOT-05 | Canal WhatsApp | J3 |
| F-NOT-06 | Respect d'une plage horaire décente | J2 |

### 4.12 Tableau de bord — `F-TDB`

| Code | Exigence | Jalon |
|---|---|---|
| F-TDB-01 | Solde de caisse et évolution | J1 |
| F-TDB-02 | Taux de recouvrement des cotisations | J2 |
| F-TDB-03 | Encours de prêts et taux de retard | J2 |
| F-TDB-04 | Anomalies ouvertes par gravité | J2 |
| F-TDB-05 | Prochaine échéance et prochain bénéficiaire | J1 |

---

## 5. Exigences non fonctionnelles

### 5.1 Intégrité des données — `N-INT`

| Code | Exigence |
|---|---|
| N-INT-01 | Aucune écriture comptable n'est modifiable ni supprimable |
| N-INT-02 | Tout déséquilibre débit/crédit est rejeté par la base, pas seulement par l'application |
| N-INT-03 | Les montants sont des entiers, en plus petite unité monétaire |
| N-INT-04 | Toute opération multi-écritures est atomique |
| N-INT-05 | Les invariants métier sont exprimés en contraintes SQL quand c'est possible |

> **N-INT-03.** Les montants sont stockés en `BIGINT`. Le franc CFA n'a pas de
> sous-unité en pratique ; et un flottant ne doit jamais porter de l'argent —
> `0.1 + 0.2 ≠ 0.3` en binaire, et une caisse ne tolère pas l'à-peu-près.

### 5.2 Sécurité — `N-SEC`

| Code | Exigence |
|---|---|
| N-SEC-01 | Authentification par jeton, mots de passe hachés (bcrypt) |
| N-SEC-02 | Cloisonnement strict : aucun accès aux données d'un autre groupe |
| N-SEC-03 | Le groupe est déduit du jeton, jamais d'un paramètre d'URL |
| N-SEC-04 | Routes protégées par défaut, ouverture explicite |
| N-SEC-05 | Habilitations vérifiées côté serveur, à chaque appel |
| N-SEC-06 | Journal d'audit des accès aux données financières |
| N-SEC-07 | Transport chiffré obligatoire en production |

> **N-SEC-03** reprend une garantie éprouvée : si le groupe vient du jeton, une
> fuite transversale devient structurellement impossible, et non simplement
> « évitée si l'on pense à filtrer ».

### 5.3 Disponibilité et usage — `N-USG`

| Code | Exigence |
|---|---|
| N-USG-01 | Interface utilisable sur téléphone (écrans ≥ 360 px) |
| N-USG-02 | Consultation fonctionnelle sur connexion lente (< 100 ko par écran utile) |
| N-USG-03 | Interface en français |
| N-USG-04 | Saisie d'un versement en moins de 30 secondes |
| N-USG-05 | Lecture compréhensible sans formation comptable |

> **N-USG-05.** Le journal en partie double est un mécanisme interne. Un membre
> lit « vous avez versé 5 000 F le 3 mars », pas un débit et un crédit.

### 5.4 Performance — `N-PRF`

| Code | Exigence |
|---|---|
| N-PRF-01 | Réponse API < 300 ms au 95ᵉ centile pour un groupe de 50 membres |
| N-PRF-02 | Solde calculé en < 100 ms sur 10 000 écritures |
| N-PRF-03 | Détection d'anomalies en tâche de fond, sans bloquer la saisie |

### 5.5 Traçabilité — `N-TRC`

| Code | Exigence |
|---|---|
| N-TRC-01 | Toute écriture porte son auteur et son horodatage |
| N-TRC-02 | Toute correction référence l'écriture corrigée |
| N-TRC-03 | Toute décision (prêt, aide, levée d'anomalie) porte son décideur et son motif |

---

## 6. Règles de gestion

Règles transverses, vérifiées par le schéma lorsque c'est possible.

| Code | Règle | Application |
|---|---|---|
| R-01 | Toute écriture comptable est équilibrée : Σ débits = Σ crédits | Contrainte + déclencheur SQL |
| R-02 | Une écriture validée n'est ni modifiable ni supprimable | Privilèges + déclencheur SQL |
| R-03 | Un montant est strictement positif | Contrainte `CHECK` |
| R-04 | Un membre ne bénéficie qu'une fois par cycle ROSCA | Index unique |
| R-05 | La somme des cotisations d'un tour égale la cagnotte remise | Contrôle applicatif + anomalie F-ANO-04 |
| R-06 | Un prêt n'excède pas l'avoir disponible de la caisse | Contrôle applicatif à l'approbation |
| R-07 | Le capital restant dû décroît jusqu'à zéro, jamais en deçà | Contrainte `CHECK` |
| R-08 | Un membre radié conserve son historique | Suppression logique |
| R-09 | Une règle de groupe modifiée ne s'applique qu'aux échéances futures | Règle datée |
| R-10 | Un téléphone est unique au sein d'un groupe | Index unique partiel |

---

## 7. Jalons

### Jalon 1 — Socle (en cours)

**Objectif** : un groupe tient réellement ses comptes.

Groupes, membres, rôles, cotisations, tour de rôle ROSCA, journal en partie
double, relevés individuels, situation de caisse, tableau de bord minimal.

**Critère d'acceptation** : une tontine rotative de 12 membres mène un cycle
complet, la caisse reste équilibrée à chaque tour, et tout écart est traçable.

### Jalon 2 — Prêts, anomalies, notifications

Prêts et remboursements, épargne ASCA, aides mutualistes, moteur d'anomalies,
rappels e-mail, tableau de bord complet.

**Critère d'acceptation** : une cotisation manquante, un remboursement en retard
et un déséquilibre de solde sont détectés automatiquement et notifiés.

### Jalon 3 — Ouverture et confort

Rapprochement Mobile Money, WhatsApp, exports PDF et tableur, rapport
d'assemblée, archivage, redistribution de fin de cycle.

---

## 8. Contraintes techniques

| Élément | Choix | Justification |
|---|---|---|
| Base de données | PostgreSQL 16 (Docker) | Contraintes, déclencheurs et transactions au service des invariants financiers |
| API | NestJS 10 + TypeScript, `pg` brut | Le schéma porte la logique métier ; un ORM la masquerait |
| Interface | Web responsive | Un seul livrable, utilisable sur téléphone |
| Langue | Français (code, schéma, interface, documentation) | Vocabulaire métier nativement français |
| Identifiants | UUID | Pas de fuite d'information par incrément, fusion de données facilitée |
| Montants | `BIGINT`, plus petite unité | Aucun flottant sur de l'argent |

> **Indépendance.** Ce projet ne partage ni code, ni base, ni dépendance avec
> les autres projets de la machine. Seules les conventions d'écriture sont
> reprises, par habitude de travail.

---

## 9. Documents liés

| Document | Objet |
|---|---|
| [`modele-de-donnees.md`](modele-de-donnees.md) | MCD, dictionnaire, invariants |
| [`diagrammes/`](diagrammes/) | Cas d'utilisation, classes, séquences, états |
| [`decisions/`](decisions/) | Décisions d'architecture argumentées |
| [`detection-anomalies.md`](detection-anomalies.md) | Règles de détection et seuils |

---

## 10. Glossaire

| Terme | Définition |
|---|---|
| **Tontine** | Association de personnes mettant en commun une épargne selon des règles convenues |
| **ROSCA** | *Rotating Savings and Credit Association* — tontine à tour de rôle |
| **ASCA** | *Accumulating Savings and Credit Association* — caisse d'épargne cumulative |
| **Cagnotte** | Somme collectée lors d'un tour, remise en totalité au bénéficiaire |
| **Tour** | Échéance d'un cycle ROSCA, au profit d'un bénéficiaire |
| **Cycle** | Période au terme de laquelle tous les membres ont bénéficié d'un tour |
| **Partie double** | Méthode comptable où toute somme est portée au débit d'un compte et au crédit d'un autre |
| **Écriture** | Opération comptable équilibrée, composée d'au moins deux lignes |
| **Reliquat** | Part d'une échéance restant due après un versement partiel |
| **Anomalie** | Incohérence détectée automatiquement, à vérifier par un humain |
