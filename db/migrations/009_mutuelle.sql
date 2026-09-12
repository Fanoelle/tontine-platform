-- =============================================================================
-- 009 — Spécialisation MUTUELLE : aides (F-AID)
--
-- UNE AIDE N'EST PAS UN PRÊT, d'où une table distincte. Elle n'ouvre aucune
-- créance et n'est pas remboursable. Mêler les deux obligerait à une colonne
-- « remboursable » dont dépendrait la moitié des règles — et rien n'empêcherait
-- alors d'exiger le remboursement d'un secours.
--
-- COTISER N'OUVRE AUCUN DROIT. Dans une mutuelle, le fonds est collectif et non
-- individualisé : une aide est une DÉCISION du groupe, jamais un droit acquis.
-- C'est ce qui la distingue de l'épargne ASCA, où chaque membre détient un
-- solde qui lui revient.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    CREATE TYPE statut_aide AS ENUM
        ('DEMANDEE', 'APPROUVEE', 'REFUSEE', 'VERSEE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS aide (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id         UUID        NOT NULL REFERENCES cycle(id)  ON DELETE RESTRICT,
    beneficiaire_id  UUID        NOT NULL REFERENCES membre(id) ON DELETE RESTRICT,
    motif            TEXT        NOT NULL CHECK (length(btrim(motif)) > 0),
    montant_demande  BIGINT      NOT NULL CHECK (montant_demande > 0),
    montant_accorde  BIGINT      CHECK (montant_accorde > 0),
    statut           statut_aide NOT NULL DEFAULT 'DEMANDEE',
    date_demande     DATE        NOT NULL DEFAULT CURRENT_DATE,
    date_decision    DATE,
    decide_par       UUID        REFERENCES membre(id) ON DELETE RESTRICT,
    motif_decision   TEXT,
    date_versement   DATE,
    ecriture_id      UUID        REFERENCES ecriture(id) ON DELETE RESTRICT,
    cree_le          TIMESTAMPTZ NOT NULL DEFAULT now(),
    modifie_le       TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Toute décision porte son décideur et sa date (N-TRC-03).
    CONSTRAINT aide_decision_coherente CHECK (
        (statut = 'DEMANDEE' AND date_decision IS NULL AND decide_par IS NULL)
        OR
        (statut <> 'DEMANDEE' AND date_decision IS NOT NULL AND decide_par IS NOT NULL)
    ),
    CONSTRAINT aide_refus_motive CHECK (
        statut <> 'REFUSEE' OR length(btrim(motif_decision)) > 0
    ),
    CONSTRAINT aide_montant_si_approuvee CHECK (
        statut IN ('DEMANDEE', 'REFUSEE') OR montant_accorde IS NOT NULL
    ),
    -- Un versement porte toujours son écriture : aucun mouvement d'argent
    -- n'existe hors du journal (F-TRX-01).
    CONSTRAINT aide_versement_coherent CHECK (
        (statut = 'VERSEE' AND ecriture_id IS NOT NULL AND date_versement IS NOT NULL)
        OR
        (statut <> 'VERSEE' AND ecriture_id IS NULL AND date_versement IS NULL)
    )
);

COMMENT ON TABLE aide IS
    'Spécialisation MUTUELLE (F-AID). Secours versé sur le fonds collectif. '
    'N''ouvre aucune créance et n''est pas remboursable — d''où une table '
    'distincte de `pret`.';
COMMENT ON COLUMN aide.montant_accorde IS
    'Peut être inférieur au montant demandé : le groupe arbitre selon l''état '
    'du fonds. C''est une décision, pas un droit.';

CREATE INDEX IF NOT EXISTS aide_cycle_statut_idx ON aide (cycle_id, statut);
CREATE INDEX IF NOT EXISTS aide_beneficiaire_idx ON aide (beneficiaire_id);

DROP TRIGGER IF EXISTS trg_aide_modifie_le ON aide;
CREATE TRIGGER trg_aide_modifie_le
    BEFORE UPDATE ON aide
    FOR EACH ROW EXECUTE FUNCTION toucher_modifie_le();

CREATE OR REPLACE FUNCTION verifier_aide_mutuelle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_type          type_groupe;
    v_groupe_cycle  UUID;
    v_groupe_membre UUID;
BEGIN
    SELECT g.type, g.id INTO v_type, v_groupe_cycle
      FROM cycle c JOIN groupe g ON g.id = c.groupe_id
     WHERE c.id = NEW.cycle_id;

    IF v_type <> 'MUTUELLE' THEN
        RAISE EXCEPTION
            'Une aide n''existe que pour un groupe MUTUELLE (décision 0002), pas %',
            v_type
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT m.groupe_id INTO v_groupe_membre
      FROM membre m WHERE m.id = NEW.beneficiaire_id;

    IF v_groupe_membre IS DISTINCT FROM v_groupe_cycle THEN
        RAISE EXCEPTION
            'Cloisonnement (N-SEC-02) : le bénéficiaire n''appartient pas au groupe du cycle'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_aide_mutuelle ON aide;
CREATE TRIGGER trg_aide_mutuelle
    BEFORE INSERT OR UPDATE ON aide
    FOR EACH ROW EXECUTE FUNCTION verifier_aide_mutuelle();

-- REFUSEE et VERSEE sont terminaux : on ne reverse pas une aide déjà versée,
-- et un refus ne se révise pas — une nouvelle demande est une nouvelle aide.
CREATE OR REPLACE FUNCTION refuser_transition_aide()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.statut IN ('REFUSEE', 'VERSEE') AND NEW.statut <> OLD.statut THEN
        RAISE EXCEPTION
            'Une aide % ne change plus d''état : % refusé', OLD.statut, NEW.statut
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_aide_terminal ON aide;
CREATE TRIGGER trg_aide_terminal
    BEFORE UPDATE ON aide
    FOR EACH ROW EXECUTE FUNCTION refuser_transition_aide();

GRANT SELECT, INSERT, UPDATE ON aide TO tontine_app;

COMMIT;
