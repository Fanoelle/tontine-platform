-- =============================================================================
-- 006 — Remise de la cagnotte ROSCA (F-TOU-02, F-TOU-03, R-05)
--
-- LA RÈGLE QUI COMMANDE TOUT CE FICHIER : on ne remet jamais une cagnotte avant
-- que les cotisations du tour soient encaissées. Remettre sur la foi des
-- montants attendus reviendrait à distribuer de l'argent absent de la caisse.
-- C'est la raison pour laquelle `remettre_cagnotte` REFUSE au lieu d'avertir.
--
-- Le montant remis est la somme RÉELLEMENT ENCAISSÉE (R-05), jamais la somme
-- appelée. Calculer depuis l'attendu créerait un déséquilibre dès la première
-- cotisation partielle.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- tour_courant — F-TOU-02, F-TDB-05
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_tour_courant AS
SELECT t.cycle_id,
       c.groupe_id,
       t.id                AS tour_id,
       t.rang,
       t.beneficiaire_id,
       m.nom_complet       AS beneficiaire,
       t.date_remise_prevue,
       t.date_remise_reelle,
       t.montant_cagnotte,
       vc.cagnotte_attendue,
       vc.cagnotte_encaissee,
       vc.cagnotte_attendue - vc.cagnotte_encaissee AS manque,
       (t.date_remise_reelle IS NOT NULL)           AS remis
FROM tour t
JOIN cycle  c  ON c.id = t.cycle_id
JOIN membre m  ON m.id = t.beneficiaire_id
JOIN v_cagnotte_tour vc ON vc.tour_id = t.id;

COMMENT ON VIEW v_tour_courant IS
    'F-TOU-02 — état de chaque tour avec son bénéficiaire et l''écart entre '
    'cagnotte attendue et encaissée. `manque` est ce qui interdit la remise.';

-- Le tour en cours est le premier non remis, par rang croissant. L'ordre de
-- passage est arrêté à l'avance (F-TOU-01) : le système ne choisit jamais.
CREATE OR REPLACE FUNCTION tour_en_cours(p_cycle_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
    SELECT id FROM tour
     WHERE cycle_id = p_cycle_id
       AND date_remise_reelle IS NULL
     ORDER BY rang
     LIMIT 1;
$$;

COMMENT ON FUNCTION tour_en_cours(UUID) IS
    'F-TOU-02 — premier tour non remis, par rang. Consultation, jamais '
    'décision : l''ordre de passage a été fixé par le groupe.';

-- -----------------------------------------------------------------------------
-- remettre_cagnotte — F-TOU-03, R-05
--
-- Écriture produite : DÉBIT cotisations des membres / CRÉDIT trésorerie.
-- C'est l'inverse exact de l'écriture de cotisation, et c'est pourquoi le solde
-- de caisse retombe à zéro à chaque tour, conformément au §3.1.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION remettre_cagnotte(
    p_tour_id   UUID,
    p_saisi_par UUID,
    p_date      DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
    ecriture_id      UUID,
    ecriture_numero  BIGINT,
    montant_remis    BIGINT,
    beneficiaire     TEXT,
    tour_suivant     INTEGER,
    cycle_cloture    BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_cycle_id     UUID;
    v_groupe_id    UUID;
    v_rang         INTEGER;
    v_benef_id     UUID;
    v_benef_nom    TEXT;
    v_deja         DATE;
    v_encaisse     BIGINT;
    v_attendu      BIGINT;
    v_manque       BIGINT;
    v_impayes      INTEGER;
    v_compte_tres  UUID;
    v_ecriture     UUID;
    v_numero       BIGINT;
    v_solde_caisse BIGINT;
    v_suivant      INTEGER;
    v_cloture      BOOLEAN := false;
    v_ligne        RECORD;
BEGIN
    SELECT t.cycle_id, c.groupe_id, t.rang, t.beneficiaire_id, m.nom_complet,
           t.date_remise_reelle
      INTO v_cycle_id, v_groupe_id, v_rang, v_benef_id, v_benef_nom, v_deja
      FROM tour t
      JOIN cycle  c ON c.id = t.cycle_id
      JOIN membre m ON m.id = t.beneficiaire_id
     WHERE t.id = p_tour_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tour % introuvable', p_tour_id
            USING ERRCODE = 'no_data_found';
    END IF;

    IF v_deja IS NOT NULL THEN
        RAISE EXCEPTION
            'La cagnotte du tour % a déjà été remise le %', v_rang, v_deja
            USING ERRCODE = 'unique_violation';
    END IF;

    SELECT cagnotte_encaissee, cagnotte_attendue
      INTO v_encaisse, v_attendu
      FROM v_cagnotte_tour WHERE tour_id = p_tour_id;

    -- Les échéances dispensées ne sont pas des impayés : le groupe a décidé
    -- d'exonérer, la cagnotte sera légitimement plus petite (exception R-05).
    SELECT count(*)::INTEGER INTO v_impayes
      FROM echeance
     WHERE tour_id = p_tour_id
       AND statut NOT IN ('REGLEE', 'DISPENSEE');

    IF v_impayes > 0 THEN
        v_manque := v_attendu - v_encaisse;
        RAISE EXCEPTION
            'Remise impossible : % échéance(s) non réglée(s), il manque % F sur %',
            v_impayes, v_manque, v_attendu
            USING ERRCODE = 'check_violation',
                  HINT = 'Encaissez les cotisations ou accordez une dispense motivée';
    END IF;

    IF v_encaisse <= 0 THEN
        RAISE EXCEPTION
            'Remise impossible : aucune cotisation encaissée pour ce tour'
            USING ERRCODE = 'check_violation';
    END IF;

    v_compte_tres := compte_de_tresorerie(v_groupe_id, 'ESPECES');

    -- Double sécurité (séquences §2). Si toutes les cotisations sont encaissées,
    -- le solde suffit nécessairement — le vérifier détecte un écart comptable
    -- ANTÉRIEUR avant de distribuer de l'argent. C'est l'identité qu'exploite
    -- F-ANO-04.
    SELECT solde INTO v_solde_caisse
      FROM v_solde_compte WHERE compte_id = v_compte_tres;

    IF v_solde_caisse < v_encaisse THEN
        RAISE EXCEPTION
            'Incohérence comptable : la caisse porte % F alors que % F ont été '
            'encaissés pour ce tour. Vérifiez le journal avant toute remise.',
            v_solde_caisse, v_encaisse
            USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO ecriture (groupe_id, date_operation, libelle, nature, saisi_par)
    VALUES (v_groupe_id, p_date,
            'Remise de la cagnotte — tour ' || v_rang || ' — ' || v_benef_nom,
            'REMISE_CAGNOTTE', p_saisi_par)
    RETURNING id, numero INTO v_ecriture, v_numero;

    -- Une ligne de débit par compte de cotisation mouvementé, à hauteur de ce
    -- que chaque membre a versé pour CE tour. Solder d'un bloc sur un compte
    -- unique perdrait la traçabilité individuelle dont dépend le relevé.
    FOR v_ligne IN
        SELECT co.membre_id, SUM(e.montant_regle) AS montant
          FROM echeance e
          JOIN compte  co ON co.membre_id = e.membre_id
                         AND co.nature    = 'COTISATION_MEMBRE'
                         AND co.groupe_id = v_groupe_id
         WHERE e.tour_id = p_tour_id
           AND e.montant_regle > 0
         GROUP BY co.membre_id
         HAVING SUM(e.montant_regle) > 0
    LOOP
        INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
        SELECT v_ecriture, co.id, 'DEBIT', v_ligne.montant, 1
          FROM compte co
         WHERE co.membre_id = v_ligne.membre_id
           AND co.nature    = 'COTISATION_MEMBRE'
           AND co.groupe_id = v_groupe_id;
    END LOOP;

    INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
    VALUES (v_ecriture, v_compte_tres, 'CREDIT', v_encaisse, 99);

    UPDATE tour
       SET date_remise_reelle = p_date,
           montant_cagnotte   = v_encaisse,
           ecriture_remise_id = v_ecriture
     WHERE id = p_tour_id;

    SELECT rang INTO v_suivant
      FROM tour
     WHERE cycle_id = v_cycle_id
       AND date_remise_reelle IS NULL
     ORDER BY rang
     LIMIT 1;

    -- La clôture du cycle est une CONSÉQUENCE, pas une action (etats.md §1).
    -- Aucun acteur ne clôture un cycle ROSCA : il s'achève quand tous les
    -- membres ont bénéficié.
    IF v_suivant IS NULL THEN
        UPDATE cycle
           SET statut = 'CLOTURE', date_cloture = p_date
         WHERE id = v_cycle_id;
        v_cloture := true;
    END IF;

    RETURN QUERY SELECT v_ecriture, v_numero, v_encaisse, v_benef_nom,
                        v_suivant, v_cloture;
END $$;

COMMENT ON FUNCTION remettre_cagnotte IS
    'F-TOU-03, R-05 — remet la cagnotte RÉELLEMENT ENCAISSÉE au bénéficiaire du '
    'rang. Refuse si une échéance reste non réglée : distribuer de l''argent '
    'absent de la caisse est la défaillance classique des tontines rotatives. '
    'Clôture le cycle si c''était le dernier tour.';

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO tontine_app;

COMMIT;
