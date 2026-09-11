# Détection d'anomalies

> **Version** 1.0 — 11 septembre 2026
> **Exigences couvertes** : F-ANO-01 à F-ANO-09
> **Documents liés** : [cahier des charges](cahier-des-charges.md) · [modèle de données](modele-de-donnees.md) · [décision 0003](decisions/0003-journal-partie-double.md)

Ce document définit les règles de détection, leurs seuils et leur gravité.

---

## 1. Principes

### Une anomalie est un signalement, jamais une accusation

C'est le principe directeur, et il gouverne jusqu'au vocabulaire de l'interface :
« à vérifier », jamais « fraude » ni « erreur ». Une tontine repose sur la
confiance ; un outil qui désignerait un coupable détruirait ce qu'il prétend
protéger. La plateforme constate un écart et le soumet à un humain — **la
décision reste humaine**.

### Toute anomalie doit pouvoir être levée

Une levée exige un motif, et reste consignée (F-ANO-08). Une anomalie levée
n'est pas effacée : elle fait partie de la piste d'audit, au même titre qu'une
écriture inverse. Savoir *qu'un écart a été constaté puis justifié* vaut souvent
plus que l'écart lui-même.

### Le journal comptable est la référence

La détection n'a de sens que parce qu'il existe une vérité vérifiable à laquelle
se comparer. Sans partie double, comparer un solde à lui-même ne prouverait rien
(voir [décision 0003](decisions/0003-journal-partie-double.md)).

### La détection ne bloque jamais la saisie

Elle s'exécute en tâche de fond (N-PRF-03). Un trésorier qui enregistre un
versement inhabituel ne doit pas être empêché : il est peut-être dans son droit.
Le signalement arrive après, à qui de droit.

---

## 2. Gravités

| Gravité | Signification | Traitement |
|---|---|---|
| `INFORMATION` | Écart explicable, à connaître | Tableau de bord |
| `AVERTISSEMENT` | Écart demandant une vérification | Tableau de bord + trésorier |
| `CRITIQUE` | Incohérence comptable ou risque financier | Notification immédiate au trésorier **et** au commissaire (F-ANO-09) |

> **Pourquoi notifier deux personnes en cas d'incohérence critique.** Le
> signalement ne doit pas transiter uniquement par celui dont il questionne la
> saisie. Ce n'est pas une présomption de mauvaise foi : c'est le principe du
> contrôle mutuel, qui protège aussi le trésorier en attestant qu'il n'a rien
> dissimulé.

---

## 3. Règles de détection

### F-ANO-01 — Cotisation manquante

**Déclenchement** : échéance `ATTENDUE` ou `PARTIELLE` dont `date_echeance` est
dépassée d'un délai de grâce.

| Condition | Gravité |
|---|---|
| 1 échéance, retard < 1 période | `INFORMATION` |
| Retard ≥ 1 période | `AVERTISSEMENT` |
| ≥ 3 échéances impayées, ou membre bénéficiaire ROSCA déjà servi | `CRITIQUE` |

**Délai de grâce** : 3 jours pour une périodicité hebdomadaire, 7 jours au-delà.

> **Le cas ROSCA aggravé.** Un membre qui a déjà reçu sa cagnotte et cesse de
> cotiser fait peser le risque sur ceux qui ne sont pas encore passés. C'est le
> mode de défaillance classique des tontines rotatives — d'où la gravité relevée.

```sql
-- Les échéances dépassées, avec l'antériorité du membre
SELECT e.id, e.membre_id, e.date_echeance,
       e.montant_attendu - e.montant_regle AS reliquat,
       CURRENT_DATE - e.date_echeance      AS jours_retard
FROM echeance e
WHERE e.statut IN ('ATTENDUE', 'PARTIELLE')
  AND e.date_echeance < CURRENT_DATE - INTERVAL '7 days';
```

### F-ANO-02 — Remboursement en retard

**Déclenchement** : `echeance_pret` non réglée après sa date.

| Condition | Gravité |
|---|---|
| Retard < 15 jours | `AVERTISSEMENT` |
| Retard ≥ 15 jours, ou ≥ 2 échéances | `CRITIQUE` |

Le prêt passe alors au statut `EN_RETARD`, ce qui est une conséquence et non une
sanction : le groupe décide seul d'un rééchelonnement (F-PRE-07).

### F-ANO-03 — Montant inhabituel

**Déclenchement** : versement s'écartant nettement de l'historique du membre.

Règle : `|montant − médiane| > 3 × écart_médian_absolu`, sur au moins **6
versements** antérieurs.

> **Pourquoi la médiane et non la moyenne.** Une moyenne est tirée par les
> valeurs extrêmes : un seul versement exceptionnel déplace la référence et rend
> aveugle aux suivants. La médiane et l'écart médian absolu résistent aux
> valeurs aberrantes — ce sont précisément elles que l'on cherche.
>
> **Pourquoi un minimum de 6 versements.** En deçà, l'historique ne décrit rien
> et la règle produirait du bruit. Un nouveau membre ne doit pas être signalé
> simplement parce qu'il est nouveau.

| Condition | Gravité |
|---|---|
| Écart 3 à 5 × MAD | `INFORMATION` |
| Écart > 5 × MAD | `AVERTISSEMENT` |

Un versement **supérieur** à l'attendu est signalé comme un versement inférieur :
il peut révéler une double saisie ou une erreur de frappe (50 000 au lieu de
5 000).

### F-ANO-04 — Solde incohérent

**La règle la plus importante.** Elle vérifie que les soldes suivis coïncident
avec le journal comptable.

**Déclenchement** : divergence entre une valeur dénormalisée et son recalcul
depuis `ligne_ecriture`.

| Vérification | Comparaison |
|---|---|
| Échéance | `echeance.montant_regle` = Σ cotisations rattachées |
| Épargne ASCA | `epargne_membre.solde_calcule` = solde du compte `EPARGNE_MEMBRE` |
| Prêt | `pret.capital_restant_du` = solde du compte `CREANCE_PRET` |
| Cagnotte ROSCA (R-05) | `tour.montant_cagnotte` = Σ cotisations du tour |
| Caisse | solde `CAISSE` = Σ encaissements − Σ décaissements |

**Gravité : toujours `CRITIQUE`.** Aucun seuil de tolérance, pas même d'un
franc. En partie double, un écart d'un franc n'est pas un arrondi — c'est le
symptôme d'un mécanisme défaillant, et il ne peut que s'aggraver.

**Exception R-05.** L'écart entre cagnotte et cotisations peut être légitime
(dispense accordée). Il est signalé, non rejeté — le groupe justifie ou corrige.

```sql
-- Échéances dont le montant réglé diverge de la somme des cotisations
SELECT e.id, e.montant_regle, COALESCE(SUM(c.montant), 0) AS somme_reelle
FROM echeance e
LEFT JOIN cotisation c ON c.echeance_id = e.id
GROUP BY e.id, e.montant_regle
HAVING e.montant_regle <> COALESCE(SUM(c.montant), 0);
```

### F-ANO-05 — Double saisie probable

**Déclenchement** : deux cotisations du même membre, même montant, saisies à
moins de 10 minutes d'intervalle pour la même échéance.

| Condition | Gravité |
|---|---|
| Même montant, < 10 min, même échéance | `AVERTISSEMENT` |
| Idem avec référence Mobile Money identique | `CRITIQUE` |

> **Une référence Mobile Money identique ne laisse pas de doute** : une même
> transaction ne peut pas être encaissée deux fois. C'est le seul cas où la
> détection est certaine plutôt que probable.

### F-ANO-06 — Saisie tardive ou antidatée

**Déclenchement** : écart important entre `date_operation` et `cree_le`.

| Condition | Gravité |
|---|---|
| Saisie 7 à 30 jours après l'opération | `INFORMATION` |
| Saisie > 30 jours après | `AVERTISSEMENT` |
| `date_operation` postérieure à la date du jour | `CRITIQUE` |

> **Le futur est impossible, pas improbable.** Une opération datée de demain
> relève de l'erreur de frappe ou de la manipulation ; dans les deux cas, elle
> fausse toute situation de caisse à date (F-TRX-04).

La saisie tardive n'est pas fautive — un trésorier rattrape souvent son retard
en bloc. Elle est signalée parce qu'elle dégrade la fiabilité des situations
intermédiaires.

---

## 4. Exécution

| Règle | Moment |
|---|---|
| F-ANO-04 (solde incohérent) | Après chaque écriture, et en balayage quotidien |
| F-ANO-05 (double saisie) | À la saisie, sur les 10 dernières minutes |
| F-ANO-03 (montant inhabituel) | À la saisie |
| F-ANO-01, F-ANO-02 (retards) | Balayage quotidien |
| F-ANO-06 (saisie tardive) | À la saisie |

**Non-duplication.** Un index unique partiel empêche de recréer une anomalie
identique déjà ouverte : sans quoi chaque balayage quotidien rejouerait les mêmes
signalements et noierait les nouveaux.

**Fermeture automatique.** Une anomalie de retard se clôt d'elle-même lorsque le
versement intervient — avec mention de la régularisation. Une anomalie
`CRITIQUE` de solde, jamais : elle exige une décision humaine explicite.

---

## 5. Ce que la détection ne fait pas

- **Elle ne bloque aucune saisie.** Un versement inhabituel reste enregistrable.
- **Elle ne désigne personne.** Elle décrit un écart, pas une responsabilité.
- **Elle ne corrige rien automatiquement.** Toute correction passe par une
  écriture inverse motivée (F-COT-05).
- **Elle n'utilise pas d'apprentissage automatique.** Des règles explicites et
  des statistiques robustes suffisent, et surtout restent **explicables** : un
  trésorier doit comprendre *pourquoi* il est alerté. Un modèle opaque
  produirait des signalements invérifiables, exactement le contraire du but
  poursuivi.

---

## 6. Évolutions envisagées

| Piste | Intérêt | Réserve |
|---|---|---|
| Saisonnalité des cotisations | Un retard en période de soudure est attendu | Demande plusieurs cycles d'historique |
| Score de régularité par membre | Anticiper une défaillance | Risque de stigmatisation — à manier avec prudence |
| Rapprochement Mobile Money (F-TRX-06) | Vérification par une source externe | Dépend du format des relevés |
| Détection de schémas collectifs | Repérer une défaillance de groupe | Faible volume de données par groupe |
