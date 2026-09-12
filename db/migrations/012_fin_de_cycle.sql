-- =============================================================================
-- 012 — Rééchelonnement, redistribution ASCA et archivage
--        (F-PRE-07, F-EPA-03, F-EPA-04, F-GRP-06)
--
-- CE QUI RELIE CES TROIS SUJETS : ils closent la vie d'un engagement. Un prêt
-- qu'on rééchelonne, une caisse qu'on redistribue, un groupe qu'on archive —
-- trois fins qui ne doivent JAMAIS effacer ce qui les précède.
--
-- C'est le principe directeur de tout ce fichier : rééchelonner n'efface pas la
-- dette, redistribuer n'efface pas l'historique des versements, archiver
-- n'efface pas le journal. Une implémentation qui remettrait un compteur à zéro
-- transformerait un aménagement en remise de dette, ou une clôture en
-- effacement de preuve.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- F-PRE-07 — Rééchelonner un prêt
--
-- LE CAPITAL RESTANT DÛ EST STRICTEMENT INCHANGÉ. Seul l'échéancier change.
-- Une implémentation qui le remettrait à zéro transformerait un aménagement en
-- remise de dette — décision qui n'appartient pas au système mais au groupe,
-- et qui passerait alors inaperçue.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reechelonnement (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    pret_id            UUID        NOT NULL REFERENCES pret(id) ON DELETE RESTRICT,
    motif              TEXT        NOT NULL CHECK (length(btrim(motif)) > 0),
    decide_par         UUID        NOT NULL REFERENCES membre(id) ON DELETE RESTRICT,
    capital_a_la_date  BIGINT      NOT NULL CHECK (capital_a_la_date >= 0),
    anciennes_echeances INTEGER    NOT NULL CHECK (anciennes_echeances > 0),
    nouvelles_echeances INTEGER    NOT NULL CHECK (nouvelles_echeances > 0),
    decide_le          DATE        NOT NULL DEFAULT CURRENT_DATE,
    cree_le            TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE reechelonnement IS
    'Trace d''un aménagement d''échéancier (F-PRE-07). `capital_a_la_date` fige '
    'ce qui restait dû au moment de la décision : c''est ce qui permet de '
    'vérifier plus tard que le rééchelonnement n''a pas allégé la dette.';

CREATE INDEX IF NOT EXISTS reechelonnement_pret_idx ON reechelonnement (pret_id);

CREATE OR REPLACE FUNCTION reechelonner_pret(
    p_pret_id     UUID,
    p_echeances   INTEGER,
    p_motif       TEXT,
    p_decideur_id UUID
)
RETURNS TABLE (
    capital_restant_du BIGINT,
    echeances          INTEGER,
    premiere_echeance  DATE
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_groupe_id   UUID;
    v_statut      statut_pret;
    v_restant     BIGINT;
    v_taux        NUMERIC(5,4);
    v_anciennes   INTEGER;
    v_periodicite periodicite;
    v_intervalle  INTERVAL;
    v_capital     BIGINT;
    v_reste       BIGINT;
    v_interet     BIGINT;
    v_depart      DATE;
    i             INTEGER;
BEGIN
    IF p_motif IS NULL OR length(btrim(p_motif)) = 0 THEN
        RAISE EXCEPTION
            'Un rééchelonnement doit être motivé (F-PRE-07, N-TRC-03)'
            USING ERRCODE = 'check_violation';
    END IF;

    IF p_echeances IS NULL OR p_echeances < 1 THEN
        RAISE EXCEPTION 'Le nouvel échéancier comporte au moins une échéance'
            USING ERRCODE = 'check_violation';
    END IF;

    IF NOT membre_a_role(p_decideur_id, 'PRESIDENT') THEN
        RAISE EXCEPTION
            'Seul le président rééchelonne un prêt (F-PRE-07)'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT c.groupe_id, p.statut, p.capital_restant_du, p.taux_interet,
           p.nombre_echeances
      INTO v_groupe_id, v_statut, v_restant, v_taux, v_anciennes
      FROM pret p JOIN cycle c ON c.id = p.cycle_id
     WHERE p.id = p_pret_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Prêt % introuvable', p_pret_id USING ERRCODE = 'no_data_found';
    END IF;

    -- Un prêt soldé ou refusé ne se rééchelonne pas : il n'y a plus de dette à
    -- aménager. Un prêt non encore octroyé non plus — on modifierait un
    -- échéancier qui n'existe pas.
    IF v_statut NOT IN ('EN_REMBOURSEMENT', 'EN_RETARD', 'REECHELONNE') THEN
        RAISE EXCEPTION
            'Un prêt % ne se rééchelonne pas — seul un prêt en cours le peut',
            v_statut
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_restant <= 0 THEN
        RAISE EXCEPTION 'Ce prêt n''a plus de capital restant dû'
            USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO reechelonnement (pret_id, motif, decide_par, capital_a_la_date,
                                 anciennes_echeances, nouvelles_echeances)
    VALUES (p_pret_id, btrim(p_motif), p_decideur_id, v_restant,
            v_anciennes, p_echeances);

    -- L'ANCIEN ÉCHÉANCIER N'EST PAS SUPPRIMÉ POUR LES ÉCHÉANCES DÉJÀ RÉGLÉES.
    -- Elles portent des remboursements réels, rattachés à des écritures : les
    -- effacer romprait le lien entre l'argent reçu et ce qu'il acquittait.
    -- Seules les échéances non honorées sont remplacées.
    DELETE FROM echeance_pret
     WHERE pret_id = p_pret_id
       AND statut IN ('ATTENDUE', 'IMPAYEE')
       AND NOT EXISTS (SELECT 1 FROM remboursement r
                        WHERE r.echeance_pret_id = echeance_pret.id);

    SELECT r.periodicite INTO v_periodicite
      FROM regle_en_vigueur(v_groupe_id, CURRENT_DATE) r;

    v_intervalle := CASE COALESCE(v_periodicite, 'MENSUELLE')
        WHEN 'HEBDOMADAIRE'  THEN INTERVAL '7 days'
        WHEN 'QUINZAINE'     THEN INTERVAL '15 days'
        WHEN 'TRIMESTRIELLE' THEN INTERVAL '3 months'
        ELSE                      INTERVAL '1 month'
    END;

    v_capital := v_restant / p_echeances;
    v_reste   := v_restant - (v_capital * p_echeances);
    v_interet := round(v_restant * COALESCE(v_taux, 0));
    v_depart  := CURRENT_DATE;

    -- La numérotation reprend après la dernière échéance conservée : les numéros
    -- restent uniques et l'historique reste lisible dans l'ordre.
    SELECT COALESCE(MAX(numero), 0) INTO i FROM echeance_pret WHERE pret_id = p_pret_id;

    FOR j IN 1..p_echeances LOOP
        INSERT INTO echeance_pret (pret_id, numero, date_echeance,
                                   montant_capital, montant_interet)
        VALUES (p_pret_id, i + j, (v_depart + (v_intervalle * j))::DATE,
                v_capital + CASE WHEN j = p_echeances THEN v_reste ELSE 0 END,
                v_interet);
    END LOOP;

    UPDATE pret
       SET statut           = 'REECHELONNE',
           nombre_echeances = p_echeances
     WHERE id = p_pret_id;

    -- Vérification explicite de l'invariant du rééchelonnement. Le capital ne
    -- doit pas avoir bougé d'un franc : si un jour quelqu'un ajoute une remise
    -- partielle ici, ce contrôle la révélera immédiatement.
    --
    -- LA COLONNE EST QUALIFIÉE PAR UN ALIAS, comme dans enregistrer_remboursement.
    -- `capital_restant_du` est aussi un paramètre de SORTIE (clause RETURNS
    -- TABLE) : sans alias, PL/pgSQL ne peut trancher entre la variable et la
    -- colonne et refuse la requête. Le défaut ne se voyait qu'au cas nominal,
    -- les chemins de refus sortant avant d'atteindre cette ligne.
    IF (SELECT p.capital_restant_du FROM pret p WHERE p.id = p_pret_id) <> v_restant THEN
        RAISE EXCEPTION
            'Le rééchelonnement a modifié le capital restant dû — un aménagement '
            'n''est pas une remise de dette (F-PRE-07)';
    END IF;

    RETURN QUERY SELECT v_restant, p_echeances,
                        (v_depart + v_intervalle)::DATE;
END $$;

COMMENT ON FUNCTION reechelonner_pret IS
    'F-PRE-07 — remplace les échéances NON honorées par un nouvel échéancier. '
    'Le capital restant dû est strictement inchangé : rééchelonner n''efface '
    'jamais la dette. Les échéances déjà réglées sont conservées, car elles '
    'portent des remboursements rattachés à des écritures.';

-- -----------------------------------------------------------------------------
-- F-EPA-03, F-EPA-04 — Redistribution de fin de cycle ASCA
--
-- En fin de cycle, la caisse ASCA rend à chaque membre son épargne, augmentée
-- de sa quote-part des intérêts perçus. Le prorata se fait sur les PARTS, non
-- sur le solde : un membre entré à mi-cycle a moins contribué au temps pendant
-- lequel l'argent a travaillé, et lui servir le même intérêt qu'un membre
-- présent depuis l'ouverture léserait ce dernier.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION decompte_redistribution(p_cycle_id UUID)
RETURNS TABLE (
    membre_id        UUID,
    nom_complet      TEXT,
    parts            INTEGER,
    epargne          BIGINT,
    quote_part       BIGINT,
    total_a_restituer BIGINT
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_groupe_id  UUID;
    v_type       type_groupe;
    v_interets   BIGINT;
    v_parts      INTEGER;
BEGIN
    SELECT c.groupe_id, g.type INTO v_groupe_id, v_type
      FROM cycle c JOIN groupe g ON g.id = c.groupe_id
     WHERE c.id = p_cycle_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cycle % introuvable', p_cycle_id USING ERRCODE = 'no_data_found';
    END IF;

    IF v_type <> 'ASCA' THEN
        RAISE EXCEPTION
            'La redistribution de fin de cycle ne vaut que pour une caisse ASCA, '
            'pas pour un groupe % (§3)', v_type
            USING ERRCODE = 'check_violation';
    END IF;

    -- Les intérêts perçus sont lus DEPUIS LE JOURNAL, jamais depuis une colonne
    -- cumulée : c'est la seule valeur qu'on ne puisse pas avoir désynchronisée.
    -- Un compte de produit est alimenté par des crédits, donc son solde
    -- débit-crédit est négatif ; on en prend la valeur absolue.
    SELECT abs(COALESCE(SUM(
               CASE l.sens WHEN 'DEBIT' THEN l.montant ELSE -l.montant END), 0))
      INTO v_interets
      FROM ligne_ecriture l
      JOIN compte c ON c.id = l.compte_id
     WHERE c.groupe_id = v_groupe_id AND c.nature = 'PRODUIT_INTERET';

    SELECT COALESCE(SUM(em.parts), 0) INTO v_parts
      FROM epargne_membre em WHERE em.cycle_id = p_cycle_id;

    IF v_parts = 0 THEN
        RAISE EXCEPTION
            'Aucune part détenue sur ce cycle — la redistribution n''a pas d''objet'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN QUERY
    SELECT em.membre_id,
           m.nom_complet,
           em.parts,
           em.solde_calcule,
           -- Division entière : un franc n'a pas de sous-unité (N-INT-03).
           -- Le reliquat de division reste en caisse plutôt que d'être
           -- attribué arbitrairement à quelqu'un.
           (v_interets * em.parts) / v_parts AS quote_part,
           em.solde_calcule + (v_interets * em.parts) / v_parts AS total
      FROM epargne_membre em
      JOIN membre m ON m.id = em.membre_id
     WHERE em.cycle_id = p_cycle_id
     ORDER BY m.nom_complet;
END $$;

COMMENT ON FUNCTION decompte_redistribution(UUID) IS
    'F-EPA-03, F-EPA-04 — décompte de fin de cycle ASCA. Le prorata porte sur '
    'les PARTS et non sur le solde : un membre entré à mi-cycle n''a pas laissé '
    'son argent travailler aussi longtemps. Fonction de LECTURE : elle prépare '
    'la décision, elle ne verse rien.';

-- -----------------------------------------------------------------------------
-- F-GRP-06 — Archiver un groupe
--
-- ARCHIVER N'EST PAS SUPPRIMER. Le groupe sort des listes actives, son
-- historique reste intégralement consultable. C'est le pendant, à l'échelle du
-- groupe, de la suppression logique d'un membre (R-08).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION archiver_groupe(
    p_groupe_id   UUID,
    p_decideur_id UUID
)
RETURNS TABLE (
    archive            BOOLEAN,
    cycles_ouverts     INTEGER,
    prets_en_cours     INTEGER,
    echeances_impayees INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_cycles   INTEGER;
    v_prets    INTEGER;
    v_impayees INTEGER;
BEGIN
    IF NOT membre_a_role(p_decideur_id, 'PRESIDENT') THEN
        RAISE EXCEPTION 'Seul le président archive un groupe (F-GRP-06)'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT count(*)::INTEGER INTO v_cycles
      FROM cycle WHERE groupe_id = p_groupe_id AND statut = 'EN_COURS';

    SELECT count(*)::INTEGER INTO v_prets
      FROM pret p JOIN cycle c ON c.id = p.cycle_id
     WHERE c.groupe_id = p_groupe_id
       AND p.statut IN ('EN_REMBOURSEMENT', 'EN_RETARD', 'REECHELONNE');

    SELECT count(*)::INTEGER INTO v_impayees
      FROM echeance e JOIN cycle c ON c.id = e.cycle_id
     WHERE c.groupe_id = p_groupe_id
       AND e.statut IN ('ATTENDUE', 'PARTIELLE', 'IMPAYEE')
       AND e.date_echeance < CURRENT_DATE;

    -- ON REFUSE D'ARCHIVER UN GROUPE QUI DOIT ENCORE DE L'ARGENT OU À QUI
    -- L'ON EN DOIT. Archiver avec un prêt en cours ferait disparaître des
    -- listes actives une créance bien réelle, et le débiteur comme le groupe
    -- perdraient de vue ce qui reste dû.
    IF v_cycles > 0 OR v_prets > 0 THEN
        RAISE EXCEPTION
            'Archivage impossible : % cycle(s) ouvert(s) et % prêt(s) en cours. '
            'Clôturez-les d''abord — archiver ne doit jamais faire disparaître '
            'une créance vivante.', v_cycles, v_prets
            USING ERRCODE = 'check_violation';
    END IF;

    UPDATE groupe SET archive = true WHERE id = p_groupe_id;

    RETURN QUERY SELECT true, v_cycles, v_prets, v_impayees;
END $$;

COMMENT ON FUNCTION archiver_groupe IS
    'F-GRP-06 — sort le groupe des listes actives sans toucher à son historique. '
    'Refuse tant qu''un cycle est ouvert ou qu''un prêt court : archiver ne doit '
    'jamais faire disparaître une créance vivante.';

-- Un groupe archivé ne se réveille pas par accident : la réouverture est
-- possible mais explicite, et tracée par `modifie_le`.
CREATE OR REPLACE FUNCTION desarchiver_groupe(
    p_groupe_id   UUID,
    p_decideur_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT membre_a_role(p_decideur_id, 'PRESIDENT') THEN
        RAISE EXCEPTION 'Seul le président désarchive un groupe'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    UPDATE groupe SET archive = false WHERE id = p_groupe_id;
    RETURN true;
END $$;

GRANT SELECT, INSERT ON reechelonnement TO tontine_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO tontine_app;

COMMIT;
