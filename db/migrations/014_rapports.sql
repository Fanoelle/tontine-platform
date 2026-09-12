-- =============================================================================
-- 014 — Rapport d'assemblée générale et exports (F-RAP-05, F-RAP-06)
--
-- CE QUE DOIT ÊTRE UN RAPPORT D'ASSEMBLÉE. Un document qu'une personne lit à
-- voix haute devant le groupe, et que chacun doit pouvoir contester chiffre en
-- main. Il ne présente donc AUCUNE valeur qui ne soit recalculée depuis le
-- journal : un rapport qui citerait un solde stocké serait invérifiable — et
-- c'est précisément la situation que la plateforme existe pour abolir.
--
-- IL DIT AUSSI CE QUI NE VA PAS. Un rapport d'assemblée qui tairait les
-- anomalies ouvertes ou les impayés servirait à rassurer, pas à rendre compte.
-- Les écarts y figurent, avec leur motif quand ils ont été justifiés.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- rapport_assemblee — F-RAP-05
--
-- Renvoie des lignes (rubrique, intitulé, valeur), et non un document formaté :
-- la mise en forme appartient à l'interface ou à l'export, pas à la base. Ce
-- découpage permet au même rapport d'alimenter un écran, un PDF et un tableur.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rapport_assemblee(
    p_groupe_id UUID,
    p_date      DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
    rubrique  TEXT,
    intitule  TEXT,
    valeur    TEXT,
    montant   BIGINT
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_nom       TEXT;
    v_type      type_groupe;
    v_devise    CHAR(3);
    v_cycle     UUID;
BEGIN
    SELECT g.nom, g.type, g.devise INTO v_nom, v_type, v_devise
      FROM groupe g WHERE g.id = p_groupe_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Groupe % introuvable', p_groupe_id
            USING ERRCODE = 'no_data_found';
    END IF;

    SELECT c.id INTO v_cycle
      FROM cycle c WHERE c.groupe_id = p_groupe_id AND c.statut = 'EN_COURS';

    -- ------------------------------------------------------------- identité
    RETURN QUERY SELECT 'Groupe'::TEXT, 'Nom'::TEXT, v_nom, NULL::BIGINT;
    RETURN QUERY SELECT 'Groupe'::TEXT, 'Mécanisme'::TEXT,
        CASE v_type
            WHEN 'ROSCA'    THEN 'Tontine rotative'
            WHEN 'ASCA'     THEN 'Caisse d''épargne cumulative'
            ELSE                 'Association mutualiste'
        END, NULL::BIGINT;
    RETURN QUERY SELECT 'Groupe'::TEXT, 'Arrêté au'::TEXT,
        to_char(p_date, 'DD/MM/YYYY'), NULL::BIGINT;

    -- -------------------------------------------------------------- membres
    RETURN QUERY
    SELECT 'Membres'::TEXT, 'Membres actifs'::TEXT,
           count(*)::TEXT, count(*)::BIGINT
      FROM membre m
     WHERE m.groupe_id = p_groupe_id AND NOT m.supprime AND m.statut = 'ACTIF';

    RETURN QUERY
    SELECT 'Membres'::TEXT, 'Membres suspendus ou radiés'::TEXT,
           count(*)::TEXT, count(*)::BIGINT
      FROM membre m
     WHERE m.groupe_id = p_groupe_id AND m.statut <> 'ACTIF';

    -- ------------------------------------------------------------ trésorerie
    -- RECALCULÉE À LA DATE, depuis le journal. Aucun solde stocké n'est lu :
    -- c'est ce qui rend le chiffre contestable pièce en main.
    RETURN QUERY
    SELECT 'Trésorerie'::TEXT, 'En caisse et en banque'::TEXT,
           situation_caisse_a_date(p_groupe_id, p_date)::TEXT || ' ' || v_devise,
           situation_caisse_a_date(p_groupe_id, p_date);

    RETURN QUERY
    SELECT 'Trésorerie'::TEXT, 'Opérations enregistrées'::TEXT,
           count(*)::TEXT, count(*)::BIGINT
      FROM ecriture e
     WHERE e.groupe_id = p_groupe_id AND e.date_operation <= p_date;

    RETURN QUERY
    SELECT 'Trésorerie'::TEXT, 'Dont corrections'::TEXT,
           count(*)::TEXT, count(*)::BIGINT
      FROM ecriture e
     WHERE e.groupe_id = p_groupe_id AND e.date_operation <= p_date
       AND e.ecriture_corrigee_id IS NOT NULL;

    -- ----------------------------------------------------------- cotisations
    IF v_cycle IS NOT NULL THEN
        -- LES MONTANTS SONT CASTÉS EXPLICITEMENT EN BIGINT.
        --
        -- `SUM()` sur une colonne BIGINT renvoie un `numeric` en PostgreSQL —
        -- pour éviter tout dépassement sur de grandes agrégations. La vue
        -- v_recouvrement propage donc ce type, et un RETURN QUERY vers une
        -- colonne déclarée BIGINT échoue à l'exécution : « Returned type
        -- numeric does not match expected type bigint ».
        --
        -- Le cast est sûr ici : ces montants sont des francs entiers (N-INT-03),
        -- et la somme des cotisations d'un groupe ne s'approche pas de la borne
        -- d'un BIGINT.
        RETURN QUERY
        SELECT 'Cotisations'::TEXT, 'Appelées sur le cycle'::TEXT,
               r.total_appele::TEXT || ' ' || v_devise, r.total_appele::BIGINT
          FROM v_recouvrement r WHERE r.cycle_id = v_cycle;

        RETURN QUERY
        SELECT 'Cotisations'::TEXT, 'Encaissées'::TEXT,
               r.total_encaisse::TEXT || ' ' || v_devise, r.total_encaisse::BIGINT
          FROM v_recouvrement r WHERE r.cycle_id = v_cycle;

        RETURN QUERY
        SELECT 'Cotisations'::TEXT, 'Taux de recouvrement'::TEXT,
               COALESCE(r.taux_recouvrement::TEXT || ' %', 'sans objet'),
               NULL::BIGINT
          FROM v_recouvrement r WHERE r.cycle_id = v_cycle;

        RETURN QUERY
        SELECT 'Cotisations'::TEXT, 'Échéances impayées'::TEXT,
               (r.impayees + r.attendues)::TEXT,
               (r.impayees + r.attendues)::BIGINT
          FROM v_recouvrement r WHERE r.cycle_id = v_cycle;

        RETURN QUERY
        SELECT 'Cotisations'::TEXT, 'Dispenses accordées'::TEXT,
               r.dispensees::TEXT, r.dispensees::BIGINT
          FROM v_recouvrement r WHERE r.cycle_id = v_cycle;
    END IF;

    -- ---------------------------------------------------- selon le mécanisme
    IF v_type = 'ROSCA' AND v_cycle IS NOT NULL THEN
        RETURN QUERY
        SELECT 'Tour de rôle'::TEXT, 'Tours remis'::TEXT,
               count(*) FILTER (WHERE t.date_remise_reelle IS NOT NULL)::TEXT
               || ' sur ' || count(*)::TEXT,
               (count(*) FILTER (WHERE t.date_remise_reelle IS NOT NULL))::BIGINT
          FROM tour t WHERE t.cycle_id = v_cycle;

        RETURN QUERY
        SELECT 'Tour de rôle'::TEXT, 'Total remis aux bénéficiaires'::TEXT,
               COALESCE(SUM(t.montant_cagnotte), 0)::TEXT || ' ' || v_devise,
               COALESCE(SUM(t.montant_cagnotte), 0)::BIGINT
          FROM tour t WHERE t.cycle_id = v_cycle;
    END IF;

    IF v_type = 'ASCA' THEN
        RETURN QUERY
        SELECT 'Prêts'::TEXT, 'Prêts en cours'::TEXT,
               count(*)::TEXT, count(*)::BIGINT
          FROM pret p JOIN cycle c ON c.id = p.cycle_id
         WHERE c.groupe_id = p_groupe_id
           AND p.statut IN ('EN_REMBOURSEMENT', 'EN_RETARD', 'REECHELONNE');

        RETURN QUERY
        SELECT 'Prêts'::TEXT, 'Encours de crédit'::TEXT,
               COALESCE(SUM(p.capital_restant_du), 0)::TEXT || ' ' || v_devise,
               COALESCE(SUM(p.capital_restant_du), 0)::BIGINT
          FROM pret p JOIN cycle c ON c.id = p.cycle_id
         WHERE c.groupe_id = p_groupe_id
           AND p.statut IN ('EN_REMBOURSEMENT', 'EN_RETARD', 'REECHELONNE');

        RETURN QUERY
        SELECT 'Prêts'::TEXT, 'Prêts en retard'::TEXT,
               count(*)::TEXT, count(*)::BIGINT
          FROM pret p JOIN cycle c ON c.id = p.cycle_id
         WHERE c.groupe_id = p_groupe_id AND p.statut = 'EN_RETARD';

        RETURN QUERY
        SELECT 'Prêts'::TEXT, 'Intérêts perçus'::TEXT,
               abs(COALESCE(SUM(CASE l.sens WHEN 'DEBIT' THEN l.montant
                                            ELSE -l.montant END), 0))::TEXT
               || ' ' || v_devise,
               abs(COALESCE(SUM(CASE l.sens WHEN 'DEBIT' THEN l.montant
                                            ELSE -l.montant END), 0))::BIGINT
          FROM ligne_ecriture l
          JOIN compte c ON c.id = l.compte_id
         WHERE c.groupe_id = p_groupe_id AND c.nature = 'PRODUIT_INTERET';
    END IF;

    IF v_type = 'MUTUELLE' THEN
        RETURN QUERY
        SELECT 'Entraide'::TEXT, 'Aides versées'::TEXT,
               count(*)::TEXT, count(*)::BIGINT
          FROM aide a JOIN cycle c ON c.id = a.cycle_id
         WHERE c.groupe_id = p_groupe_id AND a.statut = 'VERSEE';

        RETURN QUERY
        SELECT 'Entraide'::TEXT, 'Montant total des aides'::TEXT,
               COALESCE(SUM(a.montant_accorde), 0)::TEXT || ' ' || v_devise,
               COALESCE(SUM(a.montant_accorde), 0)::BIGINT
          FROM aide a JOIN cycle c ON c.id = a.cycle_id
         WHERE c.groupe_id = p_groupe_id AND a.statut = 'VERSEE';

        RETURN QUERY
        SELECT 'Entraide'::TEXT, 'Demandes en attente'::TEXT,
               count(*)::TEXT, count(*)::BIGINT
          FROM aide a JOIN cycle c ON c.id = a.cycle_id
         WHERE c.groupe_id = p_groupe_id AND a.statut = 'DEMANDEE';
    END IF;

    -- ------------------------------------------------------------- contrôle
    -- LE RAPPORT DIT CE QUI NE VA PAS. Taire les anomalies ouvertes en
    -- assemblée reviendrait à rassurer plutôt qu'à rendre compte.
    RETURN QUERY
    SELECT 'Contrôle'::TEXT, 'Points à vérifier'::TEXT,
           count(*)::TEXT, count(*)::BIGINT
      FROM v_anomalie_ouverte a WHERE a.groupe_id = p_groupe_id;

    RETURN QUERY
    SELECT 'Contrôle'::TEXT, 'Dont critiques'::TEXT,
           count(*)::TEXT, count(*)::BIGINT
      FROM v_anomalie_ouverte a
     WHERE a.groupe_id = p_groupe_id AND a.gravite = 'CRITIQUE';

    RETURN QUERY
    SELECT 'Contrôle'::TEXT, 'Écarts constatés puis justifiés'::TEXT,
           count(*)::TEXT, count(*)::BIGINT
      FROM anomalie a
     WHERE a.groupe_id = p_groupe_id AND a.statut = 'LEVEE';

    -- L'équilibre du journal est le contrôle ultime : s'il n'est pas nul, tous
    -- les chiffres qui précèdent sont suspects, et le rapport doit le dire.
    RETURN QUERY
    SELECT 'Contrôle'::TEXT, 'Équilibre du journal'::TEXT,
           CASE WHEN COALESCE(SUM(CASE l.sens WHEN 'DEBIT' THEN l.montant
                                              ELSE -l.montant END), 0) = 0
                THEN 'équilibré'
                ELSE 'ÉCART DE ' || COALESCE(SUM(CASE l.sens WHEN 'DEBIT'
                     THEN l.montant ELSE -l.montant END), 0)::TEXT || ' — À VÉRIFIER'
           END,
           COALESCE(SUM(CASE l.sens WHEN 'DEBIT' THEN l.montant
                                    ELSE -l.montant END), 0)::BIGINT
      FROM ligne_ecriture l
      JOIN ecriture e ON e.id = l.ecriture_id
     WHERE e.groupe_id = p_groupe_id;
END $$;

COMMENT ON FUNCTION rapport_assemblee(UUID, DATE) IS
    'F-RAP-05 — rapport d''assemblée générale. Toutes les valeurs sont '
    'RECALCULÉES depuis le journal : un chiffre cité en assemblée doit pouvoir '
    'être contesté pièce en main. Le rapport inclut les anomalies ouvertes — '
    'taire les écarts reviendrait à rassurer plutôt qu''à rendre compte.';

-- -----------------------------------------------------------------------------
-- F-RAP-06 — Exports
--
-- L'export tableur est produit en CSV depuis la base. LE SÉPARATEUR EST LE
-- POINT-VIRGULE : en locale française, Excel et LibreOffice attendent celui-ci,
-- et un fichier à virgules s'ouvre en une seule colonne — un export qu'on ne
-- peut pas ouvrir n'est pas un export.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION echapper_csv(p_valeur TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    -- Une valeur contenant un séparateur, un guillemet ou un retour à la ligne
    -- est encadrée de guillemets, les guillemets internes étant doublés.
    -- Sans cela, un motif de dispense contenant un point-virgule décalerait
    -- toutes les colonnes suivantes.
    SELECT CASE
        WHEN p_valeur IS NULL THEN ''
        WHEN p_valeur ~ '[;"\n\r]'
            THEN '"' || replace(p_valeur, '"', '""') || '"'
        ELSE p_valeur
    END;
$$;

CREATE OR REPLACE FUNCTION exporter_journal_csv(
    p_groupe_id UUID,
    p_debut     DATE DEFAULT NULL,
    p_fin       DATE DEFAULT NULL
)
RETURNS SETOF TEXT
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN NEXT 'Numero;Date;Libelle;Nature;Montant;Saisi par;Correction;Motif';

    RETURN QUERY
    SELECT e.numero::TEXT
        || ';' || to_char(e.date_operation, 'DD/MM/YYYY')
        || ';' || echapper_csv(e.libelle)
        || ';' || e.nature::TEXT
        || ';' || COALESCE((SELECT SUM(l.montant) FROM ligne_ecriture l
                             WHERE l.ecriture_id = e.id AND l.sens = 'DEBIT'), 0)::TEXT
        || ';' || echapper_csv(m.nom_complet)
        || ';' || CASE WHEN e.ecriture_corrigee_id IS NOT NULL THEN 'oui' ELSE '' END
        || ';' || echapper_csv(COALESCE(e.motif_correction, ''))
      FROM ecriture e
      JOIN membre m ON m.id = e.saisi_par
     WHERE e.groupe_id = p_groupe_id
       AND (p_debut IS NULL OR e.date_operation >= p_debut)
       AND (p_fin   IS NULL OR e.date_operation <= p_fin)
     ORDER BY e.numero;
END $$;

COMMENT ON FUNCTION exporter_journal_csv(UUID, DATE, DATE) IS
    'F-RAP-06 — export du journal en CSV, séparateur point-virgule pour être '
    'ouvrable tel quel en locale française. Les corrections sont signalées avec '
    'leur motif : un export qui les masquerait donnerait une image fausse.';

CREATE OR REPLACE FUNCTION exporter_membres_csv(p_groupe_id UUID)
RETURNS SETOF TEXT
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN NEXT 'Nom;Telephone;Adhesion;Statut;Roles;Total verse;Reste du';

    RETURN QUERY
    SELECT echapper_csv(m.nom_complet)
        || ';' || echapper_csv(m.telephone)
        || ';' || to_char(m.date_adhesion, 'DD/MM/YYYY')
        || ';' || m.statut::TEXT
        || ';' || echapper_csv(COALESCE(
             (SELECT string_agg(mr.role::TEXT, ' ') FROM membre_role mr
               WHERE mr.membre_id = m.id AND mr.retire_le IS NULL), ''))
        || ';' || COALESCE((SELECT SUM(e.montant_regle) FROM echeance e
                             WHERE e.membre_id = m.id), 0)::TEXT
        || ';' || COALESCE((SELECT SUM(e.montant_attendu - e.montant_regle)
                              FROM echeance e
                             WHERE e.membre_id = m.id
                               AND e.statut IN ('ATTENDUE','PARTIELLE','IMPAYEE')), 0)::TEXT
      FROM membre m
     WHERE m.groupe_id = p_groupe_id AND NOT m.supprime
     ORDER BY m.nom_complet;
END $$;

CREATE OR REPLACE FUNCTION exporter_rapport_csv(
    p_groupe_id UUID,
    p_date      DATE DEFAULT CURRENT_DATE
)
RETURNS SETOF TEXT
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN NEXT 'Rubrique;Intitule;Valeur';
    RETURN QUERY
    SELECT echapper_csv(r.rubrique) || ';' || echapper_csv(r.intitule)
        || ';' || echapper_csv(r.valeur)
      FROM rapport_assemblee(p_groupe_id, p_date) r;
END $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO tontine_app;

COMMIT;
