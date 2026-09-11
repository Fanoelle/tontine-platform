# Conception de l'interface

> **Version** 0.1 — 11 septembre 2026
> **Statut** À valider avant la réalisation des écrans (V3)
> **Documents liés** : [cahier des charges](cahier-des-charges.md) · [cas d'utilisation](diagrammes/cas-utilisation.md) · [séquences](diagrammes/sequences.md)

Ce document décrit **ce que voient les utilisateurs** : les écrans, leur
enchaînement, et le vocabulaire employé. Il comble le seul vide de la conception
— les diagrammes disent qui fait quoi et dans quel ordre, jamais à quoi cela
ressemble.

Il ne décrit ni le choix des composants, ni la palette, ni la typographie :
ces décisions viendront à la réalisation, une fois la structure validée.

---

## 1. Trois principes qui commandent tout le reste

### Aucun vocabulaire comptable n'atteint l'utilisateur

N-USG-05 est une contrainte d'interface avant d'être une contrainte technique.
Le journal en partie double est un mécanisme interne : un membre lit
« vous avez versé 5 000 F le 3 mars », jamais un débit ni un crédit.

| Terme interdit | Terme employé |
|---|---|
| Débit, crédit, écriture | versement, remise, correction |
| Solde du compte de cotisation | ce que vous avez versé |
| Journal, ligne d'écriture | historique des opérations |
| Écriture inverse | annulation |
| Échéance `PARTIELLE` | il reste *n* F à verser |

Cette table n'est pas cosmétique : elle est la condition pour qu'une femme du
groupe de Bonabéri lise son relevé sans formation comptable.

### La saisie d'un versement tient en moins de 30 secondes

N-USG-04 chiffre l'exigence, ce qui la rend vérifiable. Elle commande la
conception de l'écran le plus utilisé de la plateforme — trois champs, aucune
navigation intermédiaire, le membre présélectionné depuis la liste des impayés.

### Une anomalie se dit « à vérifier », jamais « fraude »

Une tontine repose sur la confiance ; un outil qui désignerait un coupable
détruirait ce qu'il prétend protéger. Le vocabulaire est contraint jusque dans
les libellés de boutons : « justifier », jamais « disculper ».

---

## 2. Ce que chaque acteur voit en ouvrant l'application

L'écran d'accueil diffère selon le rôle, parce que les besoins n'ont rien de
commun. Un membre veut savoir où il en est ; un trésorier veut saisir.

```
┌─ MEMBRE ──────────────┐  ┌─ TRÉSORIÈRE ──────────┐  ┌─ COMMISSAIRE ─────────┐
│ Ma situation          │  │ Saisir un versement   │  │ À vérifier (3)        │
│ ─────────────────     │  │ ─────────────────     │  │ ─────────────────     │
│ À jour ✓              │  │ 2 impayés ce mois     │  │ Caisse : 235 000 F    │
│ Prochain versement    │  │ Caisse : 235 000 F    │  │ Écart constaté : 0    │
│ 5 mars — 25 000 F     │  │ Tour 3 en cours       │  │ Dernier contrôle      │
│                       │  │                       │  │ 8 mars                │
│ Mon tour : rang 9     │  │ [Saisir un versement] │  │ [Voir les opérations] │
│ prévu le 5 septembre  │  │ [Voir les impayés]    │  │                       │
└───────────────────────┘  └───────────────────────┘  └───────────────────────┘
```

**Le cumul des rôles additionne les écrans, il ne les remplace pas.** Dans les
petits groupes, une même personne préside et tient la caisse (F-MBR-02). Son
accueil porte alors les deux blocs, dans l'ordre : saisie d'abord, décisions
ensuite.

---

## 3. L'écran central — saisir un versement

C'est l'écran le plus utilisé de la plateforme, et le seul dont la performance
soit chiffrée (N-USG-04). Sa conception découle entièrement de cette contrainte.

```
┌──────────────────────────────────────────────────┐
│  ←  Saisir un versement                          │
├──────────────────────────────────────────────────┤
│                                                  │
│  Membre                                          │
│  ┌────────────────────────────────────────────┐  │
│  │ Khadija Sow                             ▾  │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ Échéance du 5 mars 2026                    │  │
│  │ Attendu       25 000 F                     │  │
│  │ Déjà versé    10 000 F                     │  │
│  │ Reste dû      15 000 F                     │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  Montant reçu                                    │
│  ┌────────────────────────────────────────────┐  │
│  │ 15 000                                   F │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  Reçu le          Moyen                          │
│  ┌─────────────┐  ┌───────────────────────────┐  │
│  │ 11/09/2026  │  │ Espèces                ▾  │  │
│  └─────────────┘  └───────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │           Enregistrer le versement         │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

**Ce qui fait tenir l'écran en 30 secondes.** Le montant est prérempli au reste
dû — cas de loin le plus fréquent. La date est préremplie à aujourd'hui. Le
moyen retient le dernier utilisé. Dans le cas nominal, la trésorière choisit le
membre et valide : deux gestes.

**Pourquoi le bloc d'échéance est affiché et non replié.** Il montre ce que la
saisie va imputer. Sans lui, la trésorière saisit à l'aveugle et découvre
l'imputation après coup — c'est ainsi qu'on crée des versements mal affectés.

**Le versement excédentaire est proposé, jamais imposé** (scénario A2 du cas
F-COT-02). Si le montant dépasse le reste dû, un message propose d'imputer
l'excédent à l'échéance suivante ; refuser porte l'excédent en avance.

---

## 4. Le relevé d'un membre

Écran de lecture pure, conçu pour être compris sans aide (N-USG-05). C'est
l'écran qui répond à la question « où est mon argent ? ».

```
┌──────────────────────────────────────────────────┐
│  ←  Khadija Sow                                  │
├──────────────────────────────────────────────────┤
│  Membre depuis janvier 2026 · rang 9             │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Vous avez versé          60 000 F         │  │
│  │  Il vous reste à verser   15 000 F         │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  Vos versements                                  │
│  ─────────────────────────────────────────────   │
│  5 janvier     25 000 F   espèces         ✓      │
│  5 février     25 000 F   Mobile Money    ✓      │
│  5 mars        10 000 F   espèces         ⚠      │
│                └ il reste 15 000 F à verser      │
│                                                  │
│  Votre tour                                      │
│  ─────────────────────────────────────────────   │
│  Vous recevrez la cagnotte le 5 septembre 2026   │
│  Montant prévu : 300 000 F                       │
└──────────────────────────────────────────────────┘
```

**Aucun mot de comptabilité.** Les deux chiffres du haut répondent aux deux
seules questions qu'un membre se pose. Le détail vient ensuite.

**Le tour est rappelé.** En ROSCA, c'est la contrepartie de l'effort : afficher
ce qu'on doit sans afficher ce qu'on recevra donnerait une vue tronquée.

---

## 5. Les impayés — l'écran du trésorier

```
┌──────────────────────────────────────────────────┐
│  ←  Impayés — tour 3                             │
├──────────────────────────────────────────────────┤
│  2 membres n'ont pas versé · 1 versement partiel │
│                                                  │
│  Béatrice Mbala          25 000 F     [Saisir]   │
│  5 mars · 6 jours de retard                      │
│  ─────────────────────────────────────────────   │
│  Aminata Cissé           25 000 F     [Saisir]   │
│  5 mars · 6 jours de retard                      │
│  ─────────────────────────────────────────────   │
│  Khadija Sow             15 000 F     [Saisir]   │
│  5 mars · versé 10 000 F sur 25 000 F            │
│  ─────────────────────────────────────────────   │
│  Georgette Akono              —                  │
│  Dispensée · sinistre commerce                   │
│                                                  │
│  Total attendu encore : 65 000 F                 │
└──────────────────────────────────────────────────┘
```

**Chaque ligne porte son bouton de saisie.** C'est le chemin réel : la
trésorière consulte les impayés, puis saisit. Obliger à revenir à un menu
casserait les 30 secondes.

**La dispense est affichée, pas masquée.** Un membre dispensé n'est pas un
impayé, mais l'omettre laisserait croire à un oubli.

---

## 6. La remise de la cagnotte

Écran de décision, rare mais engageant : il déplace 300 000 F.

```
┌──────────────────────────────────────────────────┐
│  ←  Remettre la cagnotte — tour 3                │
├──────────────────────────────────────────────────┤
│  Bénéficiaire   Fatou Bâ                         │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  ⚠  La cagnotte n'est pas complète         │  │
│  │                                            │  │
│  │  Encaissé      235 000 F                   │  │
│  │  Attendu       300 000 F                   │  │
│  │  Manque         65 000 F                   │  │
│  │                                            │  │
│  │  2 membres n'ont pas versé, 1 partiel      │  │
│  │  [Voir les impayés]                        │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  La remise est impossible tant que les           │
│  cotisations ne sont pas encaissées.             │
└──────────────────────────────────────────────────┘
```

**L'écran refuse, il n'avertit pas.** La séquence §2 est explicite : on ne remet
jamais une cagnotte avant que les cotisations soient encaissées — ce serait
distribuer de l'argent absent de la caisse. Le bouton n'est pas grisé : il n'est
pas affiché, et la raison l'est.

**Le montant remis est ce qui est encaissé, jamais ce qui est attendu** (R-05).
Lorsque la remise devient possible, l'écran affiche le montant réel.

---

## 7. Annuler une saisie erronée

Le mot « annuler » est employé ; « écriture inverse » ne l'est jamais.

```
┌──────────────────────────────────────────────────┐
│  ←  Annuler un versement                         │
├──────────────────────────────────────────────────┤
│  Versement de Khadija Sow                        │
│  10 000 F · 5 mars · espèces                     │
│                                                  │
│  Pourquoi annulez-vous ?                         │
│  ┌────────────────────────────────────────────┐  │
│  │ Montant saisi par erreur : 10 000 au lieu  │  │
│  │ de 1 000.                                  │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Ce versement restera visible dans          │  │
│  │  l'historique, accompagné de son            │  │
│  │  annulation et de votre motif.              │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  [ Annuler ce versement ]                        │
└──────────────────────────────────────────────────┘
```

**Le motif est obligatoire** (N-TRC-03), et l'encadré explique ce qui va se
passer. Un utilisateur qui croit effacer et découvre que tout reste visible perd
confiance dans l'outil ; le dire avant supprime la surprise.

---

## 8. Les anomalies — écran du commissaire

```
┌──────────────────────────────────────────────────┐
│  ←  À vérifier                                   │
├──────────────────────────────────────────────────┤
│  ⚠  Cotisation non versée                        │
│  Béatrice Mbala · échéance du 5 mars             │
│  Constaté le 12 mars                             │
│  [Vérifier]                                      │
│  ─────────────────────────────────────────────   │
│  ⚠  Deux versements très rapprochés              │
│  Marie Ebolo · 25 000 F · 5 mars                 │
│  Deux saisies à 4 minutes d'intervalle           │
│  [Vérifier]                                      │
└──────────────────────────────────────────────────┘
```

**Le titre de l'écran est « À vérifier »**, pas « Anomalies » — encore moins
« Alertes ». Chaque libellé décrit un constat factuel, jamais une intention.

**Justifier exige un motif**, et l'écran rappelle que la justification reste au
dossier : la levée fait partie de la piste d'audit, elle n'efface rien.

---

## 9. Navigation d'ensemble

```
Connexion
   │
   └─→ Accueil (selon rôle)
         ├─→ Saisir un versement ──→ confirmation ──┐
         ├─→ Impayés ──→ Saisir un versement ───────┤
         ├─→ Membres ──→ Relevé d'un membre         │
         │                 └─→ Annuler un versement │
         ├─→ Tour courant ──→ Remettre la cagnotte  │
         ├─→ À vérifier ──→ Justifier               │
         └─→ Historique des opérations              │
                                                     │
              (retour à l'accueil) ←─────────────────┘
```

**Trois niveaux au maximum.** Au-delà, on se perd sur un téléphone.

**Aucun identifiant de groupe dans les URL** (N-SEC-03) : le groupe vient du
jeton. Les adresses sont `/membres/{id}`, jamais `/groupes/{id}/membres/{id}`.

---

## 10. Contraintes d'affichage

| Contrainte | Conséquence |
|---|---|
| N-USG-01 — écrans ≥ 360 px | Conception téléphone d'abord ; une colonne, pas de tableau large |
| N-USG-02 — moins de 100 ko par écran | Pas de police distante, pas d'image décorative, icônes en texte |
| N-USG-03 — français | Y compris les dates : « 5 mars 2026 » |
| Montants | Espace insécable comme séparateur : « 25 000 F » |

**Les montants ne portent jamais de décimale.** Le franc CFA n'a pas de
sous-unité en pratique, et les montants sont des entiers (N-INT-03).

---

## Points de vigilance

- **Le mot « payer » ne doit apparaître nulle part.** La plateforme n'encaisse
  rien : elle enregistre des versements faits ailleurs. Un bouton « payer »
  laisserait croire que l'argent transite par l'application, ce que le cahier
  des charges écarte explicitement (§1.3).
- **Aucun écran ne doit proposer de supprimer.** Ni un versement, ni un membre,
  ni une opération. Les verbes sont « annuler » (versement), « radier »
  (membre) — et l'interface dit ce qui reste visible.
- **Le solde affiché n'est pas un portefeuille.** Il porte un libellé explicite
  — « ce que le groupe détient en caisse » — et jamais « votre solde », qui
  laisserait croire à un avoir mobilisable.
- **Un écran vide doit expliquer, pas se taire.** « Aucun impayé » est une bonne
  nouvelle : elle se dit, avec le total encaissé en regard.
- **Le cumul trésorier / commissaire s'affiche au moment d'agir**, pas à la
  connexion (F-MBR-06) : un avertissement permanent devient invisible.
