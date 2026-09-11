# Diagrammes de séquence

Ce document décrit la chronologie de trois opérations représentatives : l'enregistrement d'une
cotisation, la clôture d'un tour ROSCA, et la détection automatique d'une anomalie. Chacune traverse
les mêmes couches — interface, API, service métier, base — et chacune aboutit, lorsqu'elle déplace
de l'argent, à une écriture équilibrée au journal.

**Ce que ces diagrammes ne montrent pas** : ni la structure des données
(voir [`classes.md`](classes.md)), ni les états intermédiaires exhaustifs
(voir [`etats.md`](etats.md)), ni les détails d'authentification. Le groupe est systématiquement
déduit du jeton porté par l'appel, jamais d'un paramètre d'URL (N-SEC-03) ; ce contrôle est implicite
dans tous les diagrammes ci-dessous.

Référence transverse : [cahier des charges](../cahier-des-charges.md) et
[décision 0003](../decisions/0003-journal-partie-double.md).

---

## 1. Enregistrer une cotisation

Le trésorier a reçu un versement hors application — en espèces ou par Mobile Money. Il vient
l'inscrire au registre. L'opération doit tenir en moins de 30 secondes (N-USG-04) et produire une
écriture équilibrée dont la base, et non l'application, garantit l'équilibre (N-INT-02).

Le point central du diagramme est l'étape de validation : l'insertion des lignes précède la
vérification, qui s'exécute à la validation de la transaction. Un déséquilibre n'est pas corrigé,
il est rejeté, et la transaction entière est annulée.

```mermaid
sequenceDiagram
    autonumber
    actor TRE as Tresorier
    participant UI as Interface web
    participant API as API NestJS
    participant SVC as Service Cotisation
    participant DB as PostgreSQL
    participant TRG as Declencheur SQL
    participant NOT as Service Notification

    TRE->>UI: Selectionne le membre et saisit montant, date, moyen
    UI->>UI: Controle de surface -- entier positif, date non future
    UI->>API: POST /cotisations avec jeton
    API->>API: Verifie habilitation tresorier cote serveur
    Note over API: Le groupe est deduit du jeton, jamais de l URL

    API->>SVC: enregistrerVersement(membre, montant, date, moyen)
    SVC->>DB: SELECT echeance ouverte la plus ancienne
    DB-->>SVC: echeance, montant_appele, reliquat
    SVC->>SVC: Controle montant strictement positif
    SVC->>SVC: Determine comptes -- caisse selon moyen, cotisation du membre

    SVC->>DB: BEGIN
    activate DB
    SVC->>DB: INSERT ecriture -- libelle, nature COTISATION, auteur, horodatage
    DB-->>SVC: ecriture_id
    SVC->>DB: INSERT ligne_ecriture -- DEBIT caisse, montant
    SVC->>DB: INSERT ligne_ecriture -- CREDIT cotisation membre, montant
    SVC->>DB: INSERT cotisation -- rattachee a l echeance et a l ecriture
    SVC->>DB: UPDATE echeance -- nouvel etat selon reliquat

    SVC->>DB: COMMIT
    DB->>TRG: Verification differee de l equilibre
    activate TRG
    TRG->>TRG: Somme des debits comparee a la somme des credits

    alt Ecriture equilibree
        TRG-->>DB: Validation acceptee
        deactivate TRG
        DB-->>SVC: COMMIT reussi
        deactivate DB
        SVC-->>API: cotisation enregistree, reliquat calcule
        API-->>UI: 201 Created
        UI-->>TRE: Confirmation en langage courant, sans debit ni credit
        SVC->>NOT: Accuse de reception au membre cotisant
        NOT-->>SVC: file d attente, envoi en plage horaire decente
    else Ecriture desequilibree
        TRG-->>DB: EXCEPTION -- ecriture rejetee
        DB-->>SVC: ROLLBACK integral
        SVC-->>API: Erreur technique
        API-->>UI: 500 -- aucune donnee ecrite
        UI-->>TRE: Echec de l enregistrement, reessayer
        Note over SVC,DB: Ni ecriture, ni ligne, ni imputation ne subsistent
    end
```

### Points d'attention

- **Le rejet est total, jamais partiel.** L'ensemble — écriture, lignes, cotisation, mise à jour de
  l'échéance — vit dans une seule transaction (N-INT-04). Une écriture sans ses lignes, ou une
  cotisation sans son écriture, serait un état incohérent dont le journal ne se relèverait pas.
- **Le déclencheur s'exécute à la validation, pas à chaque insertion.** Une contrainte évaluée ligne
  à ligne rejetterait la première ligne d'une écriture forcément déséquilibrée à cet instant.
  L'équilibre n'a de sens que sur l'écriture complète : la vérification est donc différée au `COMMIT`.
- **Un déséquilibre est un défaut du service, jamais une erreur de l'utilisateur.** Le trésorier
  saisit un montant, pas des débits et des crédits. Le message d'erreur ne doit jamais l'exposer à
  un vocabulaire comptable (N-USG-05).
- **La notification sort de la transaction.** L'accusé de réception (F-NOT-02) est mis en file après
  validation. Envoyer dans la transaction lierait la durabilité de l'écriture à la disponibilité
  d'un service externe, et respecter la plage horaire décente (F-NOT-06) exige de différer.
- **La détection d'anomalies n'intervient pas ici.** Elle est asynchrone (N-PRF-03). Une double
  saisie probable (F-ANO-05) sera signalée plus tard, sans jamais bloquer la saisie.

---

## 2. Clôturer un tour ROSCA et remettre la cagnotte

À chaque tour, un seul membre reçoit la totalité de la cagnotte. La caisse est vidée : son solde
théorique retombe à zéro. La séquence enchaîne une vérification d'encaissement, un calcul de
cagnotte, une écriture de remise et le passage au tour suivant.

L'ordre compte : on ne remet jamais une cagnotte avant d'avoir vérifié que toutes les cotisations du
tour sont effectivement encaissées. Remettre sur la foi des montants attendus reviendrait à
distribuer de l'argent qui n'est pas dans la caisse.

```mermaid
sequenceDiagram
    autonumber
    actor TRE as Tresorier
    participant UI as Interface web
    participant API as API NestJS
    participant SVC as Service Tour ROSCA
    participant CPT as Service Comptabilite
    participant DB as PostgreSQL
    participant TRG as Declencheur SQL
    participant NOT as Service Notification

    TRE->>UI: Ouvre le tour courant et demande la remise
    UI->>API: POST /tours/{id}/remise avec jeton
    API->>SVC: cloturerTour(tour_id, auteur)

    SVC->>DB: SELECT echeances du tour et montants encaisses
    DB-->>SVC: liste des echeances avec reliquat

    alt Toutes les cotisations encaissees
        SVC->>SVC: cagnotteEncaissee egale somme des cotisations du tour
        SVC->>CPT: soldeCaisseA(date du jour)
        CPT->>DB: SELECT somme des lignes du compte caisse
        DB-->>CPT: solde recalcule depuis le journal
        CPT-->>SVC: solde disponible
        SVC->>SVC: Controle cagnotte inferieure ou egale au solde disponible

        SVC->>DB: BEGIN
        activate DB
        SVC->>DB: INSERT ecriture -- nature REMISE_CAGNOTTE, auteur, horodatage
        SVC->>DB: INSERT ligne_ecriture -- DEBIT cotisations du tour, montant cagnotte
        SVC->>DB: INSERT ligne_ecriture -- CREDIT caisse, montant cagnotte
        SVC->>DB: UPDATE tour -- date_remise, montant_cagnotte, etat SOLDE
        SVC->>DB: COMMIT
        DB->>TRG: Verification de l equilibre
        activate TRG
        TRG-->>DB: Validation acceptee
        deactivate TRG
        DB-->>SVC: COMMIT reussi
        deactivate DB

        SVC->>DB: SELECT tour suivant par rang croissant
        alt Un tour suivant existe
            DB-->>SVC: tour de rang superieur
            SVC->>DB: UPDATE tour suivant -- etat EN_COURS
            SVC->>NOT: Informe le prochain beneficiaire
        else Tous les membres ont beneficie
            DB-->>SVC: aucun tour restant
            SVC->>DB: UPDATE cycle -- etat CLOTURE
            Note over SVC,DB: Le cycle s acheve, solde theorique de caisse a zero
        end

        SVC-->>API: tour solde, prochain beneficiaire
        API-->>UI: 200 OK
        UI-->>TRE: Confirmation et rappel du prochain beneficiaire

    else Cotisations manquantes
        SVC-->>API: Remise refusee, liste des membres en defaut
        API-->>UI: 409 Conflict
        UI-->>TRE: Remise impossible, N echeances restent impayees
        SVC->>NOT: Signale les impayes au tresorier
        Note over SVC: Aucune ecriture n est produite
    end
```

### Points d'attention

- **La cagnotte remise est la somme réellement encaissée, pas la somme attendue.** R-05 impose
  l'égalité entre les cotisations du tour et le montant remis. Calculer la cagnotte depuis les
  montants appelés créerait mécaniquement un déséquilibre dès la première cotisation partielle.
- **Le sens des écritures surprend au premier abord.** La remise débite les comptes de cotisations
  et crédite la caisse : l'argent sort de la caisse, les dettes du groupe envers les cotisants sont
  soldées. C'est l'inverse exact de l'écriture de cotisation, et c'est pourquoi le solde de caisse
  retombe à zéro à chaque tour, conformément au §3.1 du cahier des charges.
- **Le contrôle de solde disponible est une double sécurité.** Si toutes les cotisations sont
  encaissées, le solde suffit nécessairement. Le vérifier malgré tout détecte un écart comptable
  antérieur avant de distribuer de l'argent — c'est la même identité que celle qu'exploite F-ANO-04.
- **Un membre ne bénéficie qu'une fois par cycle.** R-04 est un index unique sur
  `(cycle_id, beneficiaire_id)` : la base refuse un second tour pour le même membre, quoi que fasse
  le service. F-TOU-05 est ainsi garanti par le schéma et non par une vérification applicative.
- **La clôture du cycle est une conséquence, pas une action.** Elle survient lorsque le dernier tour
  est soldé. Aucun acteur ne « clôture le cycle ROSCA » manuellement : le cycle s'achève quand tous
  les membres ont bénéficié.
- **Une permutation de bénéficiaires ne se fait jamais sur un tour soldé.** F-TOU-04 ne s'applique
  qu'aux tours à venir : permuter après remise réécrirait le passé.

---

## 3. Détecter et notifier une anomalie

La détection s'exécute en tâche de fond, sans jamais bloquer une saisie (N-PRF-03). Son principe est
une comparaison : le solde stocké ou attendu d'un côté, le solde recalculé depuis le journal de
l'autre. La partie double donne à cette comparaison son sens — sans vérité comptable de référence,
détecter une incohérence reviendrait à comparer une somme à elle-même.

Le scénario ci-dessous illustre F-ANO-04, l'incohérence de solde, qui est la plus structurante. Les
autres règles de détection suivent la même forme.

```mermaid
sequenceDiagram
    autonumber
    participant ORD as Ordonnanceur
    participant DET as Moteur de detection
    participant CPT as Service Comptabilite
    participant DB as PostgreSQL
    participant ANO as Service Anomalie
    participant NOT as Service Notification
    actor TRE as Tresorier
    actor CAC as Commissaire aux comptes

    ORD->>DET: Declenche le cycle de detection periodique
    DET->>DB: SELECT groupes actifs
    DB-->>DET: liste des groupes

    loop Pour chaque groupe
        DET->>CPT: recalculerSoldes(groupe)
        CPT->>DB: SELECT sommes debit et credit par compte
        DB-->>CPT: soldes recalcules depuis le journal
        CPT-->>DET: soldes de reference

        DET->>DB: SELECT soldes attendus -- epargne_membre, capital restant du
        DB-->>DET: valeurs denormalisees

        DET->>DET: Compare valeur attendue et solde recalcule

        alt Ecart detecte
            DET->>DET: Qualifie le type INCOHERENCE_SOLDE et la gravite
            DET->>ANO: creerAnomalie(type, gravite, comptes et ecritures concernes)
            ANO->>DB: SELECT anomalie ouverte de meme type et meme perimetre

            alt Aucun doublon ouvert
                ANO->>DB: INSERT anomalie -- etat DETECTEE, horodatage, description
                DB-->>ANO: anomalie_id
                ANO->>NOT: Alerte selon la gravite

                alt Gravite GRAVE
                    NOT->>TRE: Notification immediate
                    NOT->>CAC: Notification immediate
                    Note over NOT: F-ANO-09 -- le commissaire est toujours informe
                else Gravite FAIBLE ou MOYENNE
                    NOT->>TRE: Notification groupee, en plage horaire decente
                end

            else Anomalie identique deja ouverte
                ANO->>DB: UPDATE anomalie -- derniere occurrence, compteur
                Note over ANO,NOT: Pas de nouvelle notification, evite le harcelement
            end

        else Aucun ecart
            DET->>DB: SELECT anomalies ouvertes de ce type
            alt Ecart precedemment signale, desormais resorbe
                DET->>ANO: proposerLevee(anomalie, motif automatique)
                ANO->>NOT: Propose la levee au commissaire
                Note over ANO: La levee reste soumise a confirmation humaine
            end
        end
    end

    DET-->>ORD: Cycle de detection termine, compte rendu d execution
    CAC->>ANO: Consulte, verifie puis leve ou confirme
    ANO->>DB: UPDATE anomalie -- etat, motif, decideur, horodatage
```

### Points d'attention

- **La détection ne corrige jamais.** Elle signale. Une correction automatique produirait une
  écriture que personne n'a décidée, et la plateforme n'est pas une autorité d'arbitrage : la
  décision reste humaine.
- **La déduplication est indispensable.** Sans elle, un écart persistant génère une anomalie à chaque
  passage de l'ordonnanceur et noie le signal. Une anomalie ouverte de même type et de même périmètre
  est mise à jour, pas recréée, et ne déclenche pas de nouvelle notification.
- **La levée automatique est proposée, jamais appliquée.** Un écart résorbé n'est pas un écart
  expliqué. F-ANO-08 confie la justification à une personne : le système peut rédiger le motif, il ne
  peut pas l'endosser.
- **Le vocabulaire des notifications est contraint.** « À vérifier », jamais « fraude ». Une anomalie
  est une incohérence détectée, et la plupart s'expliquent par un décalage de saisie.
- **La gravité pilote le circuit, pas seulement l'affichage.** F-ANO-09 réserve la notification
  immédiate du commissaire aux anomalies graves. Notifier tout le monde de tout revient à ne notifier
  personne de rien.
- **Comparer un solde dénormalisé à son recalcul suppose que le dénormalisé existe.** Là où aucune
  valeur n'est stockée — la caisse, le fonds d'aide — F-ANO-04 se vérifie autrement : par les
  identités propres au mécanisme, solde de caisse nul après remise en ROSCA, avoir égal à la somme
  des épargnes en ASCA, fonds égal aux cotisations moins les aides en mutuelle.
- **Le moteur lit beaucoup et écrit peu.** N-PRF-02 impose un solde calculé en moins de 100 ms sur
  10 000 écritures : les index sur `ligne_ecriture(compte_id, ...)` conditionnent la faisabilité
  d'une détection périodique sur l'ensemble des groupes.
