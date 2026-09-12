-- =============================================================================
-- 011 — Couche métier des prêts et des aides (F-PRE, F-AID)
--
-- Même principe qu'en migration 005 : ces fonctions sont ATOMIQUES par
-- construction. Un octroi de prêt crée l'écriture, ses lignes et l'échéancier
-- en une seule transaction. Le déclencheur d'équilibre étant différé au COMMIT
-- (R-01), reconstituer ce séquencement côté application exposerait à
-- l'interrompre à mi-chemin — et un prêt sans échéancier, ou une écriture sans
-- ses lignes, est un état dont le journal ne se relève pas.
--
-- LE SENS DES ÉCRITURES, QUI SURPREND AU PREMIER ABORD :
--
--   Octroi        DÉBIT créance de prêt / CRÉDIT caisse
--                 La caisse se vide, le membre doit désormais au groupe.
--
--   Remboursement DÉBIT caisse / CRÉDIT créance de prêt (capital)
--                 plus CRÉDIT produit d'intérêt pour la part d'intérêt.
--                 La dette s'éteint, la caisse se remplit, et l'intérêt est
--                 un PRODUIT du groupe — pas une réduction de dette.
--
--   Aide          DÉBIT fonds d'aide / CRÉDIT caisse
--                 Le fonds se consomme. Aucune créance n'est ouverte : une
--                 aide n'est pas remboursable.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Avoir disponible de la caisse — R-06
--
-- RECALCULÉ DEPUIS LE JOURNAL, jamais lu dans une colonne. C'est ce qui donne
-- au contrôle « un prêt n'excède pas l'avoir disponible » sa valeur : comparer
-- à un solde stocké reviendrait à comparer à une valeur qui peut avoir dérivé.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION avoir_disponible(p_groupe_id UUID)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(SUM(
               CASE l.sens WHEN 'DEBIT' THEN l.montant ELSE -l.montant END), 0)
      FROM ligne_ecriture l
      JOIN compte c ON c.id = l.compte_id
     WHERE c.groupe_id = p_groupe_id
       AND c.nature IN ('CAISSE', 'BANQUE');
$$;

COMMENT ON FUNCTION avoir_disponible(UUID) IS
    'R-06 — avoir réellement mobilisable, recalculé depuis le journal. Sert au '
    'contrôle d''approbation d''un prêt et de versement d''une aide.';

-- -----------------------------------------------------------------------------
-- demander_pret — F-PRE-01
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION demander_pret(
    p_cycle_id         UUID,
    p_emprunteur_id    UUID,
    p_montant          BIGINT,
    p_motif            TEXT,
    p_nombre_echeances INTEGER DEFAULT 1
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_statut_membre statut_membre;
    v_taux          NUMERIC(5,4);
    v_groupe_id     UUID;
    v_pret_id       UUID;
BEGIN
    IF p_montant IS NULL OR p_montant <= 0 THEN
        RAISE EXCEPTION 'Le montant demandé doit être strictement positif'
            USING ERRCODE = 'check_violation';
    END IF;

    IF p_motif IS NULL OR length(btrim(p_motif)) = 0 THEN
        RAISE EXCEPTION 'Une demande de prêt doit être motivée (F-PRE-01)'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT m.statut, c.groupe_id INTO v_statut_membre, v_groupe_id
      FROM membre m, cycle c
     WHERE m.id = p_emprunteur_id AND c.id = p_cycle_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Membre ou cycle introuvable'
            USING ERRCODE = 'no_data_found';
    END IF;

    -- Un membre suspendu ou radié n'emprunte pas : le prêt engage la caisse de
    -- tous sur la solvabilité d'un seul.
    IF v_statut_membre <> 'ACTIF' THEN
        RAISE EXCEPTION
            'Seul un membre actif peut emprunter (statut actuel : %)', v_statut_membre
            USING ERRCODE = 'check_violation';
    END IF;

    -- Le taux vient de la règle du groupe en vigueur, pas d'un paramètre : le
    -- laisser fixer à la demande permettrait à un emprunteur de choisir son
    -- propre taux.
    SELECT taux_interet_pret INTO v_taux
      FROM regle_en_vigueur(v_groupe_id, CURRENT_DATE);

    INSERT INTO pret (cycle_id, emprunteur_id, montant_demande, taux_interet,
                      nombre_echeances, motif_demande)
    VALUES (p_cycle_id, p_emprunteur_id, p_montant, COALESCE(v_taux, 0),
            p_nombre_echeances, btrim(p_motif))
    RETURNING id INTO v_pret_id;

    RETURN v_pret_id;
END $$;

-- -----------------------------------------------------------------------------
-- approuver_pret — F-PRE-02, F-PRE-03, R-06
--
-- Approuve, produit l'écriture d'octroi ET l'échéancier, en une transaction.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION approuver_pret(
    p_pret_id    UUID,
    p_montant    BIGINT,
    p_decideur_id UUID,
    p_date       DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
    ecriture_id     UUID,
    ecriture_numero BIGINT,
    montant_accorde BIGINT,
    echeances       INTEGER,
    premiere_echeance DATE
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_groupe_id   UUID;
    v_emprunteur  UUID;
    v_nom         TEXT;
    v_statut      statut_pret;
    v_taux        NUMERIC(5,4);
    v_nb          INTEGER;
    v_periodicite periodicite;
    v_avoir       BIGINT;
    v_compte_tres UUID;
    v_compte_cre  UUID;
    v_ecriture    UUID;
    v_numero      BIGINT;
    v_capital     BIGINT;
    v_interet     BIGINT;
    v_reste       BIGINT;
    v_date_ech    DATE;
    v_intervalle  INTERVAL;
    i             INTEGER;
BEGIN
    SELECT c.groupe_id, p.emprunteur_id, m.nom_complet, p.statut,
           p.taux_interet, p.nombre_echeances
      INTO v_groupe_id, v_emprunteur, v_nom, v_statut, v_taux, v_nb
      FROM pret p
      JOIN cycle  c ON c.id = p.cycle_id
      JOIN membre m ON m.id = p.emprunteur_id
     WHERE p.id = p_pret_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Prêt % introuvable', p_pret_id USING ERRCODE = 'no_data_found';
    END IF;

    IF v_statut <> 'DEMANDE' THEN
        RAISE EXCEPTION
            'Ce prêt n''est plus en attente de décision (état : %)', v_statut
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT membre_a_role(p_decideur_id, 'PRESIDENT') THEN
        RAISE EXCEPTION
            'Seul le président approuve un prêt (F-PRE-02)'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- R-06 — LE CONTRÔLE DÉCISIF. Prêter au-delà de l'avoir reviendrait à
    -- promettre un argent que la caisse n'a pas, et le défaut retomberait sur
    -- les membres qui n'ont rien demandé.
    v_avoir := avoir_disponible(v_groupe_id);

    IF p_montant > v_avoir THEN
        RAISE EXCEPTION
            'Le prêt de % F excède l''avoir disponible de la caisse (% F)',
            p_montant, v_avoir
            USING ERRCODE = 'check_violation',
                  HINT = 'Réduisez le montant ou attendez de nouveaux encaissements';
    END IF;

    SELECT id INTO v_compte_tres FROM compte
     WHERE groupe_id = v_groupe_id AND nature = 'CAISSE' AND membre_id IS NULL;

    -- Le compte de créance du membre est créé à la volée : il n'a de raison
    -- d'exister qu'à partir du premier prêt.
    SELECT id INTO v_compte_cre FROM compte
     WHERE groupe_id = v_groupe_id AND nature = 'CREANCE_PRET'
       AND membre_id = v_emprunteur;

    IF v_compte_cre IS NULL THEN
        INSERT INTO compte (groupe_id, nature, libelle, membre_id)
        VALUES (v_groupe_id, 'CREANCE_PRET', 'Créance de prêt — ' || v_nom, v_emprunteur)
        RETURNING id INTO v_compte_cre;
    END IF;

    INSERT INTO ecriture (groupe_id, date_operation, libelle, nature, saisi_par)
    VALUES (v_groupe_id, p_date, 'Octroi de prêt — ' || v_nom,
            'OCTROI_PRET', p_decideur_id)
    RETURNING id, numero INTO v_ecriture, v_numero;

    INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
    VALUES (v_ecriture, v_compte_cre,  'DEBIT',  p_montant, 1),
           (v_ecriture, v_compte_tres, 'CREDIT', p_montant, 2);

    UPDATE pret
       SET montant_accorde    = p_montant,
           capital_restant_du = p_montant,
           statut             = 'EN_REMBOURSEMENT',
           date_decision      = p_date,
           decide_par         = p_decideur_id,
           ecriture_octroi_id = v_ecriture
     WHERE id = p_pret_id;

    -- Échéancier (F-PRE-03). Le capital est réparti également, le reliquat de
    -- division allant à la DERNIÈRE échéance : le répartir en tête ferait payer
    -- au débiteur un centime de plus dès le premier mois, sans raison.
    SELECT r.periodicite INTO v_periodicite
      FROM regle_en_vigueur(v_groupe_id, p_date) r;

    v_intervalle := CASE COALESCE(v_periodicite, 'MENSUELLE')
        WHEN 'HEBDOMADAIRE'  THEN INTERVAL '7 days'
        WHEN 'QUINZAINE'     THEN INTERVAL '15 days'
        WHEN 'TRIMESTRIELLE' THEN INTERVAL '3 months'
        ELSE                      INTERVAL '1 month'
    END;

    v_capital := p_montant / v_nb;
    v_reste   := p_montant - (v_capital * v_nb);
    -- L'intérêt est calculé sur le capital initial, par période, et ARRONDI À
    -- L'ENTIER : un montant est un entier de francs (N-INT-03).
    v_interet := round(p_montant * COALESCE(v_taux, 0));

    FOR i IN 1..v_nb LOOP
        v_date_ech := (p_date + (v_intervalle * i))::DATE;
        INSERT INTO echeance_pret (pret_id, numero, date_echeance,
                                   montant_capital, montant_interet)
        VALUES (p_pret_id, i, v_date_ech,
                v_capital + CASE WHEN i = v_nb THEN v_reste ELSE 0 END,
                v_interet);
    END LOOP;

    RETURN QUERY
        SELECT v_ecriture, v_numero, p_montant, v_nb,
               (p_date + v_intervalle)::DATE;
END $$;

COMMENT ON FUNCTION approuver_pret IS
    'F-PRE-02, F-PRE-03 — approuve, produit l''écriture d''octroi et '
    'l''échéancier. Refuse si le montant excède l''avoir de la caisse (R-06), '
    'recalculé depuis le journal.';

-- -----------------------------------------------------------------------------
-- refuser_pret — F-PRE-02
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION refuser_pret(
    p_pret_id     UUID,
    p_motif       TEXT,
    p_decideur_id UUID
)
RETURNS statut_pret
LANGUAGE plpgsql
AS $$
DECLARE
    v_statut statut_pret;
BEGIN
    IF p_motif IS NULL OR length(btrim(p_motif)) = 0 THEN
        RAISE EXCEPTION
            'Un refus doit être motivé (F-PRE-02, N-TRC-03) : un refus sans '
            'explication est ingérable pour le groupe.'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT membre_a_role(p_decideur_id, 'PRESIDENT') THEN
        RAISE EXCEPTION 'Seul le président statue sur un prêt (F-PRE-02)'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    UPDATE pret
       SET statut         = 'REFUSE',
           date_decision  = CURRENT_DATE,
           decide_par     = p_decideur_id,
           motif_decision = btrim(p_motif)
     WHERE id = p_pret_id AND statut = 'DEMANDE'
    RETURNING statut INTO v_statut;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Prêt introuvable ou déjà tranché — un refus ne se révise pas'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN v_statut;
END $$;

-- -----------------------------------------------------------------------------
-- enregistrer_remboursement — F-PRE-04, F-PRE-05, R-07
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enregistrer_remboursement(
    p_pret_id    UUID,
    p_capital    BIGINT,
    p_interet    BIGINT,
    p_date       DATE,
    p_moyen      moyen_paiement,
    p_saisi_par  UUID
)
RETURNS TABLE (
    ecriture_id        UUID,
    ecriture_numero    BIGINT,
    capital_restant_du BIGINT,
    statut             statut_pret
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_groupe_id   UUID;
    v_emprunteur  UUID;
    v_nom         TEXT;
    v_restant     BIGINT;
    v_statut      statut_pret;
    v_compte_tres UUID;
    v_compte_cre  UUID;
    v_compte_int  UUID;
    v_ecriture    UUID;
    v_numero      BIGINT;
    v_echeance    UUID;
BEGIN
    IF COALESCE(p_capital, 0) < 0 OR COALESCE(p_interet, 0) < 0 THEN
        RAISE EXCEPTION 'Les montants doivent être positifs (R-03)'
            USING ERRCODE = 'check_violation';
    END IF;

    IF COALESCE(p_capital, 0) + COALESCE(p_interet, 0) = 0 THEN
        RAISE EXCEPTION 'Un remboursement ne peut pas être nul'
            USING ERRCODE = 'check_violation';
    END IF;

    IF p_date > CURRENT_DATE THEN
        RAISE EXCEPTION 'La date de remboursement ne peut pas être dans le futur'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT c.groupe_id, p.emprunteur_id, m.nom_complet,
           p.capital_restant_du, p.statut
      INTO v_groupe_id, v_emprunteur, v_nom, v_restant, v_statut
      FROM pret p
      JOIN cycle  c ON c.id = p.cycle_id
      JOIN membre m ON m.id = p.emprunteur_id
     WHERE p.id = p_pret_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Prêt % introuvable', p_pret_id USING ERRCODE = 'no_data_found';
    END IF;

    IF v_statut IN ('DEMANDE', 'REFUSE') THEN
        RAISE EXCEPTION
            'Ce prêt n''a pas été octroyé (état : %) — aucun remboursement possible',
            v_statut
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_statut = 'SOLDE' THEN
        RAISE EXCEPTION 'Ce prêt est déjà soldé'
            USING ERRCODE = 'check_violation';
    END IF;

    -- R-07 — le capital restant dû ne passe jamais sous zéro. Un remboursement
    -- excédentaire est REFUSÉ, jamais absorbé : il révèle une erreur de saisie,
    -- et l'absorber silencieusement ferait disparaître l'erreur avec l'argent.
    IF p_capital > v_restant THEN
        RAISE EXCEPTION
            'Le remboursement en capital de % F dépasse le capital restant dû (% F)',
            p_capital, v_restant
            USING ERRCODE = 'check_violation',
                  HINT = 'Vérifiez la répartition entre capital et intérêt';
    END IF;

    SELECT id INTO v_compte_tres FROM compte
     WHERE groupe_id = v_groupe_id AND nature = 'CAISSE' AND membre_id IS NULL;
    SELECT id INTO v_compte_cre FROM compte
     WHERE groupe_id = v_groupe_id AND nature = 'CREANCE_PRET'
       AND membre_id = v_emprunteur;

    INSERT INTO ecriture (groupe_id, date_operation, libelle, nature, saisi_par)
    VALUES (v_groupe_id, p_date, 'Remboursement de prêt — ' || v_nom,
            'REMBOURSEMENT_PRET', p_saisi_par)
    RETURNING id, numero INTO v_ecriture, v_numero;

    -- La caisse reçoit le total ; la créance s'éteint du capital ; l'intérêt
    -- est un PRODUIT du groupe, porté à un compte distinct. Les confondre
    -- masquerait ce que le prêt a rapporté.
    INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
    VALUES (v_ecriture, v_compte_tres, 'DEBIT',
            COALESCE(p_capital, 0) + COALESCE(p_interet, 0), 1);

    IF COALESCE(p_capital, 0) > 0 THEN
        INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
        VALUES (v_ecriture, v_compte_cre, 'CREDIT', p_capital, 2);
    END IF;

    IF COALESCE(p_interet, 0) > 0 THEN
        SELECT id INTO v_compte_int FROM compte
         WHERE groupe_id = v_groupe_id AND nature = 'PRODUIT_INTERET'
           AND membre_id IS NULL;

        IF v_compte_int IS NULL THEN
            INSERT INTO compte (groupe_id, nature, libelle)
            VALUES (v_groupe_id, 'PRODUIT_INTERET', 'Intérêts perçus')
            RETURNING id INTO v_compte_int;
        END IF;

        INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
        VALUES (v_ecriture, v_compte_int, 'CREDIT', p_interet, 3);
    END IF;

    -- Imputation sur la plus ancienne échéance non soldée.
    --
    -- LA TABLE EST ALIASÉE ET LA COLONNE QUALIFIÉE, ce qui n'est pas une
    -- coquetterie : `statut` est aussi un paramètre de SORTIE de cette fonction
    -- (clause RETURNS TABLE). Sans qualification, PL/pgSQL ne peut pas trancher
    -- entre la variable et la colonne, et refuse la requête pour ambiguïté —
    -- faisant échouer TOUT remboursement légitime. Le chemin de refus, lui,
    -- sortait avant d'atteindre cette ligne : le défaut ne se révélait donc que
    -- sur le cas nominal.
    SELECT ep.id INTO v_echeance
      FROM echeance_pret ep
     WHERE ep.pret_id = p_pret_id AND ep.statut <> 'REGLEE'
     ORDER BY ep.numero LIMIT 1;

    INSERT INTO remboursement (pret_id, echeance_pret_id, montant_capital,
                               montant_interet, date_versement, moyen,
                               ecriture_id, saisi_par)
    VALUES (p_pret_id, v_echeance, COALESCE(p_capital, 0),
            COALESCE(p_interet, 0), p_date, p_moyen, v_ecriture, p_saisi_par);

    SELECT p.capital_restant_du, p.statut INTO v_restant, v_statut
      FROM pret p WHERE p.id = p_pret_id;

    RETURN QUERY SELECT v_ecriture, v_numero, v_restant, v_statut;
END $$;

COMMENT ON FUNCTION enregistrer_remboursement IS
    'F-PRE-04, F-PRE-05 — impute un remboursement. Capital et intérêt sont '
    'portés à des comptes DISTINCTS : l''intérêt est un produit du groupe, pas '
    'une réduction de dette. Refuse un capital excédant le restant dû (R-07).';

-- -----------------------------------------------------------------------------
-- Aides mutualistes — F-AID
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION demander_aide(
    p_cycle_id        UUID,
    p_beneficiaire_id UUID,
    p_montant         BIGINT,
    p_motif           TEXT
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_aide_id UUID;
BEGIN
    IF p_montant IS NULL OR p_montant <= 0 THEN
        RAISE EXCEPTION 'Le montant demandé doit être strictement positif'
            USING ERRCODE = 'check_violation';
    END IF;

    IF p_motif IS NULL OR length(btrim(p_motif)) = 0 THEN
        RAISE EXCEPTION
            'Une demande d''aide doit être motivée (F-AID-01) : le motif est ce '
            'sur quoi le groupe délibère.'
            USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO aide (cycle_id, beneficiaire_id, montant_demande, motif)
    VALUES (p_cycle_id, p_beneficiaire_id, p_montant, btrim(p_motif))
    RETURNING id INTO v_aide_id;

    RETURN v_aide_id;
END $$;

-- Éligibilité (F-AID-03). Consultative, JAMAIS bloquante : le groupe reste
-- souverain pour secourir un membre en retard de cotisation — c'est même le
-- cas où l'aide a le plus de sens.
CREATE OR REPLACE FUNCTION verifier_eligibilite_aide(p_aide_id UUID)
RETURNS TABLE (
    eligible          BOOLEAN,
    anciennete_mois   INTEGER,
    cotisations_dues  BIGINT,
    reserve           TEXT
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_membre    UUID;
    v_adhesion  DATE;
    v_mois      INTEGER;
    v_dues      BIGINT;
    v_reserve   TEXT := '';
BEGIN
    SELECT a.beneficiaire_id, m.date_adhesion
      INTO v_membre, v_adhesion
      FROM aide a JOIN membre m ON m.id = a.beneficiaire_id
     WHERE a.id = p_aide_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Aide % introuvable', p_aide_id USING ERRCODE = 'no_data_found';
    END IF;

    v_mois := EXTRACT(YEAR FROM age(CURRENT_DATE, v_adhesion)) * 12
            + EXTRACT(MONTH FROM age(CURRENT_DATE, v_adhesion));

    SELECT COALESCE(SUM(e.montant_attendu - e.montant_regle), 0) INTO v_dues
      FROM echeance e
     WHERE e.membre_id = v_membre
       AND e.statut IN ('ATTENDUE', 'PARTIELLE', 'IMPAYEE')
       AND e.date_echeance < CURRENT_DATE;

    IF v_mois < 6 THEN
        v_reserve := v_reserve || format('Moins de 6 mois d''ancienneté (%s). ', v_mois);
    END IF;

    IF v_dues > 0 THEN
        v_reserve := v_reserve || format('%s F de cotisations restent dues. ', v_dues);
    END IF;

    RETURN QUERY SELECT (v_reserve = ''), v_mois, v_dues,
                        NULLIF(btrim(v_reserve), '');
END $$;

COMMENT ON FUNCTION verifier_eligibilite_aide(UUID) IS
    'F-AID-03 — éligibilité CONSULTATIVE, jamais bloquante. Le groupe reste '
    'souverain : secourir un membre en retard de cotisation est précisément le '
    'cas où l''aide a le plus de sens.';

CREATE OR REPLACE FUNCTION approuver_aide(
    p_aide_id     UUID,
    p_montant     BIGINT,
    p_decideur_id UUID
)
RETURNS statut_aide
LANGUAGE plpgsql
AS $$
DECLARE
    v_demande BIGINT;
    v_statut  statut_aide;
BEGIN
    IF NOT membre_a_role(p_decideur_id, 'PRESIDENT') THEN
        RAISE EXCEPTION 'Seul le président statue sur une aide (F-AID-02)'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT montant_demande, statut INTO v_demande, v_statut
      FROM aide WHERE id = p_aide_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Aide % introuvable', p_aide_id USING ERRCODE = 'no_data_found';
    END IF;

    IF v_statut <> 'DEMANDEE' THEN
        RAISE EXCEPTION 'Cette aide a déjà été tranchée (état : %)', v_statut
            USING ERRCODE = 'check_violation';
    END IF;

    -- Le montant accordé peut être INFÉRIEUR au montant demandé : le groupe
    -- arbitre selon l'état du fonds. Il ne peut pas être supérieur — accorder
    -- plus que demandé n'est pas un arbitrage, c'est une erreur de saisie.
    IF p_montant > v_demande THEN
        RAISE EXCEPTION
            'Le montant accordé (% F) dépasse le montant demandé (% F)',
            p_montant, v_demande
            USING ERRCODE = 'check_violation';
    END IF;

    UPDATE aide
       SET statut          = 'APPROUVEE',
           montant_accorde = p_montant,
           date_decision   = CURRENT_DATE,
           decide_par      = p_decideur_id
     WHERE id = p_aide_id
    RETURNING statut INTO v_statut;

    RETURN v_statut;
END $$;

CREATE OR REPLACE FUNCTION verser_aide(
    p_aide_id   UUID,
    p_saisi_par UUID,
    p_date      DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
    ecriture_id     UUID,
    ecriture_numero BIGINT,
    montant_verse   BIGINT,
    beneficiaire    TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_groupe_id   UUID;
    v_montant     BIGINT;
    v_statut      statut_aide;
    v_nom         TEXT;
    v_avoir       BIGINT;
    v_compte_tres UUID;
    v_compte_fond UUID;
    v_ecriture    UUID;
    v_numero      BIGINT;
BEGIN
    SELECT c.groupe_id, a.montant_accorde, a.statut, m.nom_complet
      INTO v_groupe_id, v_montant, v_statut, v_nom
      FROM aide a
      JOIN cycle  c ON c.id = a.cycle_id
      JOIN membre m ON m.id = a.beneficiaire_id
     WHERE a.id = p_aide_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Aide % introuvable', p_aide_id USING ERRCODE = 'no_data_found';
    END IF;

    IF v_statut <> 'APPROUVEE' THEN
        RAISE EXCEPTION
            'Seule une aide approuvée peut être versée (état : %)', v_statut
            USING ERRCODE = 'check_violation';
    END IF;

    v_avoir := avoir_disponible(v_groupe_id);

    IF v_montant > v_avoir THEN
        RAISE EXCEPTION
            'Le versement de % F excède l''avoir du fonds (% F)', v_montant, v_avoir
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT id INTO v_compte_tres FROM compte
     WHERE groupe_id = v_groupe_id AND nature = 'CAISSE' AND membre_id IS NULL;

    SELECT id INTO v_compte_fond FROM compte
     WHERE groupe_id = v_groupe_id AND nature = 'FONDS_AIDE' AND membre_id IS NULL;

    IF v_compte_fond IS NULL THEN
        INSERT INTO compte (groupe_id, nature, libelle)
        VALUES (v_groupe_id, 'FONDS_AIDE', 'Fonds d''entraide')
        RETURNING id INTO v_compte_fond;
    END IF;

    INSERT INTO ecriture (groupe_id, date_operation, libelle, nature, saisi_par)
    VALUES (v_groupe_id, p_date, 'Aide versée — ' || v_nom,
            'VERSEMENT_AIDE', p_saisi_par)
    RETURNING id, numero INTO v_ecriture, v_numero;

    -- Le fonds se consomme, la caisse se vide. AUCUNE créance n'est ouverte :
    -- une aide n'est pas remboursable, et c'est ce qui la distingue d'un prêt.
    INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
    VALUES (v_ecriture, v_compte_fond, 'DEBIT',  v_montant, 1),
           (v_ecriture, v_compte_tres, 'CREDIT', v_montant, 2);

    UPDATE aide
       SET statut         = 'VERSEE',
           date_versement = p_date,
           ecriture_id    = v_ecriture
     WHERE id = p_aide_id;

    RETURN QUERY SELECT v_ecriture, v_numero, v_montant, v_nom;
END $$;

COMMENT ON FUNCTION verser_aide IS
    'F-AID-02 — verse une aide approuvée. DÉBIT fonds / CRÉDIT caisse : aucune '
    'créance n''est ouverte, une aide n''est pas remboursable.';

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO tontine_app;

COMMIT;
