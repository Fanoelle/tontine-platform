# Plateforme de gestion des tontines et associations

Registre transparent et vérifiable pour les tontines, associations, mutuelles et
caisses communautaires — avec **détection automatique des incohérences** avant
qu'elles ne deviennent des conflits.

> **Projet indépendant.** Il ne partage ni code, ni base, ni dépendance avec les
> autres projets de cette machine. Sa base tourne dans son propre conteneur, sur
> son propre port.

---

## Le problème

La gestion d'une tontine est presque toujours manuelle : cahier papier, tableau
Excel, ou mémoire du trésorier. Trois conséquences se retrouvent partout.

**L'opacité** — les membres ignorent l'état réel de la caisse et découvrent un
écart en assemblée, trop tard. **L'erreur non détectée** — une cotisation
oubliée ou un remboursement mal imputé ne se révèle qu'à l'arrêté des comptes,
quand la reconstitution coûte cher. **La dépendance au trésorier** — si le
cahier se perd, l'historique disparaît avec lui.

L'enjeu dépasse la comptabilité : un litige non résolu dissout le groupe. La
plateforme vise donc moins la performance de gestion que **la restitution d'une
confiance vérifiable**.

---

## Les trois mécanismes couverts

| | ROSCA | ASCA | Mutuelle |
|---|---|---|---|
| **Principe** | Chacun cotise, un membre reçoit toute la cagnotte à chaque tour | Les cotisations s'accumulent, la caisse prête avec intérêts | Fonds collectif mobilisé lors d'événements |
| **Caisse** | vidée à chaque tour | croît puis est redistribuée | croît et se dépense |
| **Droit du membre** | recevoir la cagnotte une fois par cycle | solde d'épargne individuel | aucun droit individuel |

Leurs règles d'argent étant incompatibles, le schéma repose sur un **socle
commun** (groupes, membres, cotisations, journal comptable) complété de **tables
spécialisées** par mécanisme — chaque règle restant ainsi vérifiable par
contrainte SQL plutôt que par convention de code.

---

## Deux décisions structurantes

### L'argent ne transite jamais par la plateforme

Elle **enregistre** des mouvements réalisés ailleurs — espèces, Mobile Money —
sans jamais les encaisser. Aucun agrément financier n'est requis, aucun avoir
n'est détenu. Les soldes affichés sont comptables, pas des portefeuilles.

### Le journal est immuable, en partie double

Toute somme est portée au débit d'un compte et au crédit d'un autre. **Rien
n'est jamais modifié ni supprimé** : une erreur se corrige par une écriture
inverse qui référence l'écriture d'origine.

```
Cotisation de 5 000 F du membre Awa, réglée en espèces

  Écriture #412  « Cotisation mars 2026 — Awa »
    ├─ DÉBIT   caisse_espèces          5 000
    └─ CRÉDIT  cotisations_membre_Awa  5 000
                                       ─────
                          équilibre :      0  ✓
```

Ce choix paraît lourd ; il est en réalité ce qui rend la détection d'anomalies
rigoureuse. Un solde n'est pas une valeur que l'on maintient — donc que l'on peut
désynchroniser — mais une valeur que l'on **recalcule**. Un écart cesse d'être
une intuition : c'est un déséquilibre arithmétique, localisable à l'écriture près.

L'utilisateur, lui, ne voit jamais un débit ni un crédit. Il lit « vous avez
versé 5 000 F le 3 mars ».

---

## Détection d'anomalies

L'apport différenciant. Six familles de signalements :

| Anomalie | Ce qui la déclenche |
|---|---|
| Cotisation manquante | Échéance attendue dépassée sans versement |
| Remboursement en retard | Échéance de prêt non honorée |
| Montant inhabituel | Versement s'écartant nettement de l'historique du membre |
| Solde incohérent | Divergence entre un solde suivi et le journal comptable |
| Double saisie | Deux versements similaires trop rapprochés |
| Saisie tardive | Écriture enregistrée longtemps après l'opération |

> **Une anomalie est un signalement, jamais une accusation.** L'interface dit
> « à vérifier », jamais « fraude ». Une anomalie levée reste consignée avec son
> motif : la levée fait partie de la piste d'audit.

---

## Architecture

```
┌─────────────────┐     HTTPS      ┌──────────────────┐
│  Web — 3 fichiers│ ─────────────► │   API (NestJS)   │
│  sans dépendance │ ◄───────────── │   TypeScript     │
└─────────────────┘   JSON, JWT    └────────┬─────────┘
                                            │ pg (SQL brut)
                                   ┌────────┴─────────┐
                                   │  PostgreSQL 16   │
                                   │  ─────────────   │
                                   │  contraintes,    │
                                   │  déclencheurs :  │
                                   │  les invariants  │
                                   │  financiers      │
                                   └──────────────────┘
```

**Pourquoi du SQL brut plutôt qu'un ORM.** Les invariants vivent dans le schéma :
équilibre des écritures garanti par déclencheur, unicité du bénéficiaire par
index unique, immuabilité par révocation de privilèges. Un ORM masquerait
précisément ce qui fait la sûreté du modèle.

---

## Arborescence

```
tontine-platform/
├── api/              API NestJS — 45 routes, 70 tests d'intégration
├── db/
│   ├── migrations/   15 fichiers, numérotés, idempotents
│   │   ├── 001–003   Socle, journal en partie double, cycle ROSCA
│   │   ├── 004       Utilisateurs et journal d'accès
│   │   ├── 005–007   Cotisations, tour de rôle, restitution
│   │   ├── 008–009   Épargne et prêts ASCA, aides mutualistes
│   │   ├── 010–011   Moteur d'anomalies, métier des prêts et aides
│   │   ├── 012–014   Fin de cycle, Mobile Money, rapports et exports
│   │   └── 015       Notifications : file, plage horaire, rappels
│   ├── seeds/        4 fichiers — un groupe par mécanisme, dates relatives
│   └── recette/      3 scénarios d'acceptation, un par jalon
├── web/              Interface — 3 fichiers, aucune dépendance
│   ├── index.html    Structure des écrans
│   ├── style.css     Téléphone d'abord, polices système
│   └── app.js        Session, appels API, rendu des 9 écrans
├── docs/
│   ├── cahier-des-charges.md     Exigences codées (F-COT-02, R-01…)
│   ├── modele-de-donnees.md      MCD, dictionnaire, invariants
│   ├── detection-anomalies.md    Règles et seuils
│   ├── diagrammes/               Cas d'utilisation, classes, séquences, états
│   └── decisions/                Décisions d'architecture argumentées
└── scripts/
    └── db.sh         Pilotage de la base de développement
```

---

## Mise en route

**Prérequis** : Docker, Node.js 20+.

```bash
./scripts/db.sh demarrer     # conteneur, migrations, jeux de données
./scripts/db.sh tester       # vérifie la connexion
./scripts/db.sh verifier     # éprouve les invariants : tente des violations
```

`verifier` ne se contente pas de lire le schéma : il **tente** une modification
d'écriture, un montant négatif, un téléphone dupliqué, un second tour pour le
même membre — et attend un refus de la base pour chacun. Un invariant jamais mis
à l'épreuve n'est pas un invariant, c'est une intention.

La base écoute sur le port **55433** :

```
postgresql://postgres:dev@localhost:55433/tontine
```

Autres commandes : `arreter`, `reinitialiser`, `console`, `supprimer`.

### API

```bash
cd api
cp .env.example .env          # puis remplacer JWT_SECRET
npm install
npm run verifier-types        # compilation TypeScript
npm run tester                # 70 tests d'intégration contre la vraie base
npm run dev                   # http://localhost:3100/api
```

L'API écoute sur le port **3100** — le 3000 est occupé par un autre projet de
la machine. Elle se connecte en tant que `tontine_app`, le rôle dont les
privilèges `UPDATE` et `DELETE` sont révoqués sur le journal, et **vérifie ce
point au démarrage** :

```
[BaseService] Connecté en tant que « tontine_app »
[BaseService] R-02 vérifié : journal non modifiable par ce rôle
```

Les tests exigent une base démarrée et les deux jeux de données chargés. Ils
vérifient que les gardes refusent réellement : route sans jeton, jeton
fantaisiste, schéma autre que `Bearer`, mot de passe erroné, téléphone inconnu,
téléphone mal formé, propriété non déclarée.

> **Les tests consomment le jeu de démonstration** : ils encaissent le tour 3
> puis remettent sa cagnotte. Relancez `./scripts/db.sh reinitialiser` avant
> chaque passage, sinon les échéances sont déjà réglées et le parcours échoue.

### Routes

Aucune ne porte d'identifiant de groupe : il vient du jeton (N-SEC-03).

| Route | Rôle requis | Exigence |
|---|---|---|
| `POST /api/authentification/connexion` | — *(publique)* | N-SEC-01 |
| `GET /api/authentification/session` | authentifié | N-SEC-03 |
| `GET /api/tableau-de-bord` | authentifié | F-TDB-01, F-TDB-05 |
| `GET /api/membres` | authentifié | F-MBR-03 |
| `GET /api/tours` | authentifié | F-TOU-02 |
| `POST /api/tours/:id/remise` | trésorier | F-TOU-03, R-05 |
| `GET /api/cotisations/impayes` | bureau | F-COT-04 |
| `POST /api/cotisations` | trésorier | F-COT-02, F-COT-03 |
| `POST /api/cotisations/:id/annulation` | trésorier | F-COT-05 |
| `POST /api/cotisations/echeances/:id/dispense` | président | F-COT-07 |
| `GET /api/cotisations/releve/:membre_id` | authentifié | F-RAP-01 |
| `GET /api/situation-caisse` | bureau | F-RAP-02, F-TRX-04 |
| `GET /api/recouvrement` | bureau | F-RAP-03 |
| `GET /api/journal` | commissaire, bureau | F-TRX-03 |
| `GET /api/prets` | authentifié | F-RAP-04 |
| `GET /api/prets/avoir-disponible` | bureau | R-06 |
| `GET /api/prets/:id/echeancier` | authentifié | F-PRE-03 |
| `POST /api/prets` | authentifié | F-PRE-01 |
| `POST /api/prets/:id/approbation` | président | F-PRE-02, R-06 |
| `POST /api/prets/:id/refus` | président | F-PRE-02 |
| `POST /api/prets/:id/remboursement` | trésorier | F-PRE-04, R-07 |
| `GET /api/aides` | authentifié | F-AID-01 |
| `GET /api/aides/:id/eligibilite` | bureau | F-AID-03 |
| `POST /api/aides` | authentifié | F-AID-01 |
| `POST /api/aides/:id/approbation` | président | F-AID-02 |
| `POST /api/aides/:id/versement` | trésorier | F-AID-02 |
| `GET /api/anomalies` | commissaire, bureau | F-TDB-04 |
| `GET /api/anomalies/levees` | commissaire, bureau | F-ANO-08 |
| `POST /api/anomalies/balayage` | commissaire, bureau | F-ANO-01→06 |
| `POST /api/anomalies/:id/levee` | commissaire, trésorier | F-ANO-08, F-ANO-09 |
| `GET /api/rapport-assemblee` | authentifié | F-RAP-05 |
| `GET /api/exports/journal.csv` | bureau | F-RAP-06 |
| `GET /api/exports/membres.csv` | bureau | F-RAP-06 |
| `GET /api/exports/rapport.csv` | authentifié | F-RAP-06 |
| `GET /api/releves` | bureau | F-TRX-06 |
| `POST /api/releves` | trésorier | F-TRX-06 |
| `GET /api/releves/:id/rapprochement` | bureau | F-TRX-06 |
| `GET /api/redistribution` | bureau | F-EPA-03, F-EPA-04 |
| `POST /api/reechelonnements/:id` | président | F-PRE-07 |
| `POST /api/archivage` | président | F-GRP-06 |
| `GET /api/notifications` | bureau | F-NOT |
| `GET /api/notifications/mes-notifications` | authentifié | F-NOT |
| `POST /api/notifications/balayage` | trésorier, président | F-NOT-01, F-COT-06, F-NOT-03 |
| `POST /api/notifications/accuse-versement` | trésorier | F-NOT-02 |
| `POST /api/notifications/expedition` | trésorier, président | F-NOT-04, F-NOT-05 |

Le journal n'est pas exposé aux membres : un membre lit son relevé en langage
courant, jamais le mécanisme comptable (N-USG-05).

### Notifications — une limite assumée

La file d'attente, la plage horaire décente (7 h – 20 h), la déduplication,
le report progressif et l'abandon après cinq échecs sont implémentés et
éprouvés. **L'envoi réel ne l'est pas** : aucun service SMTP ni passerelle
WhatsApp n'était joignable depuis l'environnement de développement, et livrer
un code d'envoi non testé aurait donné l'illusion que les membres sont
prévenus alors que personne n'aurait pu dire si un message était parti.

L'expéditeur est enfichable : `ExpediteurJournal` consigne et déclare envoyé,
en annonçant clairement `aucun envoi réel`. Brancher une vraie passerelle ne
touche qu'un seul fichier — `notifications.module.ts` — sans rien changer au
SQL, au service ni aux contrôleurs.

### Interface

Une fois l'API démarrée, l'interface est à **http://localhost:3100/** — elle est
servie par l'API elle-même, en fichiers statiques.

| Écran | Contenu | Rôle |
|---|---|---|
| Saisir | Versement en deux gestes, montant prérempli au reste dû | trésorier |
| Impayés | Qui doit quoi, dispenses comprises | trésorier |
| Situation | Caisse, recouvrement, tour courant, ma situation | tous |
| Membres | Qui a versé combien, qui reste devoir | tous |
| Tours | Ordre de passage et remise de la cagnotte | tous |
| Opérations | Historique, annulations barrées mais visibles | bureau |

**Ni React, ni étape de construction, ni dépendance.** N-USG-02 impose moins de
100 ko par écran utile : un bundle React minimal dépasse 140 ko avant la
première ligne de code métier. Ici l'ensemble — page, style, script — pèse
**33 ko**, et le fichier servi est le fichier écrit. Le corollaire assumé : pas
de composants, pas de JSX. Au-delà d'une vingtaine d'écrans, l'arbitrage
mériterait d'être revu.

Le vocabulaire y est tenu sans exception (N-USG-05) : on *annule* un versement,
on ne passe pas d'écriture inverse ; on lit « il reste 15 000 F à verser », pas
« échéance partielle ». Le mot **payer n'apparaît nulle part** — la plateforme
n'encaisse rien, et le laisser croire tromperait sur la nature du service.

### Comptes de démonstration

Mot de passe commun : `tontine2026`. **Trois groupes coexistent sur la même
base**, un par mécanisme — c'est la seule configuration où le cloisonnement
(N-SEC-02) et la cohérence de type (décision 0002) sont réellement mis à
l'épreuve : tant qu'un seul groupe existe, aucune fuite transversale n'est
observable.

**ROSCA — Tontine des Femmes de Bonabéri** · 12 membres, cycle en cours au tour 3

| Téléphone | Membre | Rôle |
|---|---|---|
| `+237690110001` | Awa Ndiaye | présidente |
| `+237690110002` | Marie Ebolo | trésorière |
| `+237690110003` | Fatou Bâ | commissaire aux comptes |

**ASCA — Caisse d'épargne des Jeunes de Deido** · 8 membres, 1 prêt en cours

| Téléphone | Membre | Rôle |
|---|---|---|
| `+237677220001` | Émile Njoya | président |
| `+237677220002` | Patrick Mbappé | trésorier |

**MUTUELLE — Association Solidarité de Bafoussam** · 10 membres, 3 aides

| Téléphone | Membre | Rôle |
|---|---|---|
| `+237699330001` | Pauline Kamdem | présidente |
| `+237699330002` | Joseph Tagne | trésorier |

Les trois jeux de données ont des **dates relatives au jour de chargement** :
un décor aux dates figées vieillit et met en défaut les règles de détection
qu'il sert à illustrer.

---

## Avancement

| Jalon | Contenu | État |
|---|---|---|
| **Conception** | Cahier des charges, modèle de données, diagrammes, décisions | ✅ terminé |
| **V1 — Schéma** | 11 tables, 3 vues, 19 déclencheurs ; les 10 invariants tenus par la base ; jeu de démonstration 12 membres | ✅ terminé |
| **V2 — Fondations API** | NestJS, `pg`, authentification, garde globale, cloisonnement par jeton | ✅ terminé — 9 tests verts |
| **V4 — Journal & cotisations** | `enregistrer_versement`, `annuler_versement`, `dispenser_echeance` | ✅ terminé (SQL) |
| **V5 — Tour de rôle ROSCA** | `remettre_cagnotte`, `tour_en_cours`, refus si cagnotte incomplète | ✅ terminé (SQL) |
| **V6 — Restitution** | Impayés, situation de caisse, recouvrement, tableau de bord, relevé | ✅ terminé (SQL) |
| **V7 — Recette** | Cycle complet de 12 tours, propriétés vérifiées à chaque tour | ✅ terminé |
| **V3 — Routes métier** | Cotisations, tours, membres, tableau de bord, journal | ✅ terminé — 22 tests verts |
| **Écrans** | Interface web, 6 écrans, servie par l'API | ✅ terminé — 33 ko |
| **Jalon 2** | Prêts ASCA, épargne, aides mutualistes, moteur d'anomalies, écrans | ✅ terminé — 40 tests verts |
| **Jalon 3** | Rapprochement Mobile Money, exports, rapport d'assemblée, archivage, redistribution | ✅ terminé — 59 tests verts |
| **Notifications** | File d'attente, plage horaire décente, rappels, alertes | ✅ terminé — 70 tests verts |

### Invariants vérifiés en base

Chacun a été éprouvé par une tentative d'insertion refusée, pas seulement déclaré :

| Règle | Ce que la base refuse |
|---|---|
| R-01 | Écriture déséquilibrée (débit ≠ crédit), écriture à une seule ligne |
| R-02 | `UPDATE` et `DELETE` sur `ecriture` et `ligne_ecriture` |
| R-03 | Montant négatif ou nul |
| R-04 | Même bénéficiaire deux fois dans un cycle ROSCA |
| R-09 | Deux règles de groupe aux périodes d'effet chevauchantes |
| R-10 | Téléphone dupliqué au sein d'un groupe |
| F-GRP-01 | Changement du type d'un groupe après création |
| F-GRP-05 | Réouverture d'un cycle clôturé |
| F-COT-07 | Dispense sans motif ni décideur |
| N-SEC-02 | Compte, écriture ou tour rattaché à un membre d'un autre groupe |
| Décision 0002 | Tour de rôle sur un groupe non-ROSCA |

**Critère d'acceptation du jalon 1** : une tontine de 12 membres mène un cycle
complet, la caisse reste équilibrée à chaque tour, et tout écart est traçable.

---

## Conventions

- **Français intégral** — le vocabulaire métier est nativement français
  (cotisation, tour, bénéficiaire, cagnotte). Traduire introduirait une
  correspondance permanente entre le langage des utilisateurs et celui du code.
- **Montants en `BIGINT`**, en francs — jamais de flottant sur de l'argent :
  `0.1 + 0.2 ≠ 0.3` en binaire, et une caisse ne tolère pas l'arrondi silencieux.
- **UUID** partout — pas de fuite d'information par incrément.
- **Tables au singulier**, `snake_case` ; vues préfixées `v_`.
- **Les commentaires expliquent le *pourquoi***, jamais le *quoi*, et
  référencent les exigences par code (`F-COT-02`, `R-01`).
- **Routes protégées par défaut** : oublier d'ouvrir rend une route
  inaccessible — visible aussitôt ; oublier de protéger exposerait des données
  en silence.

---

## Documentation

| Document | Objet |
|---|---|
| [Cahier des charges](docs/cahier-des-charges.md) | Acteurs, exigences codées, règles de gestion, jalons |
| [Conception de l'interface](docs/conception-interface.md) | Écrans, enchaînement, vocabulaire employé |
| [Modèle de données](docs/modele-de-donnees.md) | Schéma, dictionnaire, invariants |
| [Détection d'anomalies](docs/detection-anomalies.md) | Règles, seuils, gravités |
| [Diagrammes](docs/diagrammes/) | Cas d'utilisation, classes, séquences, états |
| [Décisions](docs/decisions/) | Arbitrages d'architecture et alternatives écartées |
