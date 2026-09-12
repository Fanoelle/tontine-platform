-- =============================================================================
-- Jeu de démonstration ASCA — « Caisse d'épargne des Jeunes de Deido »
--
-- Un second groupe, de mécanisme DIFFÉRENT du premier, sur la même base. C'est
-- ce qui éprouve réellement le cloisonnement (N-SEC-02) et la cohérence de type
-- (décision 0002) : tant qu'un seul groupe existe, aucune fuite transversale
-- n'est observable, et rien ne prouve qu'un prêt soit refusé sur une ROSCA.
--
-- DIFFÉRENCE STRUCTURANTE AVEC LA ROSCA. Ici la caisse CROÎT : les cotisations
-- s'accumulent, la caisse prête avec intérêt, et le capital est redistribué en
-- fin de cycle au prorata des parts. Le solde de caisse ne retombe jamais à
-- zéro — c'est l'inverse exact de la propriété vérifiée par la recette ROSCA.
--
-- Dates RELATIVES au jour de chargement, et `cree_le` antidaté : un décor aux
-- dates figées vieillit et met en défaut les règles de détection qu'il illustre
-- (voir 001_demonstration.sql).
-- =============================================================================

BEGIN;

DO $$
DECLARE
    v_groupe UUID;
BEGIN
    SELECT id INTO v_groupe FROM groupe
     WHERE nom = 'Caisse d''épargne des Jeunes de Deido';
    IF v_groupe IS NULL THEN RETURN; END IF;

    SET LOCAL session_replication_role = replica;

    DELETE FROM remboursement WHERE pret_id IN (
        SELECT p.id FROM pret p JOIN cycle c ON c.id = p.cycle_id
         WHERE c.groupe_id = v_groupe);
    DELETE FROM echeance_pret WHERE pret_id IN (
        SELECT p.id FROM pret p JOIN cycle c ON c.id = p.cycle_id
         WHERE c.groupe_id = v_groupe);
    DELETE FROM pret WHERE cycle_id IN (SELECT id FROM cycle WHERE groupe_id = v_groupe);
    DELETE FROM epargne_membre WHERE cycle_id IN (
        SELECT id FROM cycle WHERE groupe_id = v_groupe);
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
    v_groupe    UUID;
    v_cycle     UUID;
    v_caisse    UUID;
    v_debut     DATE := (date_trunc('month', CURRENT_DATE) - INTERVAL '5 months')::DATE + 9;
    v_montant   BIGINT := 50000;

    v_noms TEXT[] := ARRAY[
        'Émile Njoya', 'Patrick Mbappé', 'Sandrine Tchoumi', 'Yves Bikoi',
        'Nadège Fotso', 'Serge Onana', 'Clarisse Mbia', 'Thierry Essomba'];
    v_tels TEXT[] := ARRAY[
        '+237677220001', '+237677220002', '+237677220003', '+237677220004',
        '+237677220005', '+237677220006', '+237677220007', '+237677220008'];

    v_membres UUID[] := ARRAY[]::UUID[];
    v_comptes UUID[] := ARRAY[]::UUID[];

    v_id        UUID;
    v_ecriture  UUID;
    v_echeance  UUID;
    v_tresorier UUID;
    v_president UUID;
    v_pret      UUID;
    v_date      DATE;
    i           INTEGER;
    j           INTEGER;
BEGIN
    INSERT INTO groupe (nom, type, devise, date_creation)
    VALUES ('Caisse d''épargne des Jeunes de Deido', 'ASCA', 'XAF', v_debut)
    RETURNING id INTO v_groupe;

    -- Taux d'intérêt de 2 % par période : la caisse prête et perçoit un produit,
    -- ce qui n'existe pas en ROSCA.
    INSERT INTO regle_groupe (groupe_id, montant_cotisation, periodicite,
                              taux_interet_pret, penalite_retard, date_effet)
    VALUES (v_groupe, v_montant, 'MENSUELLE', 0.0200, 5000, v_debut);

    FOR i IN 1..8 LOOP
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

    INSERT INTO cycle (groupe_id, numero, date_debut, date_fin_prevue, statut)
    VALUES (v_groupe, 1, v_debut, v_debut + INTERVAL '12 months', 'EN_COURS')
    RETURNING id INTO v_cycle;

    -- AUCUN TOUR : une ASCA n'a pas d'ordre de passage. Le déclencheur
    -- trg_tour_rosca refuserait d'ailleurs d'en créer un ici.
    --
    -- Cinq mois d'échéances, toutes réglées : la caisse a donc accumulé
    -- 8 × 50 000 × 5 = 2 000 000 F, dont une partie est prêtée.
    FOR i IN 1..5 LOOP
        v_date := (v_debut + ((i - 1) || ' months')::INTERVAL)::DATE;
        FOR j IN 1..8 LOOP
            INSERT INTO echeance (cycle_id, membre_id, date_echeance, montant_attendu)
            VALUES (v_cycle, v_membres[j], v_date, v_montant)
            RETURNING id INTO v_echeance;

            INSERT INTO ecriture (groupe_id, date_operation, libelle, nature,
                                  saisi_par, cree_le)
            VALUES (v_groupe, v_date, 'Cotisation — ' || v_noms[j],
                    'COTISATION', v_tresorier,
                    v_date::TIMESTAMPTZ + INTERVAL '10 hours')
            RETURNING id INTO v_ecriture;

            INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
            VALUES (v_ecriture, v_caisse,     'DEBIT',  v_montant, 1),
                   (v_ecriture, v_comptes[j], 'CREDIT', v_montant, 2);

            INSERT INTO cotisation (echeance_id, montant, date_versement, moyen,
                                    reference_externe, ecriture_id, saisi_par)
            VALUES (v_echeance, v_montant, v_date,
                    (CASE WHEN j % 4 = 0 THEN 'MOBILE_MONEY' ELSE 'ESPECES' END)::moyen_paiement,
                    CASE WHEN j % 4 = 0
                         THEN 'MM' || to_char(v_date, 'YYMMDD') || lpad((i*100+j)::TEXT, 5, '0')
                    END,
                    v_ecriture, v_tresorier);
        END LOOP;

        -- Épargne individuelle : une part par échéance réglée.
        FOR j IN 1..8 LOOP
            INSERT INTO epargne_membre (cycle_id, membre_id, parts, solde_calcule)
            VALUES (v_cycle, v_membres[j], 1, v_montant)
            ON CONFLICT (cycle_id, membre_id) DO UPDATE
               SET parts         = epargne_membre.parts + 1,
                   solde_calcule = epargne_membre.solde_calcule + v_montant;
        END LOOP;
    END LOOP;

    -- ------------------------------------------------- un prêt en cours
    -- Yves emprunte 300 000 F il y a trois mois, remboursables en 4 échéances.
    -- Deux sont honorées, la troisième vient d'échoir : de quoi montrer un
    -- encours, un échéancier, et bientôt une anomalie de retard.
    v_date := (v_debut + INTERVAL '2 months')::DATE;

    INSERT INTO pret (cycle_id, emprunteur_id, montant_demande, montant_accorde,
                      taux_interet, nombre_echeances, capital_restant_du,
                      statut, motif_demande, date_demande, date_decision,
                      decide_par)
    VALUES (v_cycle, v_membres[4], 300000, 300000, 0.0200, 4, 300000,
            'EN_REMBOURSEMENT', 'Achat d''un congélateur pour le commerce',
            v_date, v_date, v_president)
    RETURNING id INTO v_pret;

    DECLARE
        v_compte_creance UUID;
        v_compte_interet UUID;
        v_k INTEGER;
    BEGIN
        INSERT INTO compte (groupe_id, nature, libelle, membre_id)
        VALUES (v_groupe, 'CREANCE_PRET', 'Créance de prêt — ' || v_noms[4], v_membres[4])
        RETURNING id INTO v_compte_creance;

        INSERT INTO compte (groupe_id, nature, libelle)
        VALUES (v_groupe, 'PRODUIT_INTERET', 'Intérêts perçus')
        RETURNING id INTO v_compte_interet;

        -- Écriture d'octroi : la caisse se vide, la créance naît.
        INSERT INTO ecriture (groupe_id, date_operation, libelle, nature,
                              saisi_par, cree_le)
        VALUES (v_groupe, v_date, 'Octroi de prêt — ' || v_noms[4],
                'OCTROI_PRET', v_president,
                v_date::TIMESTAMPTZ + INTERVAL '14 hours')
        RETURNING id INTO v_ecriture;

        INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
        VALUES (v_ecriture, v_compte_creance, 'DEBIT',  300000, 1),
               (v_ecriture, v_caisse,         'CREDIT', 300000, 2);

        UPDATE pret SET ecriture_octroi_id = v_ecriture WHERE id = v_pret;

        -- Échéancier : 75 000 F de capital et 6 000 F d'intérêt par échéance.
        FOR v_k IN 1..4 LOOP
            INSERT INTO echeance_pret (pret_id, numero, date_echeance,
                                       montant_capital, montant_interet)
            VALUES (v_pret, v_k, (v_date + (INTERVAL '1 month' * v_k))::DATE,
                    75000, 6000);
        END LOOP;

        -- Deux remboursements honorés.
        FOR v_k IN 1..2 LOOP
            DECLARE v_ech_pret UUID; v_d DATE;
            BEGIN
                v_d := (v_date + (INTERVAL '1 month' * v_k))::DATE;
                SELECT id INTO v_ech_pret FROM echeance_pret
                 WHERE pret_id = v_pret AND numero = v_k;

                INSERT INTO ecriture (groupe_id, date_operation, libelle, nature,
                                      saisi_par, cree_le)
                VALUES (v_groupe, v_d, 'Remboursement de prêt — ' || v_noms[4],
                        'REMBOURSEMENT_PRET', v_tresorier,
                        v_d::TIMESTAMPTZ + INTERVAL '10 hours')
                RETURNING id INTO v_ecriture;

                -- La caisse reçoit capital + intérêt ; la créance s'éteint du
                -- capital ; l'intérêt est un produit distinct.
                INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
                VALUES (v_ecriture, v_caisse,         'DEBIT',  81000, 1),
                       (v_ecriture, v_compte_creance, 'CREDIT', 75000, 2),
                       (v_ecriture, v_compte_interet, 'CREDIT',  6000, 3);

                INSERT INTO remboursement (pret_id, echeance_pret_id,
                                           montant_capital, montant_interet,
                                           date_versement, moyen, ecriture_id,
                                           saisi_par)
                VALUES (v_pret, v_ech_pret, 75000, 6000, v_d, 'ESPECES',
                        v_ecriture, v_tresorier);
            END;
        END LOOP;
    END;

    RAISE NOTICE 'Groupe ASCA % — 8 membres, 5 mois cotisés, 1 prêt en cours', v_groupe;
END $$;

-- Comptes de connexion du groupe ASCA — même mot de passe que la démonstration
-- ROSCA, pour ne pas multiplier les identifiants de démonstration.
DO $$
DECLARE
    v_groupe UUID;
    v_hash   TEXT := '$2b$12$bd0aQLSwtB9YjHpTTOjqOOY7.cwZ8nk1bUBczf0Q2KBjrS2fg7ur6';
    v_membre UUID;
BEGIN
    SELECT id INTO v_groupe FROM groupe
     WHERE nom = 'Caisse d''épargne des Jeunes de Deido';
    IF v_groupe IS NULL THEN RETURN; END IF;

    SELECT id INTO v_membre FROM membre
     WHERE groupe_id = v_groupe AND nom_complet = 'Émile Njoya';
    INSERT INTO utilisateur (membre_id, telephone, mot_de_passe_hash)
    VALUES (v_membre, '+237677220001', v_hash);

    SELECT id INTO v_membre FROM membre
     WHERE groupe_id = v_groupe AND nom_complet = 'Patrick Mbappé';
    INSERT INTO utilisateur (membre_id, telephone, mot_de_passe_hash)
    VALUES (v_membre, '+237677220002', v_hash);

    RAISE NOTICE 'ASCA : 2 comptes (président, trésorier) — mot de passe : tontine2026';
END $$;

COMMIT;
