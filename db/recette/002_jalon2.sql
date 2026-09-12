-- =============================================================================
-- RECETTE — Critère d'acceptation du jalon 2
--
--   « Une cotisation manquante, un remboursement en retard et un déséquilibre
--     de solde sont détectés automatiquement et notifiés. »
--
-- S'y ajoutent les deux mécanismes introduits par ce jalon : un prêt ASCA mené
-- de la demande au solde, et une aide mutualiste de la demande au versement.
--
-- POURQUOI VÉRIFIER L'ÉQUILIBRE APRÈS CHAQUE OPÉRATION ET NON À LA FIN. Un
-- octroi, un remboursement et un versement d'aide produisent chacun une
-- écriture de sens différent. Un contrôle final ne distinguerait pas trois
-- écritures correctes d'une compensation fortuite entre deux erreurs opposées.
--
-- Usage :  ./scripts/db.sh recette-jalon2
-- =============================================================================

\set ON_ERROR_STOP on
\timing off

DO $$
DECLARE
    -- ASCA
    v_asca        UUID;
    v_cycle_asca  UUID;
    v_pres_asca   UUID;
    v_tres_asca   UUID;
    v_emprunteur  UUID;
    v_pret        UUID;
    v_avoir_avant BIGINT;
    v_avoir_apres BIGINT;
    v_restant     BIGINT;
    v_statut_pret statut_pret;
    v_echeances   INTEGER;

    -- MUTUELLE
    v_mut         UUID;
    v_cycle_mut   UUID;
    v_pres_mut    UUID;
    v_tres_mut    UUID;
    v_benef       UUID;
    v_aide        UUID;
    v_fonds_avant BIGINT;
    v_fonds_apres BIGINT;
    v_statut_aide statut_aide;

    -- Contrôles transverses
    v_ecart       BIGINT;
    v_anomalies   INTEGER;
    v_critiques   INTEGER;
    v_interets    BIGINT;
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '===== RECETTE JALON 2 — prêts, aides, anomalies =====';
    RAISE NOTICE '';

    -- ------------------------------------------------------------------------
    -- Repères
    -- ------------------------------------------------------------------------
    SELECT id INTO v_asca FROM groupe WHERE type = 'ASCA';
    SELECT id INTO v_mut  FROM groupe WHERE type = 'MUTUELLE';

    IF v_asca IS NULL OR v_mut IS NULL THEN
        RAISE EXCEPTION
            'Jeux ASCA ou MUTUELLE absents — lancez ./scripts/db.sh reinitialiser';
    END IF;

    SELECT id INTO v_cycle_asca FROM cycle WHERE groupe_id = v_asca AND statut = 'EN_COURS';
    SELECT id INTO v_cycle_mut  FROM cycle WHERE groupe_id = v_mut  AND statut = 'EN_COURS';

    SELECT m.id INTO v_pres_asca FROM membre m
     WHERE m.groupe_id = v_asca AND membre_a_role(m.id, 'PRESIDENT') LIMIT 1;
    SELECT m.id INTO v_tres_asca FROM membre m
     WHERE m.groupe_id = v_asca AND membre_a_role(m.id, 'TRESORIER') LIMIT 1;
    SELECT m.id INTO v_pres_mut FROM membre m
     WHERE m.groupe_id = v_mut AND membre_a_role(m.id, 'PRESIDENT') LIMIT 1;
    SELECT m.id INTO v_tres_mut FROM membre m
     WHERE m.groupe_id = v_mut AND membre_a_role(m.id, 'TRESORIER') LIMIT 1;

    -- Un emprunteur qui n'a pas encore de prêt : le cumul n'est pas le sujet ici.
    SELECT m.id INTO v_emprunteur FROM membre m
     WHERE m.groupe_id = v_asca
       AND NOT membre_a_role(m.id, 'PRESIDENT')
       AND NOT EXISTS (SELECT 1 FROM pret p WHERE p.emprunteur_id = m.id)
     LIMIT 1;

    SELECT m.id INTO v_benef FROM membre m
     WHERE m.groupe_id = v_mut
       AND NOT EXISTS (SELECT 1 FROM aide a WHERE a.beneficiaire_id = m.id)
     LIMIT 1;

    -- ------------------------------------------------------------------------
    -- 1. PARCOURS ASCA — un prêt de la demande au solde
    -- ------------------------------------------------------------------------
    v_avoir_avant := avoir_disponible(v_asca);
    RAISE NOTICE '  ASCA — avoir de la caisse avant octroi : % F', v_avoir_avant;

    v_pret := demander_pret(v_cycle_asca, v_emprunteur, 200000,
                            'Recette — achat de matériel pour le commerce', 4);

    PERFORM approuver_pret(v_pret, 200000, v_pres_asca);

    -- PROPRIÉTÉ 1 — l'octroi vide la caisse du montant prêté, exactement.
    v_avoir_apres := avoir_disponible(v_asca);
    IF v_avoir_avant - v_avoir_apres <> 200000 THEN
        RAISE EXCEPTION
            'Octroi : la caisse a varié de % F au lieu de 200000',
            v_avoir_avant - v_avoir_apres;
    END IF;

    -- PROPRIÉTÉ 2 — l'échéancier est produit à l'octroi (F-PRE-03).
    SELECT count(*)::INTEGER INTO v_echeances
      FROM echeance_pret WHERE pret_id = v_pret;
    IF v_echeances <> 4 THEN
        RAISE EXCEPTION 'Échéancier : % échéances produites au lieu de 4', v_echeances;
    END IF;

    RAISE NOTICE '  ASCA — prêt de 200 000 F octroyé, échéancier de 4 échéances';

    -- Remboursement intégral, échéance par échéance.
    FOR i IN 1..4 LOOP
        PERFORM enregistrer_remboursement(
            v_pret, 50000, 4000, CURRENT_DATE, 'ESPECES', v_tres_asca);

        SELECT p.capital_restant_du INTO v_restant FROM pret p WHERE p.id = v_pret;

        -- PROPRIÉTÉ 3 — le capital restant dû décroît et ne passe jamais sous
        -- zéro (R-07). Le vérifier à chaque échéance, et non à la fin, distingue
        -- une décroissance correcte d'une compensation entre deux erreurs.
        IF v_restant <> 200000 - (50000 * i) THEN
            RAISE EXCEPTION
                'Après %e remboursement : capital restant % F au lieu de %',
                i, v_restant, 200000 - (50000 * i);
        END IF;

        SELECT COALESCE(SUM(CASE l.sens WHEN 'DEBIT' THEN l.montant
                                        ELSE -l.montant END), 0)
          INTO v_ecart
          FROM ligne_ecriture l JOIN ecriture e ON e.id = l.ecriture_id
         WHERE e.groupe_id = v_asca;

        IF v_ecart <> 0 THEN
            RAISE EXCEPTION 'Après %e remboursement : écart de % F au journal', i, v_ecart;
        END IF;
    END LOOP;

    -- PROPRIÉTÉ 4 — le passage à SOLDE est une conséquence du dernier
    -- remboursement, jamais une action.
    SELECT p.statut INTO v_statut_pret FROM pret p WHERE p.id = v_pret;
    IF v_statut_pret <> 'SOLDE' THEN
        RAISE EXCEPTION
            'Le prêt devrait être SOLDE après remboursement intégral, il est %',
            v_statut_pret;
    END IF;

    -- PROPRIÉTÉ 5 — l'intérêt est un PRODUIT du groupe, porté à son propre
    -- compte. Le confondre avec le capital masquerait ce que le prêt a rapporté.
    SELECT COALESCE(vs.solde, 0) INTO v_interets
      FROM compte c LEFT JOIN v_solde_compte vs ON vs.compte_id = c.id
     WHERE c.groupe_id = v_asca AND c.nature = 'PRODUIT_INTERET';

    -- Le solde d'un compte de produit est négatif au sens débit-crédit : il est
    -- alimenté par des crédits. On compare donc sa valeur absolue.
    IF abs(v_interets) < 16000 THEN
        RAISE EXCEPTION
            'Les intérêts perçus (% F) ne reflètent pas les 4 × 4 000 F de ce prêt',
            abs(v_interets);
    END IF;

    RAISE NOTICE '  ASCA — prêt soldé, 16 000 F d''intérêts portés au produit';

    -- PROPRIÉTÉ 6 — un prêt soldé est TERMINAL.
    BEGIN
        UPDATE pret SET statut = 'EN_REMBOURSEMENT' WHERE id = v_pret;
        RAISE EXCEPTION 'Un prêt soldé a pu être rouvert — R-07 compromis';
    EXCEPTION WHEN check_violation THEN
        NULL;  -- refus attendu
    END;

    -- ------------------------------------------------------------------------
    -- 2. PARCOURS MUTUELLE — une aide de la demande au versement
    -- ------------------------------------------------------------------------
    v_fonds_avant := avoir_disponible(v_mut);
    RAISE NOTICE '';
    RAISE NOTICE '  MUTUELLE — fonds avant versement : % F', v_fonds_avant;

    v_aide := demander_aide(v_cycle_mut, v_benef, 50000,
                            'Recette — frais médicaux à la suite d''un accident');

    -- Le groupe arbitre : 35 000 accordés sur 50 000 demandés. Une aide est une
    -- décision, jamais un droit.
    PERFORM approuver_aide(v_aide, 35000, v_pres_mut);
    PERFORM verser_aide(v_aide, v_tres_mut);

    v_fonds_apres := avoir_disponible(v_mut);

    -- PROPRIÉTÉ 7 — le versement consomme exactement le montant accordé.
    IF v_fonds_avant - v_fonds_apres <> 35000 THEN
        RAISE EXCEPTION
            'Versement d''aide : le fonds a varié de % F au lieu de 35000',
            v_fonds_avant - v_fonds_apres;
    END IF;

    SELECT a.statut INTO v_statut_aide FROM aide a WHERE a.id = v_aide;
    IF v_statut_aide <> 'VERSEE' THEN
        RAISE EXCEPTION 'L''aide devrait être VERSEE, elle est %', v_statut_aide;
    END IF;

    -- PROPRIÉTÉ 8 — une aide n'ouvre AUCUNE créance. C'est ce qui la distingue
    -- d'un prêt, et l'oublier transformerait un secours en dette.
    IF EXISTS (
        SELECT 1 FROM compte c
         WHERE c.groupe_id = v_mut
           AND c.nature = 'CREANCE_PRET'
           AND c.membre_id = v_benef
    ) THEN
        RAISE EXCEPTION
            'Une créance a été ouverte au nom du bénéficiaire — une aide n''est '
            'pas remboursable';
    END IF;

    RAISE NOTICE '  MUTUELLE — 35 000 F remis sur 50 000 demandés, aucune créance';

    -- ------------------------------------------------------------------------
    -- 3. MOTEUR D'ANOMALIES — le critère d'acceptation proprement dit
    -- ------------------------------------------------------------------------
    RAISE NOTICE '';

    -- On provoque un déséquilibre : une écriture crédite un compte de cotisation
    -- SANS passer par la table cotisation. C'est exactement ce qu'un registre
    -- doit révéler.
    DECLARE
        v_ecr    UUID;
        v_caisse UUID;
        v_cot    UUID;
    BEGIN
        SELECT id INTO v_caisse FROM compte
         WHERE groupe_id = v_asca AND nature = 'CAISSE' AND membre_id IS NULL;
        SELECT id INTO v_cot FROM compte
         WHERE groupe_id = v_asca AND nature = 'COTISATION_MEMBRE' LIMIT 1;

        INSERT INTO ecriture (groupe_id, date_operation, libelle, nature, saisi_par)
        VALUES (v_asca, CURRENT_DATE, 'Recette — versement hors imputation',
                'COTISATION', v_tres_asca)
        RETURNING id INTO v_ecr;

        INSERT INTO ligne_ecriture (ecriture_id, compte_id, sens, montant, ordre)
        VALUES (v_ecr, v_caisse, 'DEBIT', 9000, 1),
               (v_ecr, v_cot,    'CREDIT', 9000, 2);
    END;

    PERFORM balayer_anomalies(v_asca);

    SELECT count(*)::INTEGER INTO v_anomalies
      FROM v_anomalie_ouverte WHERE groupe_id = v_asca;

    SELECT count(*)::INTEGER INTO v_critiques
      FROM v_anomalie_ouverte WHERE groupe_id = v_asca AND gravite = 'CRITIQUE';

    IF v_critiques = 0 THEN
        RAISE EXCEPTION
            'Le déséquilibre provoqué n''a pas été détecté — F-ANO-04 est aveugle';
    END IF;

    RAISE NOTICE '  ANOMALIES — % ouverte(s) dont % critique(s), déséquilibre détecté',
        v_anomalies, v_critiques;

    -- PROPRIÉTÉ 9 — une levée sans motif est refusée (F-ANO-08).
    DECLARE
        v_ano  UUID;
        v_comm UUID;
    BEGIN
        SELECT id INTO v_ano FROM v_anomalie_ouverte
         WHERE groupe_id = v_asca AND gravite = 'CRITIQUE' LIMIT 1;
        SELECT m.id INTO v_comm FROM membre m
         WHERE m.groupe_id = v_asca AND membre_a_role(m.id, 'COMMISSAIRE') LIMIT 1;

        BEGIN
            PERFORM lever_anomalie(v_ano, '   ', v_comm);
            RAISE EXCEPTION 'Une levée sans motif a été acceptée — F-ANO-08 compromis';
        EXCEPTION WHEN check_violation THEN
            NULL;
        END;

        -- PROPRIÉTÉ 10 — une anomalie critique n'est levée que par le
        -- commissaire (F-ANO-09), afin qu'un écart sérieux ne soit jamais levé
        -- par la personne dont la saisie est en cause.
        BEGIN
            PERFORM lever_anomalie(v_ano,
                'Recette — tentative de levée par le trésorier', v_tres_asca);
            RAISE EXCEPTION
                'Le trésorier a pu lever une anomalie critique — F-ANO-09 compromis';
        EXCEPTION WHEN insufficient_privilege THEN
            NULL;
        END;

        PERFORM lever_anomalie(v_ano,
            'Recette — écart provoqué volontairement pour éprouver la détection',
            v_comm);

        -- PROPRIÉTÉ 11 — lever n'est pas effacer. L'anomalie sort du tableau de
        -- bord mais reste au dossier avec son motif.
        IF NOT EXISTS (
            SELECT 1 FROM anomalie
             WHERE id = v_ano AND statut = 'LEVEE'
               AND length(btrim(motif_levee)) > 0
               AND levee_par IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'L''anomalie levée n''a pas conservé son motif';
        END IF;

        IF EXISTS (SELECT 1 FROM v_anomalie_ouverte WHERE id = v_ano) THEN
            RAISE EXCEPTION 'Une anomalie levée figure encore parmi les ouvertes';
        END IF;
    END;

    RAISE NOTICE '  ANOMALIES — levée sans motif refusée, levée par le trésorier refusée';
    RAISE NOTICE '  ANOMALIES — levée par le commissaire acceptée, motif conservé';

    -- ------------------------------------------------------------------------
    -- 4. Contrôles transverses
    -- ------------------------------------------------------------------------
    RAISE NOTICE '';

    -- Les trois journaux restent équilibrés, séparément.
    FOR v_ecart IN
        SELECT COALESCE(SUM(CASE l.sens WHEN 'DEBIT' THEN l.montant
                                        ELSE -l.montant END), 0)
          FROM groupe g
          LEFT JOIN ecriture e       ON e.groupe_id = g.id
          LEFT JOIN ligne_ecriture l ON l.ecriture_id = e.id
         GROUP BY g.id
    LOOP
        IF v_ecart <> 0 THEN
            RAISE EXCEPTION 'Un journal de groupe présente un écart de % F', v_ecart;
        END IF;
    END LOOP;

    -- Chaque spécialisation reste chez elle (décision 0002).
    IF EXISTS (
        SELECT 1 FROM pret p JOIN cycle c ON c.id = p.cycle_id
         JOIN groupe g ON g.id = c.groupe_id WHERE g.type <> 'ASCA'
    ) THEN
        RAISE EXCEPTION 'Un prêt existe hors d''un groupe ASCA';
    END IF;

    IF EXISTS (
        SELECT 1 FROM aide a JOIN cycle c ON c.id = a.cycle_id
         JOIN groupe g ON g.id = c.groupe_id WHERE g.type <> 'MUTUELLE'
    ) THEN
        RAISE EXCEPTION 'Une aide existe hors d''un groupe MUTUELLE';
    END IF;

    IF EXISTS (
        SELECT 1 FROM tour t JOIN cycle c ON c.id = t.cycle_id
         JOIN groupe g ON g.id = c.groupe_id WHERE g.type <> 'ROSCA'
    ) THEN
        RAISE EXCEPTION 'Un tour existe hors d''un groupe ROSCA';
    END IF;

    RAISE NOTICE '  TRANSVERSE — les trois journaux équilibrés séparément';
    RAISE NOTICE '  TRANSVERSE — chaque spécialisation reste dans son mécanisme';
    RAISE NOTICE '';
    RAISE NOTICE '===== RECETTE JALON 2 RÉUSSIE =====';
    RAISE NOTICE '';
END $$;
