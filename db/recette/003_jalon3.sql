-- =============================================================================
-- RECETTE — Critère d'acceptation du jalon 3
--
--   « Rapprochement Mobile Money, exports, rapport d'assemblée, archivage,
--     redistribution de fin de cycle. »
--
-- Ces fonctions closent la vie d'un groupe ou la confrontent à l'extérieur. Le
-- fil de la recette est donc ce qu'elles NE doivent PAS faire : le
-- rééchelonnement ne doit pas alléger la dette, le rapprochement ne doit rien
-- écrire, l'archivage ne doit pas faire disparaître une créance vivante, et le
-- rapport ne doit taire aucun écart.
--
-- Usage :  ./scripts/db.sh recette-jalon3
-- =============================================================================

\set ON_ERROR_STOP on
\timing off

DO $$
DECLARE
    v_asca        UUID;
    v_mut         UUID;
    v_rosca       UUID;
    v_cycle_asca  UUID;
    v_pres_asca   UUID;
    v_tres_asca   UUID;
    v_pret        UUID;
    v_capital     BIGINT;
    v_apres       BIGINT;
    v_reglees     INTEGER;
    v_reglees2    INTEGER;
    v_releve      UUID;
    v_ecritures   INTEGER;
    v_ecritures2  INTEGER;
    v_rapproches  INTEGER;
    v_orphelins   INTEGER;
    v_lignes      INTEGER;
    v_total       BIGINT;
    v_interets    BIGINT;
    v_parts       INTEGER;
    v_equilibre   TEXT;
    v_c           RECORD;
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '===== RECETTE JALON 3 — ouverture et confort =====';
    RAISE NOTICE '';

    SELECT id INTO v_asca  FROM groupe WHERE type = 'ASCA';
    SELECT id INTO v_mut   FROM groupe WHERE type = 'MUTUELLE';
    SELECT id INTO v_rosca FROM groupe WHERE type = 'ROSCA';

    IF v_asca IS NULL OR v_mut IS NULL OR v_rosca IS NULL THEN
        RAISE EXCEPTION
            'Les trois jeux de démonstration sont requis — ./scripts/db.sh reinitialiser';
    END IF;

    SELECT id INTO v_cycle_asca FROM cycle
     WHERE groupe_id = v_asca AND statut = 'EN_COURS';
    SELECT m.id INTO v_pres_asca FROM membre m
     WHERE m.groupe_id = v_asca AND membre_a_role(m.id, 'PRESIDENT') LIMIT 1;
    SELECT m.id INTO v_tres_asca FROM membre m
     WHERE m.groupe_id = v_asca AND membre_a_role(m.id, 'TRESORIER') LIMIT 1;

    -- ------------------------------------------------------------------------
    -- 1. F-PRE-07 — rééchelonner n'allège JAMAIS la dette
    -- ------------------------------------------------------------------------
    SELECT p.id, p.capital_restant_du INTO v_pret, v_capital
      FROM pret p
     WHERE p.cycle_id = v_cycle_asca
       AND p.statut IN ('EN_REMBOURSEMENT', 'EN_RETARD')
     LIMIT 1;

    SELECT count(*)::INTEGER INTO v_reglees
      FROM echeance_pret WHERE pret_id = v_pret AND statut = 'REGLEE';

    PERFORM reechelonner_pret(
        v_pret, 6, 'Recette — récolte retardée par la saison des pluies',
        v_pres_asca);

    SELECT p.capital_restant_du INTO v_apres FROM pret p WHERE p.id = v_pret;

    IF v_apres <> v_capital THEN
        RAISE EXCEPTION
            'Le rééchelonnement a modifié le capital : % -> %. Un aménagement '
            'n''est pas une remise de dette.', v_capital, v_apres;
    END IF;

    -- PROPRIÉTÉ — les échéances DÉJÀ RÉGLÉES sont conservées. Elles portent des
    -- remboursements rattachés à des écritures : les effacer romprait le lien
    -- entre l'argent reçu et ce qu'il acquittait.
    SELECT count(*)::INTEGER INTO v_reglees2
      FROM echeance_pret WHERE pret_id = v_pret AND statut = 'REGLEE';

    IF v_reglees2 <> v_reglees THEN
        RAISE EXCEPTION
            'Le rééchelonnement a supprimé % échéance(s) déjà réglée(s)',
            v_reglees - v_reglees2;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM reechelonnement WHERE pret_id = v_pret) THEN
        RAISE EXCEPTION 'Le rééchelonnement n''a pas été consigné (N-TRC-03)';
    END IF;

    RAISE NOTICE '  F-PRE-07 — capital inchangé à % F, % échéance(s) réglée(s) conservée(s)',
        v_capital, v_reglees;

    -- ------------------------------------------------------------------------
    -- 2. F-TRX-06 — le rapprochement ne touche PAS au journal
    -- ------------------------------------------------------------------------
    SELECT count(*)::INTEGER INTO v_ecritures FROM ecriture;

    INSERT INTO releve_mobile_money (groupe_id, operateur, periode_debut,
                                     periode_fin, importe_par)
    VALUES (v_rosca, 'MTN Mobile Money', CURRENT_DATE - 120, CURRENT_DATE,
            (SELECT m.id FROM membre m
              WHERE m.groupe_id = v_rosca AND membre_a_role(m.id, 'TRESORIER')
              LIMIT 1))
    RETURNING id INTO v_releve;

    -- Trois versements réels du registre, repris fidèlement...
    FOR v_c IN
        SELECT c.reference_externe, c.montant, c.date_versement
          FROM cotisation c
          JOIN echeance e  ON e.id = c.echeance_id
          JOIN cycle   cy  ON cy.id = e.cycle_id
         WHERE cy.groupe_id = v_rosca AND c.reference_externe IS NOT NULL
         LIMIT 3
    LOOP
        INSERT INTO ligne_releve (releve_id, reference, montant,
                                  date_operation, libelle)
        VALUES (v_releve, v_c.reference_externe, v_c.montant,
                v_c.date_versement, 'Dépôt');
    END LOOP;

    -- ... et une ligne orpheline : un versement reçu que personne n'a saisi.
    INSERT INTO ligne_releve (releve_id, reference, montant, date_operation,
                              libelle)
    VALUES (v_releve, 'MM-RECETTE-ORPHELIN', 25000, CURRENT_DATE - 3, 'Dépôt');

    SELECT rapproches, absents_du_registre
      INTO v_rapproches, v_orphelins
      FROM synthese_rapprochement(v_releve);

    IF v_rapproches <> 3 THEN
        RAISE EXCEPTION
            'Rapprochement : % versements retrouvés au lieu de 3', v_rapproches;
    END IF;

    IF v_orphelins < 1 THEN
        RAISE EXCEPTION
            'La ligne orpheline n''a pas été signalée — le rapprochement est aveugle';
    END IF;

    SELECT count(*)::INTEGER INTO v_ecritures2 FROM ecriture;

    -- PROPRIÉTÉ DÉCISIVE — un relevé d'opérateur est une source EXTERNE. En
    -- importer les lignes comme des versements reviendrait à laisser un tiers
    -- écrire dans les comptes du groupe.
    IF v_ecritures2 <> v_ecritures THEN
        RAISE EXCEPTION
            'Le rapprochement a créé % écriture(s) — il doit signaler, jamais écrire',
            v_ecritures2 - v_ecritures;
    END IF;

    RAISE NOTICE '  F-TRX-06 — % rapprochés, % orphelin(s), 0 écriture créée',
        v_rapproches, v_orphelins;

    -- ------------------------------------------------------------------------
    -- 3. F-EPA-03/04 — redistribution au prorata des PARTS
    -- ------------------------------------------------------------------------
    SELECT count(*)::INTEGER, SUM(total_a_restituer)
      INTO v_lignes, v_total
      FROM decompte_redistribution(v_cycle_asca);

    IF v_lignes <> 8 THEN
        RAISE EXCEPTION
            'Décompte de redistribution : % membres au lieu de 8', v_lignes;
    END IF;

    -- Chaque total est bien la somme de l'épargne et de la quote-part : une
    -- redistribution qui ne se décompose pas est incontestable, donc suspecte.
    FOR v_c IN SELECT * FROM decompte_redistribution(v_cycle_asca) LOOP
        IF v_c.total_a_restituer <> v_c.epargne + v_c.quote_part THEN
            RAISE EXCEPTION
                'Décompte incohérent pour % : % ≠ % + %',
                v_c.nom_complet, v_c.total_a_restituer,
                v_c.epargne, v_c.quote_part;
        END IF;
    END LOOP;

    RAISE NOTICE '  F-EPA-03/04 — 8 décomptes, % F à restituer au total', v_total;

    -- La redistribution n'a de sens qu'en ASCA.
    BEGIN
        PERFORM * FROM decompte_redistribution(
            (SELECT id FROM cycle WHERE groupe_id = v_rosca AND statut = 'EN_COURS'));
        RAISE EXCEPTION 'La redistribution a été acceptée sur une ROSCA';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    -- ------------------------------------------------------------------------
    -- 4. F-GRP-06 — archiver ne fait pas disparaître une créance vivante
    -- ------------------------------------------------------------------------
    BEGIN
        PERFORM archiver_groupe(v_asca, v_pres_asca);
        RAISE EXCEPTION
            'Un groupe avec un prêt en cours a pu être archivé — la créance '
            'aurait disparu des listes actives';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    -- L'archivage par le trésorier est refusé : c'est une décision du groupe.
    BEGIN
        PERFORM archiver_groupe(v_asca, v_tres_asca);
        RAISE EXCEPTION 'Le trésorier a pu archiver le groupe';
    EXCEPTION WHEN insufficient_privilege OR check_violation THEN
        NULL;
    END;

    RAISE NOTICE '  F-GRP-06 — archivage refusé : 1 cycle ouvert, 1 prêt en cours';

    -- ------------------------------------------------------------------------
    -- 5. F-RAP-05 — le rapport dit ce qui ne va pas
    -- ------------------------------------------------------------------------
    FOR v_c IN
        SELECT g.id, g.type FROM groupe g ORDER BY g.type
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM rapport_assemblee(v_c.id)
             WHERE intitule = 'Équilibre du journal'
        ) THEN
            RAISE EXCEPTION
                'Le rapport du groupe % ne mentionne pas l''équilibre du journal',
                v_c.type;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM rapport_assemblee(v_c.id)
             WHERE intitule = 'Points à vérifier'
        ) THEN
            RAISE EXCEPTION
                'Le rapport du groupe % tait les anomalies ouvertes — un rapport '
                'qui rassure au lieu de rendre compte', v_c.type;
        END IF;

        SELECT valeur INTO v_equilibre
          FROM rapport_assemblee(v_c.id)
         WHERE intitule = 'Équilibre du journal';

        IF v_equilibre <> 'équilibré' THEN
            RAISE EXCEPTION 'Groupe % : journal %', v_c.type, v_equilibre;
        END IF;
    END LOOP;

    -- Les rubriques suivent le mécanisme : un rapport ROSCA parlant de prêts
    -- promettrait une fonction qui n'existe pas pour ce groupe.
    IF EXISTS (SELECT 1 FROM rapport_assemblee(v_rosca) WHERE rubrique = 'Prêts')
    THEN
        RAISE EXCEPTION 'Le rapport ROSCA comporte une rubrique Prêts';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM rapport_assemblee(v_asca) WHERE rubrique = 'Prêts')
    THEN
        RAISE EXCEPTION 'Le rapport ASCA ne comporte pas de rubrique Prêts';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM rapport_assemblee(v_mut) WHERE rubrique = 'Entraide')
    THEN
        RAISE EXCEPTION 'Le rapport MUTUELLE ne comporte pas de rubrique Entraide';
    END IF;

    RAISE NOTICE '  F-RAP-05 — 3 rapports, rubriques propres à chaque mécanisme';

    -- ------------------------------------------------------------------------
    -- 6. F-RAP-06 — les exports sont ouvrables tels quels
    -- ------------------------------------------------------------------------
    SELECT count(*)::INTEGER INTO v_lignes
      FROM exporter_journal_csv(v_rosca) s;

    IF v_lignes < 10 THEN
        RAISE EXCEPTION 'Export du journal : % ligne(s) seulement', v_lignes;
    END IF;

    -- L'échappement est ce qui sépare un export utilisable d'un fichier qui
    -- décale toutes ses colonnes au premier motif contenant un point-virgule.
    IF echapper_csv('Sinistre; incendie du "dépôt"')
       <> '"Sinistre; incendie du ""dépôt"""' THEN
        RAISE EXCEPTION 'L''échappement CSV est incorrect';
    END IF;

    SELECT count(*)::INTEGER INTO v_lignes FROM exporter_membres_csv(v_mut) s;
    IF v_lignes <> 11 THEN
        RAISE EXCEPTION
            'Export des membres : % lignes au lieu de 11 (10 membres + entête)',
            v_lignes;
    END IF;

    RAISE NOTICE '  F-RAP-06 — exports produits, séparateurs et guillemets échappés';

    -- ------------------------------------------------------------------------
    -- 7. Contrôle transverse
    -- ------------------------------------------------------------------------
    FOR v_c IN
        SELECT g.type,
               COALESCE(SUM(CASE l.sens WHEN 'DEBIT' THEN l.montant
                                        ELSE -l.montant END), 0) AS ecart
          FROM groupe g
          LEFT JOIN ecriture e       ON e.groupe_id = g.id
          LEFT JOIN ligne_ecriture l ON l.ecriture_id = e.id
         GROUP BY g.type
    LOOP
        IF v_c.ecart <> 0 THEN
            RAISE EXCEPTION 'Journal du groupe % : écart de % F', v_c.type, v_c.ecart;
        END IF;
    END LOOP;

    RAISE NOTICE '';
    RAISE NOTICE '  TRANSVERSE — les trois journaux équilibrés séparément';
    RAISE NOTICE '';
    RAISE NOTICE '===== RECETTE JALON 3 RÉUSSIE =====';
    RAISE NOTICE '';
END $$;
