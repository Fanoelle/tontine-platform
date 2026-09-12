-- =============================================================================
-- Jeu de démonstration MUTUELLE — « Association Solidarité de Bafoussam »
--
-- Troisième mécanisme, troisième groupe sur la même base. Avec la ROSCA et
-- l'ASCA, les trois types coexistent : c'est la seule configuration où la
-- cohérence de type (décision 0002) est réellement mise à l'épreuve, puisqu'un
-- `tour` ne doit exister que pour le premier, un `pret` que pour le deuxième,
-- une `aide` que pour le troisième.
--
-- CE QUI DISTINGUE UNE MUTUELLE. Le fonds est COLLECTIF et non individualisé :
-- cotiser n'ouvre aucun droit. Une aide est une DÉCISION du groupe, jamais une
-- créance — d'où l'absence de tout solde individuel, contrairement à l'ASCA.
-- L'invariant du mécanisme est : fonds = cotisations encaissées − aides versées.
-- =============================================================================

BEGIN;

DO $$
DECLARE
    v_groupe UUID;
BEGIN
    SELECT id INTO v_groupe FROM groupe
     WHERE nom = 'Association Solidarité de Bafoussam';
    IF v_groupe IS NULL THEN RETURN; END IF;

    SET LOCAL session_replication_role = replica;

    DELETE FROM aide WHERE cycle_id IN (SELECT id FROM cycle WHERE groupe_id = v_groupe);
    DELETE FROM cotisation WHERE echeance_id IN (
        SELECT e.id FROM echeance e JOIN cycle c ON c.id = e.cycle_id
         WHERE c.groupe_id = v_groupe);
    DELETE FROM echeance WHERE cycle_id IN (SELECT id FROM cycle WHERE groupe_id = v_groupe);
    DELETE FROM anomalie WHERE groupe_id = v_groupe;
    DELETE FROM ligne_ecriture WHERE ecriture_id IN (
        SELECT id FROM ecriture WHERE groupe_id = v_groupe);
    DELETE FROM ecriture    WHERE groupe_id = v_groupe;
    DELETE FROM cycle       WHERE groupe_id = v_groupe;
    DELETE FROM compte      WHERE groupe_id = v_groupe;
    DELETE FROM journal_acces WHERE utilisateur_id IN (
        SELECT u.id FROM utilisateur u JOIN membre m ON m.id = u.membre_id
         WHERE m.groupe_id = v_groupe);
    DELETE FROM utilisateur WHERE membre_id IN (
        SELECT id FROM membre WHERE groupe_id = v_groupe);
    DELETE FROM membre_role WHERE membre_id IN (
        SELECT id FROM membre WHERE groupe_id = v_groupe);
    DELETE FROM membre      WHERE groupe_id = v_groupe;
    DELETE FROM regle_groupe WHERE groupe_id = v_groupe;
    DELETE FROM groupe      WHERE id = v_groupe;

    SET LOCAL session_replication_role = origin;
END $$;

DO $$
DECLARE
    v_groupe   UUID;
    v_cycle    UUID;
    v_caisse   UUID;
    v_fonds    UUID;
    v_debut    DATE := (date_trunc('month', CURRENT_DATE) - INTERVAL '4 months')::DATE + 1;
    v_montant  BIGINT := 10000;

    v_noms TEXT[] := ARRAY[
        'Pauline Kamdem', 'Joseph Tagne', 'Henriette Nana', 'Bernard Sop',
        'Lucie Feudjio', 'Antoine Kouam', 'Jeanne Dongmo', 'Michel Tchinda',
        'Odette Nguemo', 'Paul Momo'];
    v_tels TEXT[] := ARRAY[
        '+237699330001', '+237699330002', '+237699330003', '+237699330004',
        '+237699330005', '+237699330006', '+237699330007', '+237699330008',
        '+237699330009', '+237699330010'];

    v_membres UUID[] := ARRAY[]::UUID[];
    v_comptes UUID[] := ARRAY[]::UUID[];

    v_id        UUID;
    v_ecriture  UUID;
    v_echeance  UUID;
    v_tresorier UUID;
    v_president UUID;
    v_date      DATE;
    i           INTEGER;
    j           INTEGER;
BEGIN
    INSERT INTO groupe (nom, type, devise, date_creation)
    VALUES ('Association Solidarité de Bafoussam', 'MUTUELLE', 'XAF', v_debut)
    RETURNING id INTO v_groupe;

    -- Pas de taux d'intérêt : une mutuelle ne prête pas. La colonne reste NULL,
    -- ce que la contrainte autorise explicitement.
    INSERT INTO regle_groupe (groupe_id, montant_cotisation, periodicite,
                              penalite_retard, date_effet)
    VALUES (v_groupe, v_montant, 'MENSUELLE', 1000, v_debut);

    FOR i IN 1..10 LOOP
        INSERT INTO membre (groupe_id, nom_complet, telephone, date_adhesion)
        VALUES (v_groupe, v_noms[i], v_tels[i], v_debut)
        RETURNING id INTO v_id;
        v_membres := array_append(v_membres, v_id);

        INSERT INTO membre_role (membre_id, role, attribue_le)
        VALUES (v_id, 'MEMBRE', v_debut);

        INSERT INTO compte (groupe_id, nature, libelle, membre_id)
        VALUES (v_groupe, 'COTISATION_MEMBRE', 'Cotisations — ' || v_noms[i], v_id)
        RETURNING id INTO v_id;
        v_comptes := array_append(v_comptes, v_id);
    END LOOP;

    INSERT INTO membre_role (membre_id, role, attribue_le)
    VALUES (v_membres[1], 'PRESIDENT',   v_debut),
           (v_membres[2], 'TRESORIER',   v_debut),
           (v_membres[3], 'COMMISSAIRE', v_debut);
    v_president := v_membres[1];
    v_tresorier := v_membres[2];

    INSERT INTO compte (groupe_id, nature, libelle)
    VALUES (v_groupe, 'CAISSE', 'Caisse espèces')
    RETURNING id INTO v_caisse;

    INSERT INTO compte (groupe_id, nature, libelle)
    VALUES (v_groupe, 'FONDS_AIDE', 'Fonds d''entraide')
    RETURNING id INTO v_fonds;

    INSERT INTO cycle (groupe_id, numero, date_debut, date_fin_prevue, statut)
    VALUES (v_groupe, 1, v_debut, v_debut + INTERVAL '12 months', 'EN_COURS')
    RETURNING id INTO v_cycle;

    -- Quatre mois de cotisations, toutes réglées : 10 × 10 000 × 4 = 400 000 F
    -- encaissés. Le fonds croît et se dépense, sans jamais se vider comme en
    -- ROSCA ni se redistribuer comme en ASCA.
    FOR i IN 1..4 LOOP
        v_date := (v_debut + ((i - 1) || ' months')::INTERVAL)::DATE;
        FOR j IN 1..10 LOOP
            INSERT INTO echeance (cycle_id, membre_id, date_echeance, montant_attendu)
            VALUES (v_cycle, v_membres[j], v_date, v_montant)
            RETURNING id INTO v_echeance;

            INSERT INTO ecriture (groupe_id, date_operation, libelle, nature,
                                  saisi_par, cree_le)
            VALUES (v_groupe, v_date, 'Cotisation — ' || v_noms[j],
                    'COTISATION', v_tresorier,
                    v_date::TIMESTAMPTZ + INTERVAL '8 hours')
            RETURNING id INTO v_ecriture;

            INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
            VALUES (v_ecriture, v_caisse,     'DEBIT',  v_montant, 1),
                   (v_ecriture, v_comptes[j], 'CREDIT', v_montant, 2);

            INSERT INTO cotisation (echeance_id, montant, date_versement, moyen,
                                    ecriture_id, saisi_par)
            VALUES (v_echeance, v_montant, v_date,
                    (CASE WHEN j % 5 = 0 THEN 'MOBILE_MONEY' ELSE 'ESPECES' END)::moyen_paiement,
                    v_ecriture, v_tresorier);
        END LOOP;
    END LOOP;

    -- ------------------------------------------------------------- aides
    -- Une aide VERSÉE, une APPROUVÉE non encore versée, une EN ATTENTE de
    -- décision : les trois états que les écrans doivent savoir présenter.

    -- 1. Décès dans la famille de Bernard — aide versée il y a deux mois.
    v_date := (v_debut + INTERVAL '2 months')::DATE;

    INSERT INTO ecriture (groupe_id, date_operation, libelle, nature,
                          saisi_par, cree_le)
    VALUES (v_groupe, v_date, 'Aide versée — ' || v_noms[4],
            'VERSEMENT_AIDE', v_tresorier,
            v_date::TIMESTAMPTZ + INTERVAL '15 hours')
    RETURNING id INTO v_ecriture;

    -- Le fonds se consomme, la caisse se vide. Aucune créance : une aide n'est
    -- pas remboursable, et c'est ce qui la distingue d'un prêt ASCA.
    INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
    VALUES (v_ecriture, v_fonds,  'DEBIT',  75000, 1),
           (v_ecriture, v_caisse, 'CREDIT', 75000, 2);

    INSERT INTO aide (cycle_id, beneficiaire_id, motif, montant_demande,
                      montant_accorde, statut, date_demande, date_decision,
                      decide_par, date_versement, ecriture_id)
    VALUES (v_cycle, v_membres[4],
            'Décès du père — frais d''obsèques', 100000, 75000, 'VERSEE',
            v_date - 5, v_date - 2, v_president, v_date, v_ecriture);

    -- 2. Hospitalisation de Lucie — approuvée, versement à venir.
    INSERT INTO aide (cycle_id, beneficiaire_id, motif, montant_demande,
                      montant_accorde, statut, date_demande, date_decision,
                      decide_par)
    VALUES (v_cycle, v_membres[5],
            'Hospitalisation — frais de chirurgie', 80000, 60000, 'APPROUVEE',
            CURRENT_DATE - 6, CURRENT_DATE - 2, v_president);

    -- 3. Scolarité de Jeanne — en attente de la décision du bureau.
    INSERT INTO aide (cycle_id, beneficiaire_id, motif, montant_demande,
                      statut, date_demande)
    VALUES (v_cycle, v_membres[7],
            'Frais de scolarité de trois enfants', 45000, 'DEMANDEE',
            CURRENT_DATE - 3);

    RAISE NOTICE 'Groupe MUTUELLE % — 10 membres, 4 mois cotisés, 3 aides', v_groupe;
END $$;

DO $$
DECLARE
    v_groupe UUID;
    v_hash   TEXT := '$2b$12$bd0aQLSwtB9YjHpTTOjqOOY7.cwZ8nk1bUBczf0Q2KBjrS2fg7ur6';
    v_membre UUID;
BEGIN
    SELECT id INTO v_groupe FROM groupe
     WHERE nom = 'Association Solidarité de Bafoussam';
    IF v_groupe IS NULL THEN RETURN; END IF;

    SELECT id INTO v_membre FROM membre
     WHERE groupe_id = v_groupe AND nom_complet = 'Pauline Kamdem';
    INSERT INTO utilisateur (membre_id, telephone, mot_de_passe_hash)
    VALUES (v_membre, '+237699330001', v_hash);

    SELECT id INTO v_membre FROM membre
     WHERE groupe_id = v_groupe AND nom_complet = 'Joseph Tagne';
    INSERT INTO utilisateur (membre_id, telephone, mot_de_passe_hash)
    VALUES (v_membre, '+237699330002', v_hash);

    RAISE NOTICE 'MUTUELLE : 2 comptes (présidente, trésorier) — mot de passe : tontine2026';
END $$;

COMMIT;
