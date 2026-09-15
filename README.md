# Plateforme de gestion des tontines et associations

Registre transparent et vérifiable pour les tontines, associations, mutuelles et
caisses communautaires — avec **détection automatique des incohérences** avant
qu'elles ne deviennent des conflits.

**Essayer en trois commandes** → [Démarrage rapide](#démarrage-rapide) ·
**Comprendre** → [Comment ça marche](#comment-ça-marche) ·
**Éprouver** → [Guide de test](#guide-de-test)

---

## Table des matières

1. [Le problème](#le-problème)
2. [Démarrage rapide](#démarrage-rapide)
3. [Comment ça marche](#comment-ça-marche)
   — [Les trois mécanismes](#les-trois-mécanismes) ·
   [Le journal en partie double](#le-journal-en-partie-double) ·
   [Rôles et habilitations](#rôles-et-habilitations) ·
   [Cycle de vie d'une cotisation](#cycle-de-vie-dune-cotisation) ·
   [Détection d'anomalies](#détection-danomalies) ·
   [Notifications](#notifications) ·
   [Reprendre un cahier](#reprendre-un-cahier-existant) ·
   [Hors ligne](#consultation-hors-ligne)
4. [Guide de test](#guide-de-test)
   — [Parcours dans l'interface](#parcours-1--interface-trésorière-rosca) ·
   [Tests automatisés](#tests-automatisés) ·
   [Éprouver les invariants](#éprouver-les-invariants) ·
   [Tester en ligne de commande](#tester-lapi-en-ligne-de-commande)
5. [Architecture](#architecture)
6. [Référence des routes](#référence-des-routes)
7. [Arborescence](#arborescence)
8. [Dépannage](#dépannage)
9. [Ce qui n'est pas fait](#ce-qui-nest-pas-fait)
10. [Conventions et documentation](#conventions)

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

> **Projet indépendant.** Il ne partage ni code, ni base, ni dépendance avec les
> autres projets de cette machine. Sa base tourne dans son propre conteneur
> (port 55433), son API sur le port 3100.

---

## Démarrage rapide

**Prérequis** : Docker, Node.js 20 ou plus.

```bash
# 1. Base de données — conteneur, 19 migrations, 3 groupes de démonstration
./scripts/db.sh demarrer

# 2. API + interface
cd api
cp .env.example .env      # remplacez JWT_SECRET par une valeur aléatoire
npm install
npm run dev
```

Ouvrez **http://localhost:3100/** et connectez-vous :

| Téléphone | Mot de passe | Vous êtes |
|---|---|---|
| `+237690110002` | `tontine2026` | Marie Ebolo, **trésorière** d'une tontine de 12 femmes |

Vous arrivez sur l'écran de saisie — le geste quotidien d'une trésorière. Trois
membres n'ont pas encore versé pour le tour en cours.

> Pour un secret JWT solide : `openssl rand -base64 48`

---

## Comment ça marche

### Le principe en une phrase

**L'argent ne transite jamais par la plateforme.** Elle *enregistre* des
mouvements réalisés ailleurs — espèces, Mobile Money — sans jamais les
encaisser. Aucun agrément financier n'est requis, aucun avoir n'est détenu. Les
soldes affichés sont comptables, pas des portefeuilles.

C'est pourquoi le mot « payer » n'apparaît nulle part dans l'interface : on
*enregistre un versement*, on ne paie pas.

### Les trois mécanismes

Un groupe choisit son mécanisme à la création, et ce choix est **définitif** :
changer de mécanisme rendrait ininterprétables les écritures déjà passées.

| | ROSCA | ASCA | Mutuelle |
|---|---|---|---|
| **Principe** | Chacun cotise, un membre reçoit toute la cagnotte à chaque tour | Les cotisations s'accumulent, la caisse prête avec intérêts | Fonds collectif mobilisé lors d'événements |
| **Caisse** | vidée à chaque tour | croît puis est redistribuée | croît et se dépense |
| **Droit du membre** | recevoir la cagnotte une fois par cycle | solde d'épargne individuel | aucun droit individuel |
| **Spécificité** | ordre de passage arrêté à l'avance | prêts avec échéancier | aides non remboursables |

Leurs règles d'argent étant incompatibles, le schéma repose sur un **socle
commun** (groupes, membres, cotisations, journal comptable) complété de **tables
spécialisées** par mécanisme. Un `tour` n'existe que pour une ROSCA, un `pret`
que pour une ASCA, une `aide` que pour une mutuelle — et **la base refuse le
contraire**, ce n'est pas une convention de code.

### Le journal en partie double

Toute somme est portée au débit d'un compte et au crédit d'un autre. **Rien
n'est jamais modifié ni supprimé** : une erreur se corrige par une écriture
inverse qui référence l'écriture d'origine.

```
Cotisation de 25 000 F de Khadija Sow, réglée en espèces

  Écriture #37  « Cotisation du 05/09/2026 — Khadija Sow »
    ├─ DÉBIT   caisse_espèces               25 000
    └─ CRÉDIT  cotisations_membre_Khadija   25 000
                                            ──────
                               équilibre :       0  ✓
```

Ce choix paraît lourd ; il est en réalité ce qui rend la détection d'anomalies
rigoureuse. Un solde n'est pas une valeur que l'on maintient — donc que l'on peut
désynchroniser — mais une valeur que l'on **recalcule**. Un écart cesse d'être
une intuition : c'est un déséquilibre arithmétique, localisable à l'écriture près.

**L'utilisateur ne voit jamais un débit ni un crédit.** Il lit « vous avez versé
25 000 F le 5 septembre ».

### Rôles et habilitations

Quatre rôles, cumulables. Les habilitations sont vérifiées **côté serveur à
chaque appel**, depuis la base — pas depuis le jeton, qui pourrait être périmé.

| Rôle | Ce qu'il fait |
|---|---|
| **Membre** | Consulte sa situation, son relevé, le rapport d'assemblée. Demande un prêt ou une aide. |
| **Trésorier** | Enregistre les versements, remet la cagnotte, encaisse les remboursements, verse les aides. |
| **Président** | Approuve ou refuse prêts et aides, accorde les dispenses, rééchelonne, archive le groupe. |
| **Commissaire** | Consulte le journal, lève les anomalies — y compris les critiques, réservées à lui seul. |

**La séparation est tenue jusque dans les routes** : le président décide, le
trésorier verse. Une présidente qui tenterait de verser elle-même une aide
qu'elle vient d'approuver reçoit un refus.

Le cumul de rôles est autorisé — dans les petits groupes, une même personne
préside et tient la caisse — mais l'interface le signale quand il affaiblit le
contrôle mutuel.

#### Qui fait quoi — diagramme de cas d'utilisation

![Cas d'utilisation](docs/uml/images/cas-utilisation.png)

Les traits pleins portent l'initiative d'un acteur, les pointillés une
dépendance entre cas. **Le nœud central est « Journaliser une écriture
équilibrée »** : tout cas qui déplace de l'argent y passe, sans exception.

**L'administrateur plateforme est volontairement isolé** — aucun lien vers les
domaines métier, car N-SEC-02 lui interdit l'accès aux données des groupes.

### Cycle de vie d'une cotisation

![États d'une échéance](docs/uml/images/etats-echeance.png)

**`IMPAYÉE` n'est pas terminal** : un versement tardif reste toujours possible,
et c'est le cas courant dans les groupes réels. **`RÉGLÉE` admet une sortie** :
une correction ramène l'échéance en `PARTIELLE`, sans jamais toucher à
l'écriture d'origine.

### Détection d'anomalies

L'apport différenciant. Six familles de signalements, exécutées en tâche de
fond — **jamais pendant une saisie** :

| Anomalie | Ce qui la déclenche | Gravité |
|---|---|---|
| Cotisation manquante | Échéance dépassée de 7 jours sans versement | relevée à **critique** si le membre a déjà reçu sa cagnotte |
| Remboursement en retard | Échéance de prêt non honorée | critique au-delà de 15 jours |
| Montant inhabituel | Versement s'écartant de 3 × l'écart médian du membre | information ou avertissement |
| Solde incohérent | Divergence entre une valeur suivie et le journal | **toujours critique** |
| Double saisie | Deux versements identiques à moins de 10 minutes | critique si même référence Mobile Money |
| Saisie tardive | Écriture enregistrée longtemps après l'opération | critique si datée du futur |

> **Une anomalie est un signalement, jamais une accusation.** L'écran s'appelle
> « À vérifier », jamais « Alertes ». Le message dit explicitement : *« Il ne
> s'agit pas d'une accusation : la plupart de ces écarts s'expliquent
> simplement. »* Une anomalie levée reste consignée avec son motif — la levée
> fait partie de la piste d'audit.

**Pourquoi la médiane et non la moyenne**, pour le montant inhabituel : une
moyenne est tirée par les valeurs extrêmes, et un seul versement exceptionnel
rendrait aveugle aux suivants. Minimum 6 versements d'historique — en deçà, un
nouveau membre serait signalé simplement parce qu'il est nouveau.

### Traçabilité et documents imprimables

**Trois niveaux de trace, et ils ne se confondent pas.**

| Trace | Ce qu'elle prouve | Qui la lit |
|---|---|---|
| Journal comptable | Les mouvements d'argent, en partie double | bureau, commissaire |
| **Historique** | Les **décisions** : dispense, refus de prêt, levée d'anomalie | tout membre |
| Journal d'accès | Les connexions et les tentatives refusées | commissaire |

L'historique comble un manque réel : le journal prouve qu'un versement a eu
lieu, mais une dispense accordée ou un prêt refusé ne produisent **aucune
écriture** — et ce sont les décisions les plus contestables en assemblée.

Il est **alimenté par des déclencheurs**, pas par des appels dans les fonctions
métier. Un appel dans le code peut être oublié ; une fonction écrite dans six
mois n'aurait aucune raison de penser à consigner. Un déclencheur sur la table
capte tout ce qui s'y insère, y compris ce qu'on n'a pas prévu — c'est le
raisonnement de R-01 appliqué à la traçabilité.

Et il est **immuable** : `UPDATE` et `DELETE` refusés. Une piste d'audit
modifiable ne prouve rien.

#### L'impression, pensée pour un document qui circule

En assemblée, une feuille passe de main en main, est lue à voix haute, parfois
contestée sur-le-champ. Trois questions se posent alors, et le document y
répond seul :

- **De quel groupe ?** — cachet d'initiales encadré comme un tampon, nom du
  groupe, mécanisme, auteur du document
- **De quelle date ?** — date et heure d'arrêté, en évidence à droite
- **Cette feuille est-elle complète ?** — empreinte du tirage en pied de page,
  identique sur toutes les feuilles d'une même impression

S'y ajoutent une mention de ce que le document **n'est pas** — la plateforme
n'encaisse rien — et un espace de visa pour le trésorier, le président et le
commissaire, mais **seulement sur les documents qui engagent** : faire signer
une liste de membres banaliserait la signature.

> **Pas de numérotation des pages, et c'est vérifié.** `counter(page)` avec
> `position: fixed` ne s'incrémente qu'en Firefox — Chrome répète « Page 1 » sur
> chaque feuille. Les margin-boxes `@page` sont derrière un drapeau non activé
> par défaut dans Chromium. Une pagination **fausse** sur un document qui circule
> serait pire qu'aucune : elle ferait croire qu'il ne manque rien.

Le bouton « Imprimer ce document » apparaît sur les écrans qui produisent un
document — pas sur la saisie, où il n'aurait aucun sens.


### Notifications

Rien n'est envoyé au moment de l'événement. Tout passe par une **file
d'attente**, pour trois raisons qui se cumulent :

- **Plage horaire décente** (7 h – 20 h) : un versement saisi à 23 h ne doit pas
  réveiller le membre. Une anomalie critique fait exception — elle porte sur de
  l'argent peut-être déjà disparu.
- **Ne jamais bloquer une saisie** : envoyer dans la transaction lierait la
  durabilité de l'écriture à la disponibilité d'un service externe.
- **Rejouer un échec** : report progressif 5 → 10 → 20 → 40 min, puis abandon
  consigné au cinquième essai. Savoir qu'un membre n'a **jamais** pu être
  prévenu est une information.

#### Envoi réel par courriel

Renseigner `SMTP_HOTE` et `SMTP_EXPEDITEUR` dans `api/.env` suffit à activer
l'envoi. Sans eux, un expéditeur de développement consigne chaque message avec
la mention « SIMULÉ » et le déclare envoyé : la mécanique s'éprouve
entièrement, sans rien prétendre sur le monde extérieur. Le démarrage annonce
lequel des deux est actif.

Une configuration **incomplète** fait échouer le démarrage plutôt que de
laisser croire à un envoi — une adresse d'expéditeur manquante ferait rejeter
chaque message, membre par membre, et l'erreur n'apparaîtrait qu'en fin de
file.

Le client SMTP est écrit sur `node:net` et `node:tls`, sans `nodemailer`. Pour
l'éprouver contre un vrai serveur :

```bash
# Un serveur SMTP de test, dans une console
cd api && npx ts-node -e "
  import('./src/notifications/serveur-smtp-test').then(async (m) => {
    const s = new m.ServeurSmtpTest({});
    console.log('port', await s.demarrer());
    setInterval(() => s.recus.forEach((r) => console.log(r.entetes.subject)), 2000);
  })"

# Dans une autre : l'API pointée dessus
SMTP_HOTE=127.0.0.1 SMTP_PORT=<le port affiché> \
SMTP_EXPEDITEUR=tontine@exemple.test npm run demarrer
```

Les canaux WhatsApp et SMS restent **refusés explicitement** par l'expéditeur
SMTP : le message est mis en échec avec un motif lisible et reste en file. Le
marquer « envoyé » ferait disparaître une notification que personne n'a reçue.

#### Rappels automatiques

Un planificateur balaye tous les groupes non archivés toutes les trente
minutes : il met en file les rappels et les alertes, puis expédie ce qui est
dû. Actif par défaut — un rappel qu'il faut penser à activer reproduit le
problème qu'il corrige, le trésorier qui oublie de cliquer étant exactement
celui dont le groupe a besoin de rappels.

`RAPPELS_AUTOMATIQUES=non` le désactive (tests, instance de secours).
`RAPPELS_INTERVALLE_MINUTES` et `RAPPELS_JOURS_AVANT` sont bornés : une valeur
absurde est ramenée, jamais appliquée telle quelle.

Le bouton « Balayer » reste disponible : le trésorier qui vient de saisir dix
versements veut voir partir les accusés sans attendre le prochain passage.
Rejouer est sans risque, la déduplication étant portée par des index uniques en
base et non par la cadence des appels.

---

### Reprendre un cahier existant

Un groupe qui tient son cahier depuis deux ans ne ressaisira pas vingt-quatre
mois d'historique pour essayer la plateforme. L'onglet **« Reprendre un
cahier »** apparaît au président et au trésorier d'un groupe **neuf** — il
disparaît dès qu'un cycle existe.

**L'import ne contourne rien.** Il aurait été plus simple d'insérer les soldes
finaux dans le journal ; c'eût été une faute. Les versements sont rejoués par
`enregistrer_versement()`, la fonction du quotidien : un cahier importé produit
exactement les écritures qu'aurait produites une saisie au fil de l'eau, et le
journal reste équilibré (R-01). Un contrôleur n'a donc pas à se demander si les
écritures importées obéissent aux mêmes règles que les autres.

**L'aperçu est la pièce maîtresse.** Le journal étant immuable, un import
regretté ne se défait pas : il faut détruire le groupe. On dépose le fichier, on
vérifie ce qui a été lu — membres, ordre de passage, montant total — puis on
valide.

Le format est un CSV tel qu'un tableur l'exporte. Colonnes reconnues :

| Colonne | Rôle | Obligatoire |
|---|---|---|
| `nom` | nom du membre | oui |
| `telephone` | identifie le membre (deux homonymes sont indiscernables sans lui) | oui |
| `rang` | ordre de passage — quand ce membre **touche** la cagnotte | non |
| `tour` | à quel tour se rapporte **ce versement** | non |
| `date` | JJ/MM/AAAA ou AAAA-MM-JJ | si montant |
| `montant` | francs entiers : `15 000`, jamais `15 000,00` | non |
| `moyen` | `especes`, `momo`, `Orange Money`, `virement`… | non |

Point-virgule d'Excel français, BOM de Windows, accents et casse dans les
en-têtes, noms entre guillemets contenant des virgules : tout cela est lu. En
revanche **rien n'est deviné** — une colonne `montan` n'est pas reconnue, et un
moyen de paiement inconnu est refusé plutôt qu'interprété.

Seuls les **ROSCA** sont importables. Un cahier d'ASCA porte des prêts avec
échéanciers, une mutuelle des délibérations d'aide : ni l'un ni l'autre ne se
réduit à « qui a versé combien, quand ».

---

### Consultation hors ligne

Une tontine se tient là où le réseau est faible. Le trésorier qui ouvre la
plateforme devant le groupe pour répondre à « combien ai-je versé ? » ne peut
pas répondre « attends que ça charge ».

**On lit, on n'écrit pas.** Les écrans consultés — et quelques autres,
préchargés à la connexion — restent lisibles sans réseau, avec un bandeau qui
annonce l'âge des données. La **saisie est refusée**, avec un message qui dit
pourquoi : un versement rejoué plus tard contre une base qui aura changé
risquerait de compter double dans un journal immuable.

Le cache est cloisonné par membre, vidé à la déconnexion, et une donnée de plus
de sept jours est écartée — un solde de la semaine dernière présenté comme
courant tromperait là où un écran vide fait comprendre qu'il faut du réseau.

Pour l'éprouver :

```bash
node scripts/essai-hors-ligne.js     # 15 vérifications dans Chromium
```

---

## Guide de test

Trois façons d'éprouver la plateforme, de la plus concrète à la plus exhaustive.

### Parcours 1 — Interface, trésorière ROSCA

**But** : encaisser les cotisations manquantes puis remettre la cagnotte.

```bash
./scripts/db.sh reinitialiser   # décor propre
cd api && npm run dev
```

Connectez-vous en **`+237690110002` / `tontine2026`** (Marie Ebolo, trésorière).

| # | Action | Ce que vous devez observer |
|---|---|---|
| 1 | Onglet **Situation** | Caisse à 210 000 F, tour 3 pour Fatou Bâ, il manque 90 000 F |
| 2 | Onglet **Impayés** | 3 membres en attente + Georgette Akono, *dispensée* avec son motif |
| 3 | Onglet **Tours** | Le bouton de remise est **absent**, avec la raison affichée |
| 4 | Onglet **Saisir** | Montant prérempli au reste dû, date à aujourd'hui |
| 5 | Saisissez un montant **supérieur** au reste dû | Refus : « le versement dépasse le reste dû » |
| 6 | Saisissez le montant exact, pour les 3 membres | « Versement enregistré. X est à jour. » |
| 7 | Retour sur **Tours** | Le bouton apparaît : « Remettre 275 000 F à Fatou Bâ » |
| 8 | Cliquez | 275 000 F et non 300 000 — la dispense est déduite |
| 9 | Onglet **Situation** | **Caisse à 0 F** : en ROSCA, elle se vide à chaque tour |

L'étape 3 est la plus instructive : le bouton n'est pas *grisé*, il est *absent*
— un bouton inactif invite à chercher comment le débloquer.

### Parcours 2 — Prêts ASCA

Connectez-vous en **`+237677220001` / `tontine2026`** (Émile Njoya, président).

| # | Action | Attendu |
|---|---|---|
| 1 | Onglet **Prêts** | 1 prêt en cours, 150 000 F restant dus ; avoir de la caisse affiché |
| 2 | Onglet **Situation** | Caisse à 1 862 000 F — **elle ne se vide pas**, contrairement à la ROSCA |
| 3 | Onglet **À vérifier** → *Relancer la vérification* | Un retard de remboursement est signalé |
| 4 | Cliquez **Justifier**, tapez « vu » | Refus : le motif doit faire au moins 20 caractères |
| 5 | Tapez un vrai motif | L'écart bascule dans « Déjà justifiées », avec votre nom |

Notez qu'il n'y a **pas d'onglet Tours** : une ASCA n'a pas d'ordre de passage.

### Parcours 3 — Aides mutualistes

Connectez-vous en **`+237699330001` / `tontine2026`** (Pauline Kamdem, présidente).

| # | Action | Attendu |
|---|---|---|
| 1 | Onglet **Aides** | 3 aides : une versée, une accordée à remettre, une à étudier |
| 2 | **Décider** sur la demande en attente | Vous pouvez accorder **moins** que demandé |
| 3 | Tentez de **Remettre** une aide accordée | Le bouton est absent : la présidente décide, le trésorier verse |
| 4 | Reconnectez-vous en `+237699330002` | Le bouton **Remettre** apparaît |

### Tests automatisés

**151 tests d'intégration**, contre la vraie base — jamais contre des doublures.
Les invariants vivant dans le schéma, une doublure testerait la moitié qui ne
peut pas casser.

```bash
./scripts/db.sh reinitialiser   # OBLIGATOIRE avant chaque passage
cd api && npm run tester
```

| Fichier | Tests | Ce qu'il éprouve |
|---|---|---|
| `authentification.spec.ts` | 9 | Routes protégées par défaut, jeton, cloisonnement |
| `metier.spec.ts` | 13 | Cotisations, impayés, tour de rôle, journal |
| `jalon2.spec.ts` | 18 | Prêts, aides, anomalies, cloisonnement entre 3 groupes |
| `jalon3.spec.ts` | 19 | Rapports, exports, Mobile Money, rééchelonnement |
| `notifications.spec.ts` | 14 | File, plage horaire, déduplication, balayage global |
| `smtp.spec.ts` | 27 | Dialogue SMTP contre un vrai serveur, sur une vraie prise TCP |
| `planificateur.spec.ts` | 9 | Chevauchement, exceptions avalées, bornes de configuration |
| `import.spec.ts` | 42 | Analyse CSV, refus, import complet, équilibre du journal |

**Deux essais s'exécutent dans un vrai navigateur**, hors de Jest. Ils existent
parce que le code du client se lisait comme correct sans l'être — voir
[Consultation hors ligne](#consultation-hors-ligne) :

```bash
node scripts/essai-hors-ligne.js   # 15 vérifications — découpage, cache, refus de saisie
node scripts/essai-import.js       # 12 vérifications — aperçu, validation, onglets
```

Ils passent par l'interface réelle — clics sur les onglets, sur les boutons —
et non par les fonctions internes : depuis le découpage en modules ES, rien
n'est exposé globalement, ce qui a rendu ces essais plus fidèles qu'ils ne
l'étaient.

> **Les tests consomment le jeu de démonstration** : ils encaissent le tour 3,
> remettent la cagnotte, octroient des prêts. Sans `reinitialiser` préalable,
> les échéances sont déjà réglées et le parcours échoue — l'échec vient du décor,
> pas du code.

Autres commandes :

```bash
npm run verifier-types      # compilation TypeScript seule
npm run tester:surveille    # relance à chaque modification
```

### Éprouver les invariants

La commande la plus importante du projet. Elle ne *lit* pas le schéma : elle
**tente** des violations et exige un refus.

```bash
./scripts/db.sh verifier
```

```
  R-02 modification d'une écriture             refusé
  R-02 suppression d'une ligne                 refusé
  R-03 montant négatif                         refusé
  R-04 deux tours pour un même membre          refusé
  R-10 téléphone dupliqué                      refusé
  F-GRP-01 changement de type de groupe        refusé

  Équilibre global du journal : 0 — équilibré

  ✓ tous les invariants tiennent
```

**Un invariant jamais mis à l'épreuve n'est pas un invariant, c'est une
intention.**

### Recettes d'acceptation

Trois scénarios de bout en bout, un par jalon. Chacun **exécute** le métier par
les fonctions SQL, puis vérifie des propriétés à chaque étape.

```bash
./scripts/db.sh recette          # jalon 1 — cycle ROSCA complet, 12 tours
./scripts/db.sh recette-jalon2   # jalon 2 — prêts, aides, anomalies
./scripts/db.sh recette-jalon3   # jalon 3 — rapports, Mobile Money, archivage
```

La recette du jalon 1 vérifie **à chaque tour** que la caisse retombe à zéro et
que le journal reste équilibré. Un contrôle final ne distinguerait pas douze
tours corrects d'une compensation fortuite entre deux erreurs opposées.

```
  tour  3 —  275000 F remis à Fatou Bâ        (caisse: 0, journal: équilibré)
  tour  4 —  300000 F remis à Christine Manga (caisse: 0, journal: équilibré)
  ...
  12 tours remis, 12 bénéficiaires distincts (R-04)
  3575000 F encaissés = 3575000 F remis (conservation)
  ===== RECETTE RÉUSSIE — critère du jalon 1 satisfait =====
```

### Tester l'API en ligne de commande

```bash
# 1. Obtenir un jeton
JETON=$(curl -s -X POST http://localhost:3100/api/authentification/connexion \
  -H 'Content-Type: application/json' \
  -d '{"telephone":"+237690110002","mot_de_passe":"tontine2026"}' \
  | sed -n 's/.*"jeton":"\([^"]*\)".*/\1/p')

# 2. Tableau de bord
curl -s http://localhost:3100/api/tableau-de-bord \
  -H "Authorization: Bearer $JETON" | python3 -m json.tool

# 3. Impayés du cycle
curl -s http://localhost:3100/api/cotisations/impayes \
  -H "Authorization: Bearer $JETON" | python3 -m json.tool

# 4. Rapport d'assemblée
curl -s http://localhost:3100/api/rapport-assemblee \
  -H "Authorization: Bearer $JETON" | python3 -m json.tool

# 5. Export tableur
curl -s http://localhost:3100/api/exports/journal.csv \
  -H "Authorization: Bearer $JETON" -o journal.csv
```

**Vérifications de sécurité à tenter :**

```bash
# Sans jeton → 401
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/api/tableau-de-bord

# Rôle insuffisant → 403 (le commissaire ne saisit pas de versement)
# Ressource d'un autre groupe → 404, jamais 403 :
#   répondre « interdit » confirmerait son existence
```

### Explorer la base directement

```bash
./scripts/db.sh console
```

```sql
-- Le solde est TOUJOURS recalculé, jamais stocké
SELECT libelle, solde FROM v_solde_compte WHERE groupe_id =
  (SELECT id FROM groupe WHERE type = 'ROSCA');

-- Tentez de modifier une écriture : la base refuse (R-02)
UPDATE ecriture SET libelle = 'falsifié' WHERE numero = 1;

-- Le rapport d'assemblée, tel qu'il sera lu devant le groupe
SELECT rubrique, intitule, valeur
  FROM rapport_assemblee((SELECT id FROM groupe WHERE type = 'ASCA'));
```

---

## Architecture

```
┌──────────────────┐     HTTPS      ┌──────────────────┐
│  Web — modules ES│ ─────────────► │   API (NestJS)   │
│  sans dépendance │ ◄───────────── │   TypeScript     │
└──────────────────┘   JSON, JWT    └────────┬─────────┘
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

**Où vit la logique métier.** Dans des fonctions PL/pgSQL, pas dans le service
TypeScript. Une fonction est **atomique par construction** : `enregistrer_versement`
insère l'écriture, ses lignes et la cotisation en une seule transaction.
Reconstituer ce séquencement en TypeScript exposerait à l'interrompre à
mi-chemin — et le déclencheur d'équilibre étant différé au `COMMIT`, une
écriture incomplète serait rejetée.

#### Le parcours d'un versement, de la saisie au journal

![Séquence — enregistrer une cotisation](docs/uml/images/sequence-cotisation.png)

Le point central est la **vérification différée** : les lignes sont insérées
avant le contrôle d'équilibre, qui s'exécute à la validation de la transaction.
Un déséquilibre n'est pas corrigé — il est rejeté, et la transaction entière
annulée. Ni écriture, ni ligne, ni imputation ne subsistent.

#### La structure des données

![Diagramme de classes](docs/uml/images/classes.png)

**La spécialisation ne passe pas par l'héritage.** `Tour`, `Pret` et `Aide` ne
dérivent pas d'une superclasse commune : elles se rattachent au cycle sous une
contrainte de cohérence de type, vérifiée par la base. Un héritage objet
unifierait artificiellement trois mécanismes dont les règles d'argent sont
incompatibles.

**L'API se connecte en `tontine_app`**, rôle dont les privilèges `UPDATE` et
`DELETE` sont révoqués sur le journal. Elle le vérifie au démarrage :

```
[BaseService] Connecté en tant que « tontine_app »
[BaseService] R-02 vérifié : journal non modifiable par ce rôle
```

### Invariants tenus par la base

Chacun a été éprouvé par une tentative refusée, pas seulement déclaré :

| Règle | Ce que la base refuse | Mécanisme |
|---|---|---|
| R-01 | Écriture déséquilibrée, écriture à une seule ligne | `CONSTRAINT TRIGGER` différé |
| R-02 | `UPDATE` / `DELETE` sur le journal | Privilèges révoqués + déclencheur |
| R-03 | Montant négatif ou nul | `CHECK` |
| R-04 | Même bénéficiaire deux fois dans un cycle | Index unique |
| R-07 | Capital restant dû négatif ou supérieur au prêt | `CHECK` |
| R-09 | Règles de groupe aux périodes chevauchantes | Contrainte d'exclusion GiST |
| R-10 | Téléphone dupliqué dans un groupe | Index unique partiel |
| F-GRP-01 | Changement du type d'un groupe | Déclencheur |
| F-GRP-05 | Réouverture d'un cycle clôturé | Déclencheur |
| N-SEC-02 | Ressource rattachée à un membre d'un autre groupe | Déclencheur |
| Décision 0002 | Tour sur une ASCA, prêt sur une ROSCA, aide sur une ASCA | Déclencheur |

---

## Référence des routes

52 routes. **Aucune ne porte d'identifiant de groupe** : il vient du jeton
(N-SEC-03), ce qui rend une fuite transversale structurellement impossible
plutôt que simplement évitée.

<details>
<summary><b>Authentification et consultation</b></summary>

| Route | Rôle requis | Exigence |
|---|---|---|
| `POST /api/authentification/connexion` | — *(publique)* | N-SEC-01 |
| `GET /api/authentification/session` | authentifié | N-SEC-03 |
| `GET /api/tableau-de-bord` | authentifié | F-TDB-01, F-TDB-05 |
| `GET /api/membres` | authentifié | F-MBR-03 |
| `GET /api/situation-caisse` | bureau | F-RAP-02, F-TRX-04 |
| `GET /api/recouvrement` | bureau | F-RAP-03 |
| `GET /api/journal` | commissaire, bureau | F-TRX-03 |

</details>

<details>
<summary><b>Cotisations et tour de rôle</b></summary>

| Route | Rôle requis | Exigence |
|---|---|---|
| `GET /api/cotisations/impayes` | bureau | F-COT-04 |
| `POST /api/cotisations` | trésorier | F-COT-02, F-COT-03 |
| `POST /api/cotisations/:id/annulation` | trésorier | F-COT-05 |
| `POST /api/cotisations/echeances/:id/dispense` | président | F-COT-07 |
| `GET /api/cotisations/releve/:membre_id` | authentifié | F-RAP-01 |
| `GET /api/tours` | authentifié | F-TOU-02 |
| `POST /api/tours/:id/remise` | trésorier | F-TOU-03, R-05 |

</details>

<details>
<summary><b>Prêts ASCA</b></summary>

| Route | Rôle requis | Exigence |
|---|---|---|
| `GET /api/prets` | authentifié | F-RAP-04 |
| `GET /api/prets/avoir-disponible` | bureau | R-06 |
| `GET /api/prets/:id/echeancier` | authentifié | F-PRE-03 |
| `POST /api/prets` | authentifié | F-PRE-01 |
| `POST /api/prets/:id/approbation` | président | F-PRE-02, R-06 |
| `POST /api/prets/:id/refus` | président | F-PRE-02 |
| `POST /api/prets/:id/remboursement` | trésorier | F-PRE-04, R-07 |
| `POST /api/reechelonnements/:id` | président | F-PRE-07 |
| `GET /api/redistribution` | bureau | F-EPA-03, F-EPA-04 |

</details>

<details>
<summary><b>Aides mutualistes</b></summary>

| Route | Rôle requis | Exigence |
|---|---|---|
| `GET /api/aides` | authentifié | F-AID-01 |
| `GET /api/aides/:id/eligibilite` | bureau | F-AID-03 |
| `POST /api/aides` | authentifié | F-AID-01 |
| `POST /api/aides/:id/approbation` | président | F-AID-02 |
| `POST /api/aides/:id/versement` | trésorier | F-AID-02 |

</details>

<details>
<summary><b>Anomalies</b></summary>

| Route | Rôle requis | Exigence |
|---|---|---|
| `GET /api/anomalies` | commissaire, bureau | F-TDB-04 |
| `GET /api/anomalies/levees` | commissaire, bureau | F-ANO-08 |
| `POST /api/anomalies/balayage` | commissaire, bureau | F-ANO-01→06 |
| `POST /api/anomalies/:id/levee` | commissaire, trésorier | F-ANO-08, F-ANO-09 |

</details>

<details>
<summary><b>Rapports, exports et Mobile Money</b></summary>

| Route | Rôle requis | Exigence |
|---|---|---|
| `GET /api/rapport-assemblee` | authentifié | F-RAP-05 |
| `GET /api/exports/journal.csv` | bureau | F-RAP-06 |
| `GET /api/exports/membres.csv` | bureau | F-RAP-06 |
| `GET /api/exports/rapport.csv` | authentifié | F-RAP-06 |
| `GET /api/releves` | bureau | F-TRX-06 |
| `POST /api/releves` | trésorier | F-TRX-06 |
| `GET /api/releves/:id/rapprochement` | bureau | F-TRX-06 |
| `POST /api/archivage` | président | F-GRP-06 |

</details>

<details>
<summary><b>Notifications</b></summary>

| Route | Rôle requis | Exigence |
|---|---|---|
| `GET /api/notifications` | bureau | F-NOT |
| `GET /api/notifications/mes-notifications` | authentifié | F-NOT |
| `POST /api/notifications/balayage` | trésorier, président | F-NOT-01, F-COT-06 |
| `POST /api/notifications/accuse-versement` | trésorier | F-NOT-02 |
| `POST /api/notifications/expedition` | trésorier, président | F-NOT-04, F-NOT-05 |
| `GET /api/historique` | authentifié | N-TRC-01 |
| `GET /api/historique/synthese` | authentifié | N-TRC-01 |
| `GET /api/historique/membre/:id` | bureau | N-TRC-01 |
| `GET /api/historique/acces` | commissaire | N-SEC-06 |

</details>

<details>
<summary><b>Reprise d'un cahier</b></summary>

| Route | Rôle requis | Exigence |
|---|---|---|
| `POST /api/import/apercu` | président, trésorier | — |
| `POST /api/import` | président, trésorier | — |
| `GET /api/import` | authentifié | N-TRC-01 |

`apercu` n'écrit rien : elle rend ce que l'import ferait. Le journal étant
immuable, voir avant de valider est la seule protection réelle du trésorier.

L'historique des imports est ouvert à **tout membre** : savoir qu'une partie
des chiffres vient d'un cahier papier plutôt que d'une saisie contrôlée dit
quelle confiance leur accorder, et cette information appartient au groupe.

</details>

**Le journal n'est pas exposé aux membres** : un membre lit son relevé en
langage courant, jamais le mécanisme comptable (N-USG-05). De même, les
anomalies sont réservées au bureau — donner à chacun la liste des écarts
constatés sur ses pairs transformerait un outil de contrôle mutuel en instrument
de surveillance réciproque.

---

## L'interface

Servie par l'API elle-même à **http://localhost:3100/**, en fichiers statiques.

| Écran | Contenu | Visible par |
|---|---|---|
| **Saisir** | Versement en deux gestes, montant prérempli au reste dû | trésorier |
| **Impayés** | Qui doit quoi, dispenses comprises | trésorier |
| **Situation** | Caisse, recouvrement, tour courant, ma situation | tous |
| **Membres** | Qui a versé combien, qui reste devoir | tous |
| **Tours** | Ordre de passage et remise de la cagnotte | ROSCA |
| **Prêts** | Encours, demandes à étudier, échéanciers | ASCA |
| **Aides** | Demandes, décisions, versements | Mutuelle |
| **Rapport** | Rapport d'assemblée et export tableur | tous |
| **À vérifier** | Anomalies ouvertes et déjà justifiées | bureau |
| **Mobile Money** | Rapprochement d'un relevé d'opérateur | trésorier |
| **Opérations** | Historique, annulations barrées mais visibles | bureau |

**Les onglets suivent le mécanisme du groupe.** « Tours » n'apparaît qu'en
ROSCA, « Prêts » qu'en ASCA, « Aides » qu'en mutuelle. Afficher un onglet
« Prêts » à une tontine rotative promettrait une fonction qui n'existe pas pour
elle — et que la base refuserait.

**Ni React, ni dépendance.** N-USG-02 impose moins de 100 ko par écran utile :
un bundle React minimal dépasse 140 ko avant la première ligne de code métier.

**Le code est découpé en modules ES chargés à la demande**, et ce qui compte
n'est plus le total mais ce qu'un utilisateur donné télécharge vraiment :

| Profil | Chargé | Marge |
|---|---|---|
| Membre — ROSCA | 67,0 ko | +33,0 ko |
| Trésorière — ROSCA | 73,2 ko | +26,8 ko |
| Président — groupe neuf | 80,5 ko | +19,5 ko |

Un groupe ROSCA ne télécharge jamais les écrans de prêts ni d'aides — son type
est arrêté à sa création et la base refuserait ces objets. Un simple membre ne
charge ni les anomalies ni le rapprochement Mobile Money : dans un groupe de
douze, onze personnes sont dans ce cas. La reprise de cahier (9 ko) ne part que
pour un président dont le groupe n'a pas encore de cycle.

```bash
python3 scripts/poids-interface.py     # ce que chaque profil télécharge
python3 scripts/verifier-modules.py    # cohérence du découpage
```

Le second script vérifie qu'un module différé existe, qu'il est dans la
COQUILLE du Service Worker (sans quoi l'écran marcherait en ligne et
casserait hors ligne), qu'il exporte bien la fonction que le registre nomme,
et que sa syntaxe est valide.

La seule étape de construction retire les commentaires du code servi
(`scripts/construire-web.py`). Ces commentaires expliquent pourquoi le bouton
de remise est absent plutôt que grisé ; les garder dans la source et les
retirer du fichier servi évite d'avoir à choisir. L'API sert `web-servi/` s'il
existe, `web/` sinon — un dépôt fraîchement cloné fonctionne sans rien
construire.

Corollaire assumé : pas de composants, pas de JSX. Le rendu se fait par
fonctions qui produisent du HTML.

Le vocabulaire est tenu sans exception (N-USG-05) : on *annule* un versement, on
ne passe pas d'écriture inverse ; on lit « il reste 15 000 F à verser », pas
« échéance partielle ».

---

## Comptes de démonstration

Mot de passe commun : **`tontine2026`**.

**Trois groupes coexistent sur la même base**, un par mécanisme. C'est la seule
configuration où le cloisonnement (N-SEC-02) et la cohérence de type sont
réellement mis à l'épreuve : tant qu'un seul groupe existe, aucune fuite
transversale n'est observable.

| Groupe | Téléphone | Membre | Rôle |
|---|---|---|---|
| **ROSCA** — Tontine des Femmes de Bonabéri<br>*12 membres, cycle au tour 3* | `+237690110001` | Awa Ndiaye | présidente |
| | `+237690110002` | Marie Ebolo | **trésorière** |
| | `+237690110003` | Fatou Bâ | commissaire |
| **ASCA** — Caisse d'épargne des Jeunes de Deido<br>*8 membres, 1 prêt en cours* | `+237677220001` | Émile Njoya | président |
| | `+237677220002` | Patrick Mbappé | trésorier |
| **MUTUELLE** — Association Solidarité de Bafoussam<br>*10 membres, 3 aides* | `+237699330001` | Pauline Kamdem | présidente |
| | `+237699330002` | Joseph Tagne | trésorier |

Les trois jeux ont des **dates relatives au jour de chargement** : un décor aux
dates figées vieillit et met en défaut les règles de détection qu'il sert à
illustrer.

---

## Arborescence

```
tontine-platform/
├── api/              API NestJS — 52 routes, 151 tests d'intégration
│   └── src/
│       ├── base/            Pool pg, transactions, vérification R-02
│       ├── authentification/ Jeton, gardes globales, session
│       ├── cotisations/     Versements, annulations, dispenses
│       ├── groupes/         Membres, tours, tableau de bord, journal
│       ├── prets/           Demandes, décisions, remboursements
│       ├── aides/           Demandes, décisions, versements
│       ├── anomalies/       Balayage, levées
│       ├── rapports/        Assemblée, exports, Mobile Money
│       ├── historique/      Trace immuable des opérations
│       ├── import/          Reprise d'un cahier : analyse CSV, aperçu
│       └── notifications/   File, client SMTP, planificateur de rappels
├── db/
│   ├── migrations/   19 fichiers, numérotés, idempotents
│   │   ├── 001–003   Socle, journal en partie double, cycle ROSCA
│   │   ├── 004       Utilisateurs et journal d'accès
│   │   ├── 005–007   Cotisations, tour de rôle, restitution
│   │   ├── 008–009   Épargne et prêts ASCA, aides mutualistes
│   │   ├── 010–011   Moteur d'anomalies, métier des prêts et aides
│   │   ├── 012–014   Fin de cycle, Mobile Money, rapports et exports
│   │   ├── 015–017   Notifications, historique immuable et ses déclencheurs
│   │   ├── 018       Index de performance, calcul des soldes
│   │   └── 019       Reprise d'un cahier existant
│   ├── seeds/        4 fichiers — un groupe par mécanisme, dates relatives
│   └── recette/      3 scénarios d'acceptation, un par jalon
├── web/              Interface — modules ES, aucune dépendance
│   ├── index.html    Structure des écrans
│   ├── style.css     Téléphone d'abord, polices système
│   ├── app.js        Noyau : session, navigation, hors-ligne, écrans communs
│   ├── sw.js         Service Worker — ouvre l'application sans réseau
│   ├── ecrans-rosca.js     Tour de rôle        ┐ un seul des trois est
│   ├── ecrans-asca.js      Prêts               │ chargé : le type du
│   ├── ecrans-mutuelle.js  Aides               ┘ groupe est définitif
│   ├── ecrans-bureau.js    Anomalies, Mobile Money — jamais pour un membre
│   └── ecran-import.js     Reprise de cahier — une fois par groupe
├── docs/
│   ├── cahier-des-charges.md     Exigences codées (F-COT-02, R-01…)
│   ├── conception-interface.md   Écrans, enchaînement, vocabulaire
│   ├── modele-de-donnees.md      MCD, dictionnaire, invariants
│   ├── detection-anomalies.md    Règles et seuils
│   ├── uml/                      11 diagrammes PlantUML + leurs images
│   ├── diagrammes/               Schémas d'appoint
│   └── decisions/                Décisions d'architecture argumentées
└── scripts/
    ├── db.sh              Pilotage de la base de développement
    ├── construire-web.py  Retire les commentaires du code servi
    ├── poids-interface.py Ce que chaque profil télécharge (N-USG-02)
    ├── verifier-modules.py Cohérence du découpage en modules
    ├── generer-uml.sh     Rend les diagrammes PlantUML en images
    ├── essai-hors-ligne.js  Éprouve le hors-ligne dans Chromium
    ├── essai-import.js      Éprouve la reprise de cahier dans Chromium
    └── dossier-pdf.py       Assemble la documentation en un PDF
```

### Commandes disponibles

```
./scripts/db.sh demarrer        Conteneur, migrations, jeux de données
./scripts/db.sh arreter         Arrête en conservant les données
./scripts/db.sh reinitialiser   Vide le schéma et réapplique tout
./scripts/db.sh verifier        Éprouve les invariants : tente des violations
./scripts/db.sh recette         Jalon 1 — cycle ROSCA complet
./scripts/db.sh recette-jalon2  Jalon 2 — prêts, aides, anomalies
./scripts/db.sh recette-jalon3  Jalon 3 — rapports, Mobile Money
./scripts/db.sh console         Console psql
./scripts/db.sh tester          Vérifie la connexion
./scripts/db.sh supprimer       Supprime le conteneur (confirmation demandée)
```

---

## Dépannage

> **« Site inaccessible » dans le navigateur ?** C'est presque toujours la base
> qui s'est arrêtée : l'API ne peut pas s'y connecter, et s'interrompt au
> démarrage sans jamais écouter le port. Vérifiez d'abord le conteneur —
> `docker ps -a --filter name=tontine-db` — puis relancez dans l'ordre :
>
> ```bash
> ./scripts/db.sh demarrer     # d'abord la base
> cd api && npm run dev        # ensuite l'API
> ```
>
> L'API annonce trois lignes quand tout va bien. Si elles n'apparaissent pas,
> le problème est en amont :
>
> ```
> [BaseService] Connecté en tant que « tontine_app »
> [BaseService] R-02 vérifié : journal non modifiable par ce rôle
> [Démarrage]   API à l'écoute sur http://localhost:3100/api
> ```

| Symptôme | Cause probable | Remède |
|---|---|---|
| **Site inaccessible** | Conteneur arrêté — l'API n'a pas pu joindre la base | `./scripts/db.sh demarrer` puis relancer l'API |
| `EADDRINUSE :::3100` | Une instance tourne déjà | `pkill -f "api/node_modules/.bin/nest"` |
| `ECONNREFUSED …:55433` | Base arrêtée | `./scripts/db.sh demarrer` |
| `npm run dev` tourne mais rien ne répond | Démarré avant la base : `--watch` maintient le processus sans serveur | Arrêter, démarrer la base, relancer |
| Tests en échec au 2ᵉ passage | Le décor a été consommé | `./scripts/db.sh reinitialiser` |
| `JWT_SECRET is not defined` | `.env` absent | `cp .env.example .env` dans `api/` |
| `permission denied for table…` | Migrations partiellement appliquées | `./scripts/db.sh reinitialiser` |
| La page ne charge pas | API non démarrée | `cd api && npm run dev` |
| `connection refused` port 55433 | Conteneur arrêté | `./scripts/db.sh demarrer` |
| Aucune anomalie détectée | Le décor est sain — c'est normal | Onglet **À vérifier** → *Relancer la vérification* |

**Repartir totalement de zéro :**

```bash
./scripts/db.sh supprimer && ./scripts/db.sh demarrer
```

---

## Ce qui n'est pas fait

Quatre limites, énoncées plutôt que masquées.

**Le courriel part, WhatsApp et SMS non.** Le client SMTP est écrit et éprouvé
contre un vrai serveur sur une vraie prise TCP : réponses multi-lignes,
STARTTLS, authentification PLAIN et LOGIN, encodage MIME des sujets accentués,
distinction entre refus définitif (5xx) et temporaire (4xx). Il n'a en revanche
jamais parlé à Gmail ni à un hébergeur réel — aucun n'était joignable depuis
l'environnement de développement. Ce qui est prouvé, c'est que le protocole est
correctement parlé.

WhatsApp et SMS supposent une passerelle payante et une clé d'API. L'expéditeur
SMTP **refuse explicitement** ces canaux : le message est mis en échec avec un
motif lisible et reste en file, plutôt que d'être marqué « envoyé » sans que
personne ne l'ait reçu. Brancher une passerelle ne touche qu'un fichier —
`notifications.module.ts`.

**L'import ne couvre que les ROSCA.** Un cahier d'ASCA porte des prêts avec
échéanciers et intérêts, une mutuelle des demandes d'aide et leurs
délibérations. Ni l'un ni l'autre ne se réduit à la forme « qui a versé combien,
quand » d'un cahier de tontine ; prétendre les importer produirait des groupes
amputés dont personne ne verrait ce qui manque.

**Les diagrammes en images dans le PDF.** `scripts/dossier-pdf.py` assemble la
documentation en un PDF de 48 pages. Les 11 diagrammes y figurent en source
Mermaid, faute d'avoir pu installer `@mermaid-js/mermaid-cli` (réseau
intermittent). Le script les rendra en images dès que l'outil sera disponible,
sans modification.

**L'usage réel.** La plateforme n'a jamais tourné avec un vrai groupe. Les jeux
de démonstration sont construits pour éprouver les règles, pas pour refléter la
diversité des pratiques — enchères pour l'ordre de passage, cotisations
saisonnières, groupes de plus de cinquante membres.

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
- **Migrations idempotentes** — ré-exécutables sans effet de bord. Il n'existe
  pas de table de suivi : l'ordre et l'idempotence en tiennent lieu.

---

## Documentation

| Document | Objet |
|---|---|
| [Cahier des charges](docs/cahier-des-charges.md) | Acteurs, exigences codées, règles de gestion, jalons |
| [Conception de l'interface](docs/conception-interface.md) | Écrans, enchaînement, vocabulaire employé |
| [Modèle de données](docs/modele-de-donnees.md) | Schéma, dictionnaire, invariants |
| [Détection d'anomalies](docs/detection-anomalies.md) | Règles, seuils, gravités |
| [Diagrammes UML](docs/uml/images/) | **Images PNG** — cas d'utilisation, séquences, états, classes |
| [Sources des diagrammes](docs/uml/) | Fichiers PlantUML, régénérables hors ligne |
| [Diagrammes (Markdown)](docs/diagrammes/) | Mêmes diagrammes commentés, en Mermaid |
| [Décisions](docs/decisions/) | Arbitrages d'architecture et alternatives écartées |

### Diagrammes UML

Onze diagrammes en **notation UML standard**, rendus en PNG :

| Diagramme | Type UML | Ce qu'il montre |
|---|---|---|
| `cas-utilisation.png` | Cas d'utilisation | Qui fait quoi — acteurs, cas, relations `<<include>>` |
| `sequence-cotisation.png` | Séquence | Enregistrer un versement, de la saisie au journal |
| `sequence-cagnotte.png` | Séquence | Remise de la cagnotte, avec les deux refus possibles |
| `sequence-anomalie.png` | Séquence | Détection en tâche de fond, puis notification |
| `etats-cycle.png` | États-transitions | Cycle de vie d'un cycle |
| `etats-echeance.png` | États-transitions | Cycle de vie d'une échéance |
| `etats-pret.png` | États-transitions | Cycle de vie d'un prêt |
| `etats-anomalie.png` | États-transitions | Détection, vérification, levée |
| `classes.png` | Classes | Socle commun et trois spécialisations |
| `classes-journal.png` | Classes | Le cœur comptable — écriture, ligne, compte |
| `enumerations.png` | Classes | Les onze énumérations du domaine |

```bash
./scripts/generer-uml.sh        # régénère les 11 PNG depuis docs/uml/*.puml
```

**PlantUML plutôt que Mermaid.** Mermaid ne dispose pas de diagramme de cas
d'utilisation — il fallait le simuler par un graphe orienté, perdant la
notation UML. PlantUML produit la notation standard et rend **hors ligne**,
sans dépendance réseau.

**Dossier complet en PDF** : `python3 scripts/dossier-pdf.py` assemble les onze
documents en un seul fichier de 49 pages — page de garde, sommaire, et les
**onze diagrammes en images**, plus aucune source illisible.

---

## État du projet

| Domaine | État |
|---|---|
| Conception | ✅ Cahier des charges, modèle, diagrammes, 3 décisions |
| Schéma | ✅ 23 tables, 255 fonctions, 12 vues, 19 migrations idempotentes |
| Métier ROSCA | ✅ Cotisations, tour de rôle, corrections, dispenses |
| Métier ASCA | ✅ Épargne, prêts, échéanciers, rééchelonnement, redistribution |
| Métier Mutuelle | ✅ Aides, éligibilité consultative, versements |
| Anomalies | ✅ 6 règles, gravités, levées motivées |
| Rapports | ✅ Assemblée, exports CSV, rapprochement Mobile Money |
| Notifications | ⚠️ File et règles éprouvées — **envoi réel non implémenté** |
| API | ✅ 52 routes, 151 tests d'intégration |
| Interface | ✅ 13 écrans en modules ES, 67 ko pour un membre, hors ligne |

**Critère d'acceptation du jalon 1**, vérifié par `./scripts/db.sh recette` :
une tontine de 12 membres mène un cycle complet, la caisse reste équilibrée à
chaque tour, et tout écart est traçable.
