-- =============================================================================
-- 018 — Index sur les clés étrangères, et soldes à grande échelle
--
-- CE FICHIER RÉPOND À DEUX MESURES, PAS À UNE INTUITION.
--
-- MESURE 1 — 35 clés étrangères sans index.
--
-- PostgreSQL n'indexe PAS automatiquement le côté référençant d'une clé
-- étrangère (contrairement à la clé primaire référencée). Conséquence : à
-- chaque suppression dans la table parente, il doit parcourir la table enfant
-- ENTIÈRE pour vérifier qu'aucune ligne n'y fait référence.
--
-- Invisible à 30 membres. À 500 membres et 100 000 écritures, radier un membre
-- déclencherait une dizaine de parcours complets.
--
-- MESURE 2 — v_solde_compte parcourt tout le journal.
--
-- EXPLAIN ANALYZE à 10 077 écritures : « Seq Scan on ligne_ecriture, rows=20167 »
-- même filtrée sur un seul groupe. L'index sur compte_id existe, mais le
-- planificateur l'ignore : le filtre porte sur `compte.groupe_id`, appliqué
-- APRÈS l'agrégation. Il a raison au volume actuel (21 ms), et il aura tort en
-- croissant.
--
-- CE QUE CE FICHIER NE FAIT PAS : créer une vue matérialisée des soldes. Ce
-- serait rétablir exactement ce que la partie double a supprimé — un solde
-- stocké qui peut diverger. La fonction ci-dessous recalcule, elle ne mémorise
-- pas.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Index sur les clés étrangères
--
-- Un par colonne référençante dépourvue d'index. Tous en `IF NOT EXISTS` :
-- certains existent déjà pour d'autres raisons, et les recréer échouerait.
-- -----------------------------------------------------------------------------

-- Journal comptable — les plus sollicités, car toute opération y aboutit.
CREATE INDEX IF NOT EXISTS ecriture_saisi_par_idx        ON ecriture (saisi_par);
CREATE INDEX IF NOT EXISTS ecriture_corrigee_idx         ON ecriture (ecriture_corrigee_id)
    WHERE ecriture_corrigee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS compte_membre_idx             ON compte (membre_id)
    WHERE membre_id IS NOT NULL;

-- Cotisations et échéances.
CREATE INDEX IF NOT EXISTS cotisation_saisi_par_idx      ON cotisation (saisi_par);
CREATE INDEX IF NOT EXISTS echeance_tour_idx             ON echeance (tour_id)
    WHERE tour_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS echeance_dispense_par_idx     ON echeance (dispense_par)
    WHERE dispense_par IS NOT NULL;

-- Membres et rôles.
CREATE INDEX IF NOT EXISTS membre_role_attribue_par_idx  ON membre_role (attribue_par)
    WHERE attribue_par IS NOT NULL;

-- Prêts, épargne, remboursements.
CREATE INDEX IF NOT EXISTS epargne_membre_membre_idx     ON epargne_membre (membre_id);
CREATE INDEX IF NOT EXISTS pret_decide_par_idx           ON pret (decide_par)
    WHERE decide_par IS NOT NULL;
CREATE INDEX IF NOT EXISTS pret_ecriture_octroi_idx      ON pret (ecriture_octroi_id)
    WHERE ecriture_octroi_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS remboursement_echeance_idx    ON remboursement (echeance_pret_id)
    WHERE echeance_pret_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS remboursement_ecriture_idx    ON remboursement (ecriture_id);
CREATE INDEX IF NOT EXISTS remboursement_saisi_par_idx   ON remboursement (saisi_par);
CREATE INDEX IF NOT EXISTS reechelonnement_decide_par_idx ON reechelonnement (decide_par);

-- Aides.
CREATE INDEX IF NOT EXISTS aide_decide_par_idx           ON aide (decide_par)
    WHERE decide_par IS NOT NULL;
CREATE INDEX IF NOT EXISTS aide_ecriture_idx             ON aide (ecriture_id)
    WHERE ecriture_id IS NOT NULL;

-- Anomalies — six clés, toutes nullables : d'où les index partiels, qui
-- n'occupent de la place que pour les lignes concernées.
CREATE INDEX IF NOT EXISTS anomalie_membre_idx     ON anomalie (membre_id)   WHERE membre_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS anomalie_echeance_idx   ON anomalie (echeance_id) WHERE echeance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS anomalie_ecriture_idx   ON anomalie (ecriture_id) WHERE ecriture_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS anomalie_pret_idx       ON anomalie (pret_id)     WHERE pret_id     IS NOT NULL;
CREATE INDEX IF NOT EXISTS anomalie_verifiee_idx   ON anomalie (verifiee_par) WHERE verifiee_par IS NOT NULL;
CREATE INDEX IF NOT EXISTS anomalie_levee_par_idx  ON anomalie (levee_par)   WHERE levee_par   IS NOT NULL;

-- Historique — la table qui croît le plus vite, une ligne par décision.
CREATE INDEX IF NOT EXISTS historique_membre_vise_idx ON historique (membre_vise) WHERE membre_vise IS NOT NULL;
CREATE INDEX IF NOT EXISTS historique_ecriture_idx    ON historique (ecriture_id) WHERE ecriture_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS historique_echeance_idx    ON historique (echeance_id) WHERE echeance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS historique_pret_idx        ON historique (pret_id)     WHERE pret_id     IS NOT NULL;
CREATE INDEX IF NOT EXISTS historique_aide_idx        ON historique (aide_id)     WHERE aide_id     IS NOT NULL;
CREATE INDEX IF NOT EXISTS historique_anomalie_idx    ON historique (anomalie_id) WHERE anomalie_id IS NOT NULL;

-- Notifications.
CREATE INDEX IF NOT EXISTS notification_echeance_idx  ON notification (echeance_id)  WHERE echeance_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_cotisation_idx ON notification (cotisation_id) WHERE cotisation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_anomalie_idx  ON notification (anomalie_id)  WHERE anomalie_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_pret_idx      ON notification (pret_id)      WHERE pret_id      IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_aide_idx      ON notification (aide_id)      WHERE aide_id      IS NOT NULL;

-- Mobile Money et audit.
CREATE INDEX IF NOT EXISTS releve_importe_par_idx     ON releve_mobile_money (importe_par);
CREATE INDEX IF NOT EXISTS ligne_releve_releve_idx    ON ligne_releve (releve_id);
CREATE INDEX IF NOT EXISTS utilisateur_membre_idx     ON utilisateur (membre_id);

-- -----------------------------------------------------------------------------
-- Index COUVRANT pour le calcul des soldes
--
-- `INCLUDE` place `sens` et `montant` dans l'index sans les indexer : le
-- planificateur peut alors répondre à l'agrégation SANS toucher à la table.
-- C'est ce qui transforme un parcours complet en lecture d'index seul quand le
-- volume rend le parcours coûteux.
-- -----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS ligne_ecriture_solde_idx
    ON ligne_ecriture (compte_id) INCLUDE (sens, montant);

COMMENT ON INDEX ligne_ecriture_solde_idx IS
    'Index couvrant : permet de calculer un solde sans lire la table. Mesuré '
    'nécessaire à partir de ~10 000 écritures, où le parcours séquentiel '
    'commence à peser.';

-- -----------------------------------------------------------------------------
-- solde_groupe — le calcul de solde, filtré DÈS la lecture
--
-- POURQUOI UNE FONCTION PLUTÔT QUE LA VUE. Dans `v_solde_compte`, le filtre
-- porte sur `compte.groupe_id` et ne s'applique qu'APRÈS l'agrégation : le
-- planificateur doit donc agréger tout le journal, tous groupes confondus,
-- avant de jeter ce qui ne concerne pas le groupe demandé.
--
-- Ici, le filtre entre dans la jointure. Sur une base multi-groupes, le gain
-- croît avec le nombre de groupes — c'est précisément le cas d'usage visé, où
-- une même instance sert plusieurs tontines.
--
-- LA VUE EST CONSERVÉE : elle reste juste, et pratique pour une lecture
-- globale. On ajoute un chemin rapide, on ne remplace rien.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION solde_groupe(p_groupe_id UUID)
RETURNS TABLE (
    compte_id UUID,
    nature    nature_compte,
    libelle   TEXT,
    membre_id UUID,
    solde     BIGINT
)
LANGUAGE sql
STABLE
AS $$
    SELECT c.id, c.nature, c.libelle, c.membre_id,
           (COALESCE(SUM(l.montant) FILTER (WHERE l.sens = 'DEBIT'),  0)
          - COALESCE(SUM(l.montant) FILTER (WHERE l.sens = 'CREDIT'), 0))::BIGINT
      FROM compte c
      LEFT JOIN ligne_ecriture l ON l.compte_id = c.id
     WHERE c.groupe_id = p_groupe_id
     GROUP BY c.id, c.nature, c.libelle, c.membre_id;
$$;

COMMENT ON FUNCTION solde_groupe(UUID) IS
    'Soldes d''un groupe, filtrés dès la lecture. La vue v_solde_compte agrège '
    'tout le journal avant de filtrer ; cette fonction restreint d''abord. '
    'Aucun solde n''est stocké : le recalcul reste la règle (décision 0003).';

COMMIT;

-- -----------------------------------------------------------------------------
-- Complément : les deux dernières clés étrangères de `tour`
--
-- `beneficiaire_id` est déjà couvert par l'index unique (cycle_id,
-- beneficiaire_id) qui porte R-04. PostgreSQL ne le compte pas comme index de
-- clé étrangère — la colonne n'est pas en tête — mais il sert les jointures
-- filtrées par cycle, qui sont le cas réel. On ajoute donc un index simple
-- pour la vérification d'intégrité à la suppression d'un membre.
-- -----------------------------------------------------------------------------

BEGIN;

CREATE INDEX IF NOT EXISTS tour_beneficiaire_idx    ON tour (beneficiaire_id);
CREATE INDEX IF NOT EXISTS tour_ecriture_remise_idx ON tour (ecriture_remise_id)
    WHERE ecriture_remise_id IS NOT NULL;

COMMIT;
