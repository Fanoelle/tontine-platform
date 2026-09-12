-- =============================================================================
-- 007 — Restitution : impayés, situation de caisse, tableau de bord
--        (F-COT-04, F-RAP-01, F-RAP-02, F-TDB-01, F-TDB-05)
--
-- Ces vues alimentent les écrans décrits dans docs/conception-interface.md.
-- Leur vocabulaire est celui de l'interface, pas celui de la comptabilité
-- (N-USG-05) : aucune colonne ne s'appelle « débit » ni « crédit ».
--
-- Aucune ne stocke de solde : tout est recalculé depuis le journal. C'est ce qui
-- rend la divergence impossible, et donne à F-ANO-04 une référence sûre.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- v_impaye — F-COT-04
--
-- Une échéance dispensée n'est PAS un impayé, mais elle figure dans la vue avec
-- son motif : l'omettre laisserait croire à un oubli (conception §5).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_impaye AS
SELECT c.groupe_id,
       e.cycle_id,
       e.tour_id,
       t.rang                                   AS tour_rang,
       e.id                                     AS echeance_id,
       e.membre_id,
       m.nom_complet,
       m.telephone,
       e.date_echeance,
       e.montant_attendu,
       e.montant_regle,
       e.montant_attendu - e.montant_regle      AS reste_du,
       (CURRENT_DATE - e.date_echeance)         AS jours_retard,
       e.statut,
       e.motif_dispense
FROM echeance e
JOIN cycle  c ON c.id = e.cycle_id
JOIN membre m ON m.id = e.membre_id
LEFT JOIN tour t ON t.id = e.tour_id
WHERE e.statut <> 'REGLEE'
ORDER BY e.date_echeance, m.nom_complet;

COMMENT ON VIEW v_impaye IS
    'F-COT-04 — échéances non soldées. Inclut les dispensées, signalées par '
    'leur motif : un membre dispensé n''est pas un impayé, mais le masquer '
    'laisserait croire à un oubli.';

-- -----------------------------------------------------------------------------
-- v_situation_caisse — F-RAP-02, F-TDB-01
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_situation_caisse AS
SELECT g.id                                        AS groupe_id,
       g.nom                                       AS groupe,
       g.devise,
       COALESCE(SUM(vs.solde) FILTER (
           WHERE vs.nature IN ('CAISSE', 'BANQUE')), 0)  AS tresorerie,
       COALESCE(SUM(vs.solde) FILTER (
           WHERE vs.nature = 'CAISSE'), 0)               AS especes,
       COALESCE(SUM(vs.solde) FILTER (
           WHERE vs.nature = 'BANQUE'), 0)               AS banque,
       (SELECT count(*) FROM ecriture e WHERE e.groupe_id = g.id) AS nombre_operations,
       (SELECT max(e.date_operation) FROM ecriture e WHERE e.groupe_id = g.id)
                                                         AS derniere_operation
FROM groupe g
LEFT JOIN v_solde_compte vs ON vs.groupe_id = g.id
GROUP BY g.id, g.nom, g.devise;

COMMENT ON VIEW v_situation_caisse IS
    'F-RAP-02, F-TDB-01 — ce que le groupe détient, recalculé depuis le journal. '
    'Jamais « votre solde » dans l''interface : ce n''est pas un avoir '
    'mobilisable mais une position comptable.';

-- Situation à une date passée (F-TRX-04). Filtre sur date_operation, jamais sur
-- cree_le : un versement de mars saisi en avril appartient à la situation de mars.
CREATE OR REPLACE FUNCTION situation_caisse_a_date(
    p_groupe_id UUID,
    p_date      DATE
)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(SUM(
               CASE l.sens WHEN 'DEBIT' THEN l.montant ELSE -l.montant END), 0)
      FROM ligne_ecriture l
      JOIN ecriture e ON e.id = l.ecriture_id
      JOIN compte   c ON c.id = l.compte_id
     WHERE c.groupe_id = p_groupe_id
       AND c.nature IN ('CAISSE', 'BANQUE')
       AND e.date_operation <= p_date;
$$;

COMMENT ON FUNCTION situation_caisse_a_date(UUID, DATE) IS
    'F-TRX-04 — trésorerie à une date passée, reconstruite par sommation du '
    'journal. Aucune valeur stockée n''est lue.';

-- -----------------------------------------------------------------------------
-- v_recouvrement — F-RAP-03, F-TDB-02
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_recouvrement AS
SELECT c.groupe_id,
       c.id                                    AS cycle_id,
       c.numero                                AS cycle_numero,
       c.statut                                AS cycle_statut,
       count(e.id)                             AS echeances,
       count(*) FILTER (WHERE e.statut = 'REGLEE')     AS reglees,
       count(*) FILTER (WHERE e.statut = 'PARTIELLE')  AS partielles,
       count(*) FILTER (WHERE e.statut = 'IMPAYEE')    AS impayees,
       count(*) FILTER (WHERE e.statut = 'ATTENDUE')   AS attendues,
       count(*) FILTER (WHERE e.statut = 'DISPENSEE')  AS dispensees,
       COALESCE(SUM(e.montant_attendu), 0)     AS total_appele,
       COALESCE(SUM(e.montant_regle),   0)     AS total_encaisse,
       -- Le taux exclut les dispenses du dénominateur : compter comme un échec
       -- de recouvrement une exonération votée par le groupe fausserait la
       -- lecture et pénaliserait un groupe solidaire.
       CASE
           WHEN COALESCE(SUM(e.montant_attendu) FILTER (
                    WHERE e.statut <> 'DISPENSEE'), 0) = 0 THEN NULL
           ELSE round(
               100.0 * COALESCE(SUM(e.montant_regle) FILTER (
                           WHERE e.statut <> 'DISPENSEE'), 0)
                     / SUM(e.montant_attendu) FILTER (
                           WHERE e.statut <> 'DISPENSEE'), 1)
       END                                     AS taux_recouvrement
FROM cycle c
LEFT JOIN echeance e ON e.cycle_id = c.id
GROUP BY c.groupe_id, c.id, c.numero, c.statut;

COMMENT ON VIEW v_recouvrement IS
    'F-RAP-03, F-TDB-02 — taux de recouvrement du cycle. Les dispenses sont '
    'exclues du calcul : une exonération votée n''est pas un défaut de paiement.';

-- -----------------------------------------------------------------------------
-- v_tableau_de_bord — F-TDB-01, F-TDB-05
--
-- Une ligne par groupe : tout ce qu'affiche l'écran d'accueil du trésorier.
-- Une seule requête, pour tenir N-PRF-01.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_tableau_de_bord AS
SELECT g.id                     AS groupe_id,
       g.nom                    AS groupe,
       g.type                   AS mecanisme,
       g.devise,
       sc.tresorerie,
       cy.id                    AS cycle_id,
       cy.numero                AS cycle_numero,
       cy.statut                AS cycle_statut,
       r.taux_recouvrement,
       r.impayees + r.attendues AS echeances_en_attente,
       tc.rang                  AS tour_rang,
       tc.beneficiaire          AS prochain_beneficiaire,
       tc.date_remise_prevue,
       tc.cagnotte_encaissee,
       tc.cagnotte_attendue,
       tc.manque                AS manque_pour_remise,
       (SELECT count(*) FROM membre m
         WHERE m.groupe_id = g.id AND NOT m.supprime
           AND m.statut = 'ACTIF')            AS membres_actifs
FROM groupe g
LEFT JOIN v_situation_caisse sc ON sc.groupe_id = g.id
LEFT JOIN cycle cy ON cy.groupe_id = g.id AND cy.statut = 'EN_COURS'
LEFT JOIN v_recouvrement r ON r.cycle_id = cy.id
LEFT JOIN v_tour_courant tc ON tc.tour_id = tour_en_cours(cy.id);

COMMENT ON VIEW v_tableau_de_bord IS
    'F-TDB-01, F-TDB-05 — écran d''accueil du trésorier en une requête : '
    'trésorerie, recouvrement, prochain bénéficiaire et ce qui manque pour '
    'remettre la cagnotte.';

-- -----------------------------------------------------------------------------
-- v_historique_membre — F-RAP-01, N-USG-05
--
-- Le relevé tel que le lit un membre : « vous avez versé 5 000 F le 3 mars ».
-- Aucun débit, aucun crédit, aucune écriture visible.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_historique_membre AS
SELECT m.groupe_id,
       m.id                AS membre_id,
       m.nom_complet,
       co.id               AS versement_id,
       co.date_versement,
       co.montant,
       co.moyen,
       co.reference_externe,
       e.date_echeance,
       e.montant_attendu,
       ec.numero           AS operation_numero,
       -- Un versement dont l'écriture a été corrigée est annulé : l'interface
       -- doit le montrer barré, pas le masquer (conception §7).
       EXISTS (SELECT 1 FROM ecriture inv
                WHERE inv.ecriture_corrigee_id = co.ecriture_id) AS annule
FROM cotisation co
JOIN echeance e  ON e.id  = co.echeance_id
JOIN membre   m  ON m.id  = e.membre_id
JOIN ecriture ec ON ec.id = co.ecriture_id
ORDER BY co.date_versement DESC, ec.numero DESC;

COMMENT ON VIEW v_historique_membre IS
    'F-RAP-01, N-USG-05 — versements d''un membre en langage courant. Un '
    'versement annulé reste visible, marqué comme tel : la piste d''audit ne '
    'masque rien.';

GRANT SELECT ON v_impaye, v_situation_caisse, v_recouvrement,
                v_tableau_de_bord, v_historique_membre, v_tour_courant
    TO tontine_app;

COMMIT;
