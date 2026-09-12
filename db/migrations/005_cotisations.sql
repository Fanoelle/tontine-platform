-- =============================================================================
-- 005 — Couche métier des cotisations (F-COT-02, F-COT-03, F-COT-05)
--
-- POURQUOI DES FONCTIONS SQL PLUTÔT QU'UN SERVICE APPLICATIF. Le séquencement
-- « insérer l'écriture, insérer ses lignes, rattacher la cotisation » doit vivre
-- dans UNE transaction (N-INT-04), sans quoi le déclencheur d'équilibre différé
-- rejette une écriture incomplète. Une fonction PL/pgSQL est atomique par
-- construction : elle ne peut pas être appelée à moitié. L'API l'invoquera en un
-- seul appel, ce qui supprime toute possibilité d'oublier une étape.
--
-- Ces fonctions ne remplacent pas l'API : elles lui donnent une surface sûre.
-- Le contrôle d'habilitation reste applicatif (N-SEC-05) — la base ne connaît
-- pas le jeton.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Comptes de contrepartie selon le moyen de paiement
--
-- ESPECES et MOBILE_MONEY alimentent la caisse ; VIREMENT la banque. La
-- COMPENSATION ne touche aucune caisse : la cotisation est réglée en retenant
-- la somme sur une cagnotte à recevoir, aucun argent ne change de main. Elle
-- débite alors le compte de cotisation du bénéficiaire — l'écriture existe,
-- sans mouvement de trésorerie.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION compte_de_tresorerie(
    p_groupe_id UUID,
    p_moyen     moyen_paiement
)
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_nature nature_compte;
    v_compte UUID;
BEGIN
    v_nature := CASE p_moyen
        WHEN 'VIREMENT' THEN 'BANQUE'::nature_compte
        ELSE                 'CAISSE'::nature_compte
    END;

    SELECT id INTO v_compte
      FROM compte
     WHERE groupe_id = p_groupe_id
       AND nature    = v_nature
       AND membre_id IS NULL;

    IF v_compte IS NULL THEN
        RAISE EXCEPTION
            'Le groupe % n''a pas de compte % — créez son plan de comptes',
            p_groupe_id, v_nature
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN v_compte;
END $$;

COMMENT ON FUNCTION compte_de_tresorerie(UUID, moyen_paiement) IS
    'Compte de contrepartie d''un versement. VIREMENT va en banque, le reste en '
    'caisse. La COMPENSATION est traitée à part par enregistrer_versement.';

-- -----------------------------------------------------------------------------
-- enregistrer_versement — F-COT-02, F-COT-03
--
-- Écriture produite : DÉBIT trésorerie / CRÉDIT cotisations du membre.
-- Le sens surprend si l'on pense « le membre paie donc on le débite » : en
-- comptabilité, la caisse qui reçoit est débitée, et le compte de cotisation du
-- membre est crédité — il matérialise ce que le groupe lui doit.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enregistrer_versement(
    p_echeance_id       UUID,
    p_montant           BIGINT,
    p_date_versement    DATE,
    p_moyen             moyen_paiement,
    p_saisi_par         UUID,
    p_reference_externe TEXT DEFAULT NULL
)
RETURNS TABLE (
    cotisation_id   UUID,
    ecriture_id     UUID,
    ecriture_numero BIGINT,
    montant_regle   BIGINT,
    reliquat        BIGINT,
    statut          statut_echeance
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_groupe_id    UUID;
    v_membre_id    UUID;
    v_cycle_statut statut_cycle;
    v_attendu      BIGINT;
    v_deja_regle   BIGINT;
    v_reliquat     BIGINT;
    v_statut_ech   statut_echeance;
    v_nom          TEXT;
    v_date_ech     DATE;
    v_compte_tres  UUID;
    v_compte_cot   UUID;
    v_ecriture     UUID;
    v_numero       BIGINT;
    v_cotisation   UUID;
    v_regle        BIGINT;
    v_statut       statut_echeance;
BEGIN
    -- R-03 — contrôle applicatif doublant la contrainte CHECK. Il produit un
    -- message compréhensible là où la contrainte produirait un message technique.
    IF p_montant IS NULL OR p_montant <= 0 THEN
        RAISE EXCEPTION 'Le montant versé doit être strictement positif (reçu : %)',
            COALESCE(p_montant::TEXT, 'aucun')
            USING ERRCODE = 'check_violation';
    END IF;

    -- F-ANO-06 — une opération datée du futur fausse toute situation de caisse
    -- à date (F-TRX-04). Elle est refusée, pas signalée.
    IF p_date_versement > CURRENT_DATE THEN
        RAISE EXCEPTION
            'La date de versement ne peut pas être dans le futur (reçue : %)',
            p_date_versement
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT c.groupe_id, e.membre_id, c.statut, e.montant_attendu,
           m.nom_complet, e.date_echeance, e.montant_regle, e.statut
      INTO v_groupe_id, v_membre_id, v_cycle_statut, v_attendu, v_nom,
           v_date_ech, v_deja_regle, v_statut_ech
      FROM echeance e
      JOIN cycle  c ON c.id = e.cycle_id
      JOIN membre m ON m.id = e.membre_id
     WHERE e.id = p_echeance_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Échéance % introuvable', p_echeance_id
            USING ERRCODE = 'no_data_found';
    END IF;

    -- SCÉNARIO A2 (cas F-COT-02) — un versement ne peut pas dépasser le
    -- reliquat. L'excédent doit être imputé explicitement à l'échéance suivante
    -- ou porté en avance ; l'accepter ici en silence gonflerait `montant_regle`
    -- au-delà du montant appelé, fausserait le taux de recouvrement et ferait
    -- remettre une cagnotte supérieure à ce qui est réellement dû.
    --
    -- Une échéance DISPENSÉE échappe au contrôle : le membre peut verser
    -- volontairement malgré l'exonération (scénario A5), et le reliquat n'a
    -- alors plus de sens.
    IF v_statut_ech <> 'DISPENSEE' THEN
        v_reliquat := v_attendu - v_deja_regle;

        IF v_reliquat <= 0 THEN
            RAISE EXCEPTION
                'Cette échéance est déjà réglée (% F versés sur % F appelés)',
                v_deja_regle, v_attendu
                USING ERRCODE = 'check_violation',
                      HINT = 'Imputez ce versement à l''échéance suivante';
        END IF;

        IF p_montant > v_reliquat THEN
            RAISE EXCEPTION
                'Le versement de % F dépasse le reste dû de % F',
                p_montant, v_reliquat
                USING ERRCODE = 'check_violation',
                      HINT = 'Saisissez le reste dû, puis imputez l''excédent à '
                             'l''échéance suivante (scénario A2)';
        END IF;
    END IF;

    -- Scénario A4 du cas F-COT-02 : aucune saisie hors d'un cycle ouvert.
    IF v_cycle_statut <> 'EN_COURS' THEN
        RAISE EXCEPTION
            'Le cycle n''est pas ouvert (état : %) — aucun versement ne peut être saisi',
            v_cycle_statut
            USING ERRCODE = 'check_violation';
    END IF;

    -- L'auteur appartient au groupe (N-SEC-02). Le déclencheur sur `ecriture` le
    -- vérifie aussi ; le faire ici donne un message utilisable.
    IF NOT EXISTS (
        SELECT 1 FROM membre WHERE id = p_saisi_par AND groupe_id = v_groupe_id
    ) THEN
        RAISE EXCEPTION
            'Cloisonnement (N-SEC-02) : l''auteur n''appartient pas au groupe'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    v_compte_tres := compte_de_tresorerie(v_groupe_id, p_moyen);

    SELECT id INTO v_compte_cot
      FROM compte
     WHERE groupe_id = v_groupe_id
       AND nature    = 'COTISATION_MEMBRE'
       AND membre_id = v_membre_id;

    IF v_compte_cot IS NULL THEN
        RAISE EXCEPTION
            'Le membre % n''a pas de compte de cotisation', v_nom
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    INSERT INTO ecriture (groupe_id, date_operation, libelle, nature, saisi_par)
    VALUES (v_groupe_id, p_date_versement,
            'Cotisation du ' || to_char(v_date_ech, 'DD/MM/YYYY') || ' — ' || v_nom,
            'COTISATION', p_saisi_par)
    RETURNING id, numero INTO v_ecriture, v_numero;

    INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
    VALUES (v_ecriture, v_compte_tres, 'DEBIT',  p_montant, 1),
           (v_ecriture, v_compte_cot,  'CREDIT', p_montant, 2);

    INSERT INTO cotisation (echeance_id, montant, date_versement, moyen,
                            reference_externe, ecriture_id, saisi_par)
    VALUES (p_echeance_id, p_montant, p_date_versement, p_moyen,
            p_reference_externe, v_ecriture, p_saisi_par)
    RETURNING id INTO v_cotisation;

    -- `montant_regle` et `statut` viennent d'être recalculés par le déclencheur
    -- de la migration 003 : on les relit plutôt que de les recalculer, pour que
    -- la valeur rendue soit exactement celle enregistrée.
    SELECT e.montant_regle, e.statut INTO v_regle, v_statut
      FROM echeance e WHERE e.id = p_echeance_id;

    RETURN QUERY SELECT v_cotisation, v_ecriture, v_numero, v_regle,
                        GREATEST(v_attendu - v_regle, 0), v_statut;
END $$;

COMMENT ON FUNCTION enregistrer_versement IS
    'F-COT-02, F-COT-03 — enregistre un versement reçu hors application et '
    'produit l''écriture équilibrée correspondante, en une seule transaction '
    '(N-INT-04). Le reliquat rendu est borné à zéro : un versement excédentaire '
    'ne produit pas un reliquat négatif.';

-- -----------------------------------------------------------------------------
-- annuler_versement — F-COT-05, N-TRC-02
--
-- Produit une écriture INVERSE. L'originale n'est ni modifiée ni supprimée
-- (R-02) : elle reste au journal, neutralisée. C'est ce que l'interface appelle
-- « annuler » — jamais « écriture inverse » (N-USG-05).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION annuler_versement(
    p_cotisation_id UUID,
    p_motif         TEXT,
    p_saisi_par     UUID
)
RETURNS TABLE (
    ecriture_inverse_id UUID,
    ecriture_numero     BIGINT,
    montant_regle       BIGINT,
    statut              statut_echeance
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_groupe_id  UUID;
    v_ecriture   UUID;
    v_echeance   UUID;
    v_montant    BIGINT;
    v_libelle    TEXT;
    v_inverse    UUID;
    v_numero     BIGINT;
    v_regle      BIGINT;
    v_statut     statut_echeance;
    v_ligne      RECORD;
BEGIN
    IF p_motif IS NULL OR length(btrim(p_motif)) = 0 THEN
        RAISE EXCEPTION
            'Un motif est obligatoire pour annuler un versement (N-TRC-03)'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT c.ecriture_id, c.echeance_id, c.montant, e.groupe_id, e.libelle
      INTO v_ecriture, v_echeance, v_montant, v_groupe_id, v_libelle
      FROM cotisation c
      JOIN ecriture   e ON e.id = c.ecriture_id
     WHERE c.id = p_cotisation_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Versement % introuvable', p_cotisation_id
            USING ERRCODE = 'no_data_found';
    END IF;

    -- Une écriture ne se corrige qu'une fois — l'index unique le garantit, mais
    -- le message serait incompréhensible. On devance avec une explication.
    IF EXISTS (SELECT 1 FROM ecriture WHERE ecriture_corrigee_id = v_ecriture) THEN
        RAISE EXCEPTION
            'Ce versement a déjà été annulé — une écriture ne se corrige qu''une fois'
            USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO ecriture (groupe_id, date_operation, libelle, nature,
                          ecriture_corrigee_id, motif_correction, saisi_par)
    VALUES (v_groupe_id, CURRENT_DATE,
            'Annulation — ' || v_libelle,
            'CORRECTION', v_ecriture, btrim(p_motif), p_saisi_par)
    RETURNING id, numero INTO v_inverse, v_numero;

    -- Mêmes comptes, mêmes montants, sens inversés. Reprendre les lignes
    -- d'origine plutôt que de les reconstruire garantit que l'inverse neutralise
    -- exactement ce qui a été écrit, y compris si l'écriture portait plus de
    -- deux lignes.
    FOR v_ligne IN
        SELECT compte_id, sens, montant, ordre
          FROM ligne_ecriture
         WHERE ecriture_id = v_ecriture
         ORDER BY ordre
    LOOP
        INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
        VALUES (v_inverse, v_ligne.compte_id,
                CASE v_ligne.sens WHEN 'DEBIT' THEN 'CREDIT'::sens_ecriture
                                  ELSE 'DEBIT'::sens_ecriture END,
                v_ligne.montant, v_ligne.ordre);
    END LOOP;

    -- La cotisation est retirée pour que `montant_regle` reflète le réel. La
    -- trace comptable demeure : les deux écritures restent au journal. C'est la
    -- transition « Réglée → Partiellement réglée » de etats.md §2.
    DELETE FROM cotisation WHERE id = p_cotisation_id;

    SELECT e.montant_regle, e.statut INTO v_regle, v_statut
      FROM echeance e WHERE e.id = v_echeance;

    RETURN QUERY SELECT v_inverse, v_numero, v_regle, v_statut;
END $$;

COMMENT ON FUNCTION annuler_versement IS
    'F-COT-05, N-TRC-02 — annule par écriture inverse. L''écriture d''origine '
    'reste au journal (R-02) ; seule la cotisation est retirée, pour que le '
    'montant réglé de l''échéance reflète la réalité.';

-- -----------------------------------------------------------------------------
-- dispenser_echeance — F-COT-07
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION dispenser_echeance(
    p_echeance_id UUID,
    p_motif       TEXT,
    p_decideur_id UUID
)
RETURNS statut_echeance
LANGUAGE plpgsql
AS $$
DECLARE
    v_statut statut_echeance;
BEGIN
    IF p_motif IS NULL OR length(btrim(p_motif)) = 0 THEN
        RAISE EXCEPTION
            'Une dispense exige un motif (F-COT-07, N-TRC-03)'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Seul le président dispense. Le contrôle est ici en plus de l'API : une
    -- dispense accordée par erreur exonère durablement un membre.
    IF NOT membre_a_role(p_decideur_id, 'PRESIDENT') THEN
        RAISE EXCEPTION
            'Seul le président peut accorder une dispense (F-COT-07)'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    UPDATE echeance
       SET statut         = 'DISPENSEE',
           motif_dispense = btrim(p_motif),
           dispense_par   = p_decideur_id
     WHERE id = p_echeance_id
    RETURNING statut INTO v_statut;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Échéance % introuvable', p_echeance_id
            USING ERRCODE = 'no_data_found';
    END IF;

    RETURN v_statut;
END $$;

COMMENT ON FUNCTION dispenser_echeance IS
    'F-COT-07 — consigne la décision du groupe d''exonérer un membre. Les '
    'versements déjà effectués restent acquis : la dispense porte sur le '
    'reliquat.';

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO tontine_app;

COMMIT;
