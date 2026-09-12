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
│   Web (React)   │ ─────────────► │   API (NestJS)   │
│   responsive    │ ◄───────────── │   TypeScript     │
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
├── api/              API NestJS + TypeScript          (V2)
├── db/
│   ├── migrations/
│   │   ├── 001_socle.sql        Types, groupe, règles datées, membres, rôles
│   │   ├── 002_journal.sql      Comptes, écritures, équilibre R-01, immuabilité R-02
│   │   └── 003_cycle_rosca.sql  Cycle, échéances, cotisations, tour ROSCA
│   └── seeds/
│       └── 001_demonstration.sql  Tontine de 12 membres, cycle en cours
├── web/              Interface React responsive       (V3+)
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

### API — installation en attente

Le code de l'API est écrit mais **n'a jamais été compilé ni exécuté** : l'accès
réseau sortant de la machine de développement est coupé (registre npm et GitHub
injoignables, en IPv4 comme en IPv6), et le cache npm local ne couvre pas
l'arbre de dépendances complet.

Dès que le réseau est rétabli :

```bash
cd api
cp .env.example .env          # puis remplacer JWT_SECRET
npm install
npm run verifier-types        # compilation TypeScript
npm run tester                # tests d'intégration contre la vraie base
npm run dev
```

Les tests exigent une base démarrée et les deux jeux de données chargés. Ils
vérifient que les gardes refusent réellement : route sans jeton, jeton
fantaisiste, mot de passe erroné, propriété non déclarée.

Comptes de démonstration — mot de passe `tontine2026` :

| Téléphone | Membre | Rôles |
|---|---|---|
| `+237690110001` | Awa Ndiaye | présidente |
| `+237690110002` | Marie Ebolo | trésorière |
| `+237690110003` | Fatou Bâ | commissaire aux comptes |

---

## Avancement

| Jalon | Contenu | État |
|---|---|---|
| **Conception** | Cahier des charges, modèle de données, diagrammes, décisions | ✅ terminé |
| **V1 — Schéma** | 11 tables, 3 vues, 19 déclencheurs ; les 10 invariants tenus par la base ; jeu de démonstration 12 membres | ✅ terminé |
| **V2 — Fondations API** | NestJS, `pg`, authentification, garde globale, cloisonnement par jeton | ⚠️ code écrit, **jamais compilé ni testé** |
| **V3 — Groupes & membres** | CRUD groupes, règles datées, membres, rôles | ⏳ à venir |
| **V4 — Journal & cotisations** | Saisie d'un versement, partiels, correction par écriture inverse, impayés | ⏳ à venir |
| **V5 — Tour de rôle ROSCA** | Ordre de passage, tour courant, remise de la cagnotte | ⏳ à venir |
| **V6 — Restitution** | Relevé individuel, situation de caisse, tableau de bord | ⏳ à venir |
| **V7 — Recette** | Scénario d'acceptation de bout en bout | ⏳ à venir |
| **Jalon 2** | Prêts, épargne ASCA, aides, moteur d'anomalies, notifications | ⏳ à venir |
| **Jalon 3** | Rapprochement Mobile Money, WhatsApp, exports, archivage | ⏳ à venir |

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
