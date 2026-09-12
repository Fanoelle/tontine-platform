-- =============================================================================
-- RECETTE — Critère d'acceptation du jalon 1
--
--   « Une tontine rotative de 12 membres mène un cycle complet, la caisse reste
--     équilibrée à chaque tour, et tout écart est traçable. »
--
-- Ce script n'est pas un jeu de données : il EXÉCUTE le cycle entier par les
-- fonctions métier, puis vérifie des propriétés qui doivent tenir à chaque
-- étape. Il échoue bruyamment à la première violation.
--
-- POURQUOI VÉRIFIER À CHAQUE TOUR ET NON SEULEMENT À LA FIN. Un cycle ROSCA
-- vide sa caisse douze fois. Un contrôle final ne distinguerait pas douze tours
-- corrects d'une compensation fortuite entre deux erreurs opposées. La propriété
-- « la caisse retombe à zéro après chaque remise » ne se vérifie qu'en la
-- vérifiant douze fois.
--
-- Usage :  ./scripts/db.sh recette
-- =============================================================================

\set ON_ERROR_STOP on
\timing off

DO $$
DECLARE
    v_groupe      UUID;
    v_cycle       UUID;
    v_tresorier   UUID;
    v_president   UUID;
    v_caisse      UUID;
    v_tour        UUID;
    v_rang        INTEGER;
    v_benef       TEXT;
    v_remis       BIGINT;
    v_suivant     INTEGER;
    v_cloture     BOOLEAN;
    v_solde       BIGINT;
    v_ecart       BIGINT;
    v_echeance    RECORD;
    v_attendu     BIGINT;
    v_encaisse    BIGINT;
    v_total_remis BIGINT := 0;
    v_nb_tours    INTEGER := 0;
    v_nb_remis    INTEGER;
    v_total_cycle BIGINT;
    v_derive      INTEGER;
    v_surregle    INTEGER;
BEGIN
    RAISE NOTICE '';
    RAISE NOTICE '===== RECETTE — cycle ROSCA complet, 12 membres =====';
    RAISE NOTICE '';

    SELECT id INTO v_groupe FROM groupe
     WHERE nom = 'Tontine des Femmes de Bonabéri';
    IF v_groupe IS NULL THEN
        RAISE EXCEPTION 'Jeu de démonstration absent — lancez ./scripts/db.sh reinitialiser';
    END IF;

    SELECT id INTO v_cycle FROM cycle
     WHERE groupe_id = v_groupe AND statut = 'EN_COURS';
    IF v_cycle IS NULL THEN
        RAISE EXCEPTION 'Aucun cycle en cours — lancez ./scripts/db.sh reinitialiser';
    END IF;

    SELECT id INTO v_tresorier FROM membre
     WHERE groupe_id = v_groupe AND nom_complet = 'Marie Ebolo';
    SELECT id INTO v_president FROM membre
     WHERE groupe_id = v_groupe AND nom_complet = 'Awa Ndiaye';
    SELECT id INTO v_caisse FROM compte
     WHERE groupe_id = v_groupe AND nature = 'CAISSE';

    -- ------------------------------------------------------------------------
    -- Déroulé : tant qu'il reste un tour, on encaisse puis on remet.
    -- ------------------------------------------------------------------------
    LOOP
        v_tour := tour_en_cours(v_cycle);
        EXIT WHEN v_tour IS NULL;

        v_nb_tours := v_nb_tours + 1;
        SELECT rang INTO v_rang FROM tour WHERE id = v_tour;

        -- Encaissement de toutes les échéances non soldées du tour. Les
        -- dispensées sont ignorées : le groupe a décidé d'exonérer.
        FOR v_echeance IN
            SELECT e.id, e.montant_attendu - e.montant_regle AS reliquat
              FROM echeance e
             WHERE e.tour_id = v_tour
               AND e.statut NOT IN ('REGLEE', 'DISPENSEE')
               AND e.montant_attendu > e.montant_regle
        LOOP
            PERFORM enregistrer_versement(
                v_echeance.id, v_echeance.reliquat, CURRENT_DATE,
                'ESPECES'::moyen_paiement, v_tresorier);
        END LOOP;

        -- PROPRIÉTÉ 1 — avant remise, la caisse porte exactement ce que le tour
        -- a encaissé, puisque les tours précédents l'ont vidée.
        SELECT cagnotte_encaissee INTO v_encaisse
          FROM v_cagnotte_tour WHERE tour_id = v_tour;
        SELECT solde INTO v_solde FROM v_solde_compte WHERE compte_id = v_caisse;

        IF v_solde <> v_encaisse THEN
            RAISE EXCEPTION
                'Tour % : la caisse porte % F alors que % F ont été encaissés',
                v_rang, v_solde, v_encaisse;
        END IF;

        SELECT montant_remis, beneficiaire, tour_suivant, cycle_cloture
          INTO v_remis, v_benef, v_suivant, v_cloture
          FROM remettre_cagnotte(v_tour, v_tresorier);

        v_total_remis := v_total_remis + v_remis;

        -- PROPRIÉTÉ 2 — la caisse retombe à zéro après chaque remise (§3.1).
        SELECT solde INTO v_solde FROM v_solde_compte WHERE compte_id = v_caisse;
        IF v_solde <> 0 THEN
            RAISE EXCEPTION
                'Tour % : la caisse porte % F après remise, elle devrait être vide',
                v_rang, v_solde;
        END IF;

        -- PROPRIÉTÉ 3 — le journal reste globalement équilibré (R-01).
        SELECT COALESCE(SUM(CASE l.sens WHEN 'DEBIT' THEN l.montant
                                        ELSE -l.montant END), 0)
          INTO v_ecart
          FROM ligne_ecriture l
          JOIN ecriture e ON e.id = l.ecriture_id
         WHERE e.groupe_id = v_groupe;

        IF v_ecart <> 0 THEN
            RAISE EXCEPTION 'Tour % : écart de % F au journal', v_rang, v_ecart;
        END IF;

        RAISE NOTICE '  tour % — % F remis à %  (caisse: 0, journal: équilibré)',
            lpad(v_rang::TEXT, 2), lpad(v_remis::TEXT, 7), v_benef;
    END LOOP;

    -- ------------------------------------------------------------------------
    -- Contrôles de fin de cycle
    -- ------------------------------------------------------------------------
    RAISE NOTICE '';

    -- Le jeu de démonstration livre les tours 1 et 2 DÉJÀ remis : la recette
    -- part d'un cycle en cours, pas d'un cycle vierge. Ce qui doit être vérifié
    -- est donc que les 12 tours du cycle sont remis à la fin — pas que la boucle
    -- en ait joué 12. Compter les tours joués confondrait « cycle complet » et
    -- « tout le cycle exécuté par ce script ».
    SELECT count(*)::INTEGER INTO v_nb_remis
      FROM tour WHERE cycle_id = v_cycle AND date_remise_reelle IS NOT NULL;

    IF v_nb_remis <> 12 THEN
        RAISE EXCEPTION
            'Cycle incomplet : % tours remis sur 12 (dont % joués par la recette)',
            v_nb_remis, v_nb_tours;
    END IF;

    SELECT statut = 'CLOTURE' INTO v_cloture FROM cycle WHERE id = v_cycle;
    IF NOT v_cloture THEN
        RAISE EXCEPTION
            'Le cycle n''est pas clôturé alors que les 12 tours sont remis';
    END IF;

    -- R-04 — chaque membre a bénéficié exactement une fois.
    IF (SELECT count(DISTINCT beneficiaire_id) FROM tour WHERE cycle_id = v_cycle) <> 12
    THEN
        RAISE EXCEPTION 'R-04 : les 12 bénéficiaires ne sont pas distincts';
    END IF;

    IF EXISTS (SELECT 1 FROM tour WHERE cycle_id = v_cycle
                AND date_remise_reelle IS NULL) THEN
        RAISE EXCEPTION 'Un tour au moins n''a pas été remis';
    END IF;

    -- F-ANO-04 — aucune dérive entre la dénormalisation et le journal.
    SELECT count(*) INTO v_derive FROM echeance e
      JOIN cycle c ON c.id = e.cycle_id
     WHERE c.groupe_id = v_groupe
       AND e.montant_regle <> (SELECT COALESCE(SUM(co.montant), 0)
                                 FROM cotisation co WHERE co.echeance_id = e.id);
    IF v_derive > 0 THEN
        RAISE EXCEPTION 'F-ANO-04 : % échéance(s) divergent du journal', v_derive;
    END IF;

    -- Scénario A2 — aucune échéance sur-réglée.
    SELECT count(*) INTO v_surregle FROM echeance e
      JOIN cycle c ON c.id = e.cycle_id
     WHERE c.groupe_id = v_groupe AND e.montant_regle > e.montant_attendu;
    IF v_surregle > 0 THEN
        RAISE EXCEPTION '% échéance(s) réglée(s) au-delà du montant appelé', v_surregle;
    END IF;

    -- CONSERVATION — tout ce qui est entré en caisse en est ressorti.
    --
    -- La comparaison porte sur la TOTALITÉ du cycle : somme des cagnottes
    -- remises (les 12 tours, y compris les deux remis par le jeu de données)
    -- contre somme des cotisations encaissées. Confronter le seul total de la
    -- boucle aux encaissements du cycle entier comparerait 10 tours à 12.
    SELECT COALESCE(SUM(montant_regle), 0) INTO v_attendu
      FROM echeance e JOIN cycle c ON c.id = e.cycle_id
     WHERE c.groupe_id = v_groupe;

    SELECT COALESCE(SUM(montant_cagnotte), 0) INTO v_total_cycle
      FROM tour WHERE cycle_id = v_cycle;

    IF v_total_cycle <> v_attendu THEN
        RAISE EXCEPTION
            'Conservation rompue : % F encaissés, % F remis sur l''ensemble du cycle',
            v_attendu, v_total_cycle;
    END IF;

    -- La caisse doit être vide en fin de cycle : c'est la propriété qui
    -- distingue une ROSCA d'une caisse d'épargne (§3.1).
    SELECT solde INTO v_solde FROM v_solde_compte WHERE compte_id = v_caisse;
    IF v_solde <> 0 THEN
        RAISE EXCEPTION 'Fin de cycle : la caisse porte encore % F', v_solde;
    END IF;

    RAISE NOTICE '  12 tours remis (dont % joués ici), 12 bénéficiaires distincts (R-04)',
        v_nb_tours;
    RAISE NOTICE '  cycle clôturé automatiquement au dernier tour';
    RAISE NOTICE '  % F encaissés = % F remis (conservation)', v_attendu, v_total_cycle;
    RAISE NOTICE '  caisse vide en fin de cycle';
    RAISE NOTICE '  aucune dérive de dénormalisation (F-ANO-04)';
    RAISE NOTICE '  aucune échéance sur-réglée (scénario A2)';
    RAISE NOTICE '';
    RAISE NOTICE '===== RECETTE RÉUSSIE — critère du jalon 1 satisfait =====';
    RAISE NOTICE '';
END $$;
