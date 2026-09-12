-- =============================================================================
-- Jeu de données de démonstration — « Tontine des Femmes de Bonabéri »
--
-- Reproduit le critère d'acceptation du jalon 1 : une tontine rotative de
-- 12 membres, cotisation mensuelle de 25 000 F, sur un cycle complet de 12 tours.
--
-- Le jeu s'arrête volontairement au 3e tour : les deux premiers sont soldés et
-- remis, le troisième est en cours d'encaissement, avec un versement partiel et
-- un impayé. C'est cet état intermédiaire qui rend les écrans intéressants — un
-- jeu entièrement réglé ne montrerait ni reliquat, ni impayé, ni anomalie.
--
-- RÉ-EXÉCUTABLE : le groupe est supprimé puis recréé à chaque passage. La
-- suppression physique est ici acceptable parce qu'il s'agit de données de
-- démonstration ; elle serait interdite en production (R-02, R-08).
-- =============================================================================

BEGIN;

-- Purge du jeu précédent. L'ordre respecte les dépendances ; ON DELETE RESTRICT
-- partout interdit toute suppression en cascade silencieuse.
DO $$
DECLARE
    v_groupe UUID;
BEGIN
    SELECT id INTO v_groupe FROM groupe WHERE nom = 'Tontine des Femmes de Bonabéri';
    IF v_groupe IS NULL THEN
        RETURN;
    END IF;

    -- Le journal est immuable (R-02) : le déclencheur refuse tout DELETE. La
    -- purge doit donc le contourner — seule entorse tolérée, cantonnée aux jeux
    -- de démonstration.
    --
    -- POURQUOI `session_replication_role` plutôt que ALTER TABLE ... DISABLE
    -- TRIGGER. Supprimer des lignes du journal met en file d'attente le
    -- déclencheur de contrôle d'équilibre, qui est DIFFÉRÉ (R-01) ; tant que ces
    -- événements sont en attente, PostgreSQL refuse tout ALTER TABLE sur la
    -- relation concernée — le réarmement en fin de bloc échouerait, laissant le
    -- journal sans protection pour le reste de la session. Le paramètre de
    -- session neutralise les déclencheurs utilisateur sans aucun DDL, et se
    -- rétablit plus bas.
    SET LOCAL session_replication_role = replica;

    DELETE FROM cotisation WHERE echeance_id IN (
        SELECT e.id FROM echeance e JOIN cycle c ON c.id = e.cycle_id
        WHERE c.groupe_id = v_groupe);
    UPDATE tour SET ecriture_remise_id = NULL, date_remise_reelle = NULL,
                    montant_cagnotte = NULL
        WHERE cycle_id IN (SELECT id FROM cycle WHERE groupe_id = v_groupe);
    DELETE FROM echeance WHERE cycle_id IN (SELECT id FROM cycle WHERE groupe_id = v_groupe);
    DELETE FROM tour     WHERE cycle_id IN (SELECT id FROM cycle WHERE groupe_id = v_groupe);
    DELETE FROM ligne_ecriture WHERE ecriture_id IN (
        SELECT id FROM ecriture WHERE groupe_id = v_groupe);
    DELETE FROM ecriture     WHERE groupe_id = v_groupe;
    DELETE FROM cycle        WHERE groupe_id = v_groupe;
    DELETE FROM compte       WHERE groupe_id = v_groupe;
    DELETE FROM membre_role  WHERE membre_id IN (SELECT id FROM membre WHERE groupe_id = v_groupe);
    DELETE FROM membre       WHERE groupe_id = v_groupe;
    DELETE FROM regle_groupe WHERE groupe_id = v_groupe;
    DELETE FROM groupe       WHERE id = v_groupe;

    -- Réarmement immédiat : le reste du jeu de données s'insère sous la
    -- protection normale des déclencheurs, équilibre compris.
    SET LOCAL session_replication_role = origin;
END $$;

DO $$
DECLARE
    v_groupe   UUID;
    v_cycle    UUID;
    v_caisse   UUID;
    v_regle    UUID;
    v_debut    DATE := DATE '2026-01-05';

    -- 12 membres : nom, téléphone. L'ordre du tableau fixe l'ordre de passage,
    -- décidé par tirage au sort en assemblée (F-TOU-01).
    v_noms  TEXT[] := ARRAY[
        'Awa Ndiaye', 'Marie Ebolo', 'Fatou Bâ', 'Christine Manga',
        'Aissatou Diallo', 'Rose Ngo Bell', 'Mariam Traoré', 'Solange Etoundi',
        'Khadija Sow', 'Béatrice Mbala', 'Aminata Cissé', 'Georgette Akono'];
    v_tels  TEXT[] := ARRAY[
        '+237690110001', '+237690110002', '+237690110003', '+237690110004',
        '+237690110005', '+237690110006', '+237690110007', '+237690110008',
        '+237690110009', '+237690110010', '+237690110011', '+237690110012'];

    v_membres UUID[] := ARRAY[]::UUID[];
    v_comptes UUID[] := ARRAY[]::UUID[];
    v_tours   UUID[] := ARRAY[]::UUID[];

    v_id       UUID;
    v_ecriture UUID;
    v_echeance UUID;
    v_tresorier UUID;
    v_montant  BIGINT := 25000;
    v_cagnotte BIGINT;
    v_date     DATE;
    i          INTEGER;
    j          INTEGER;
    v_verse    BIGINT;
BEGIN
    -- ---------------------------------------------------------------- groupe
    INSERT INTO groupe (nom, type, devise, date_creation)
    VALUES ('Tontine des Femmes de Bonabéri', 'ROSCA', 'XAF', v_debut)
    RETURNING id INTO v_groupe;

    INSERT INTO regle_groupe (groupe_id, montant_cotisation, periodicite,
                              penalite_retard, date_effet)
    VALUES (v_groupe, v_montant, 'MENSUELLE', 2000, v_debut)
    RETURNING id INTO v_regle;

    -- --------------------------------------------------------------- membres
    FOR i IN 1..12 LOOP
        INSERT INTO membre (groupe_id, nom_complet, telephone, date_adhesion)
        VALUES (v_groupe, v_noms[i], v_tels[i], v_debut)
        RETURNING id INTO v_id;
        v_membres := array_append(v_membres, v_id);

        INSERT INTO membre_role (membre_id, role, attribue_le)
        VALUES (v_id, 'MEMBRE', v_debut);

        -- Un compte de cotisation par membre : c'est ce qui permet le relevé
        -- individuel (F-RAP-01) par simple filtrage du journal.
        INSERT INTO compte (groupe_id, nature, libelle, membre_id)
        VALUES (v_groupe, 'COTISATION_MEMBRE', 'Cotisations — ' || v_noms[i], v_id)
        RETURNING id INTO v_id;
        v_comptes := array_append(v_comptes, v_id);
    END LOOP;

    -- Bureau. Awa préside, Marie tient la caisse, Fatou contrôle les comptes.
    -- Les trois rôles sont séparés : c'est la configuration saine que
    -- l'interface doit encourager (F-MBR-06).
    INSERT INTO membre_role (membre_id, role, attribue_le)
    VALUES (v_membres[1], 'PRESIDENT',   v_debut),
           (v_membres[2], 'TRESORIER',   v_debut),
           (v_membres[3], 'COMMISSAIRE', v_debut);
    v_tresorier := v_membres[2];

    INSERT INTO compte (groupe_id, nature, libelle)
    VALUES (v_groupe, 'CAISSE', 'Caisse espèces')
    RETURNING id INTO v_caisse;

    -- ----------------------------------------------------------------- cycle
    INSERT INTO cycle (groupe_id, numero, date_debut, date_fin_prevue, statut)
    VALUES (v_groupe, 1, v_debut, v_debut + INTERVAL '12 months', 'EN_COURS')
    RETURNING id INTO v_cycle;

    -- Ordre de passage arrêté à l'avance (F-TOU-01). Un membre par tour, R-04
    -- garantissant qu'aucun ne passe deux fois.
    FOR i IN 1..12 LOOP
        INSERT INTO tour (cycle_id, rang, beneficiaire_id, date_remise_prevue)
        VALUES (v_cycle, i, v_membres[i],
                (v_debut + ((i - 1) || ' months')::INTERVAL)::DATE)
        RETURNING id INTO v_id;
        v_tours := array_append(v_tours, v_id);
    END LOOP;

    -- Échéances : 12 membres × 12 tours = 144 lignes. Le montant est figé à la
    -- règle en vigueur ce jour-là (R-09).
    FOR i IN 1..12 LOOP
        v_date := (v_debut + ((i - 1) || ' months')::INTERVAL)::DATE;
        FOR j IN 1..12 LOOP
            INSERT INTO echeance (cycle_id, membre_id, tour_id, date_echeance,
                                  montant_attendu)
            VALUES (v_cycle, v_membres[j], v_tours[i], v_date, v_montant);
        END LOOP;
    END LOOP;

    -- ------------------------------------------------ tours 1 et 2 : soldés
    -- Les 12 membres cotisent, la cagnotte est remise au bénéficiaire du rang.
    FOR i IN 1..2 LOOP
        v_date := (v_debut + ((i - 1) || ' months')::INTERVAL)::DATE;

        FOR j IN 1..12 LOOP
            SELECT id INTO v_echeance FROM echeance
             WHERE tour_id = v_tours[i] AND membre_id = v_membres[j];

            INSERT INTO ecriture (groupe_id, date_operation, libelle, nature, saisi_par)
            VALUES (v_groupe, v_date,
                    'Cotisation tour ' || i || ' — ' || v_noms[j],
                    'COTISATION', v_tresorier)
            RETURNING id INTO v_ecriture;

            -- Partie double : la caisse reçoit (débit), le membre est crédité de
            -- sa cotisation. L'utilisateur ne verra jamais ces deux lignes.
            INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
            VALUES (v_ecriture, v_caisse,      'DEBIT',  v_montant, 1),
                   (v_ecriture, v_comptes[j],  'CREDIT', v_montant, 2);

            INSERT INTO cotisation (echeance_id, montant, date_versement, moyen,
                                    ecriture_id, saisi_par)
            VALUES (v_echeance, v_montant, v_date,
                    (CASE WHEN j % 3 = 0 THEN 'MOBILE_MONEY' ELSE 'ESPECES' END)::moyen_paiement,
                    v_ecriture, v_tresorier);
        END LOOP;

        -- Remise de la cagnotte : la caisse se vide au profit du bénéficiaire.
        -- En ROSCA le solde de caisse retombe à zéro à chaque tour (§3.1).
        v_cagnotte := v_montant * 12;

        INSERT INTO ecriture (groupe_id, date_operation, libelle, nature, saisi_par)
        VALUES (v_groupe, v_date + 2,
                'Remise cagnotte tour ' || i || ' — ' || v_noms[i],
                'REMISE_CAGNOTTE', v_tresorier)
        RETURNING id INTO v_ecriture;

        INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
        VALUES (v_ecriture, v_comptes[i], 'DEBIT',  v_cagnotte, 1),
               (v_ecriture, v_caisse,     'CREDIT', v_cagnotte, 2);

        UPDATE tour SET date_remise_reelle = v_date + 2,
                        montant_cagnotte   = v_cagnotte,
                        ecriture_remise_id = v_ecriture
         WHERE id = v_tours[i];
    END LOOP;

    -- ------------------------------------------- tour 3 : en cours, imparfait
    -- 9 membres ont réglé, 1 a versé partiellement, 2 n'ont rien versé. C'est
    -- l'état qui donne du contenu aux écrans d'impayés et de reliquat.
    v_date := (v_debut + INTERVAL '2 months')::DATE;

    -- Borne à 9 et non à 10 : Béatrice occupe l'indice 10 et ne doit RIEN verser,
    -- conformément au commentaire ci-dessus. Une borne à 10 la faisait cotiser
    -- tout en la décrivant comme défaillante — le jeu de données contredisait
    -- alors sa propre intention, et les écrans d'impayés perdaient un cas.
    FOR j IN 1..9 LOOP
        SELECT id INTO v_echeance FROM echeance
         WHERE tour_id = v_tours[3] AND membre_id = v_membres[j];

        -- Khadija (rang 9) ne verse que 10 000 F : reliquat de 15 000 F.
        v_verse := CASE WHEN j = 9 THEN 10000 ELSE v_montant END;

        INSERT INTO ecriture (groupe_id, date_operation, libelle, nature, saisi_par)
        VALUES (v_groupe, v_date, 'Cotisation tour 3 — ' || v_noms[j],
                'COTISATION', v_tresorier)
        RETURNING id INTO v_ecriture;

        INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
        VALUES (v_ecriture, v_caisse,     'DEBIT',  v_verse, 1),
               (v_ecriture, v_comptes[j], 'CREDIT', v_verse, 2);

        INSERT INTO cotisation (echeance_id, montant, date_versement, moyen,
                                ecriture_id, saisi_par)
        VALUES (v_echeance, v_verse, v_date,
                (CASE WHEN j % 3 = 0 THEN 'MOBILE_MONEY' ELSE 'ESPECES' END)::moyen_paiement,
                v_ecriture, v_tresorier);
    END LOOP;

    -- Béatrice (rang 10) et Aminata (rang 11) n'ont pas versé : leurs échéances
    -- restent ATTENDUE, et basculeront en IMPAYEE une fois la date dépassée.
    -- Georgette (rang 12) est dispensée — son commerce a brûlé, le groupe a voté
    -- l'exonération en assemblée (F-COT-07).
    SELECT id INTO v_echeance FROM echeance
     WHERE tour_id = v_tours[3] AND membre_id = v_membres[12];

    UPDATE echeance
       SET statut         = 'DISPENSEE',
           motif_dispense = 'Sinistre commerce — exonération votée en assemblée du 14/03/2026',
           dispense_par   = v_membres[1]
     WHERE id = v_echeance;

    RAISE NOTICE 'Groupe % — 12 membres, cycle 1, 144 échéances, 2 tours soldés', v_groupe;
END $$;

COMMIT;
