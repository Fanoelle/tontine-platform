-- =============================================================================
-- 008 — Spécialisation ASCA : épargne et prêts (F-EPA, F-PRE)
--
-- LES TROIS MÉCANISMES ONT DES RÈGLES D'ARGENT INCOMPATIBLES (décision 0002).
-- Ces tables n'existent que pour les groupes ASCA, ce qu'une contrainte de
-- cohérence de type garantit — comme `tour` pour ROSCA.
--
-- DIFFÉRENCE STRUCTURANTE AVEC ROSCA. En ROSCA la caisse se vide à chaque tour ;
-- en ASCA elle CROÎT, prête avec intérêt, puis redistribue en fin de cycle.
-- L'avoir de la caisse égale donc la somme des épargnes individuelles plus les
-- intérêts non distribués — invariant que le moteur d'anomalies surveille
-- (migration 010), faute de pouvoir l'exprimer en contrainte SQL : il porte sur
-- une agrégation de tout le journal.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    CREATE TYPE statut_pret AS ENUM (
        'DEMANDE', 'APPROUVE', 'REFUSE', 'EN_REMBOURSEMENT',
        'SOLDE', 'EN_RETARD', 'REECHELONNE'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- epargne_membre — F-EPA-01, F-EPA-02
--
-- `solde_calcule` est un CACHE, jamais la source de vérité : le journal la
-- porte, via le compte EPARGNE_MEMBRE. L'écart entre les deux est précisément
-- ce que détecte F-ANO-04. Un solde stocké jamais vérifié est la dérive que la
-- partie double devait empêcher.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS epargne_membre (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id        UUID        NOT NULL REFERENCES cycle(id)  ON DELETE RESTRICT,
    membre_id       UUID        NOT NULL REFERENCES membre(id) ON DELETE RESTRICT,
    parts           INTEGER     NOT NULL DEFAULT 0 CHECK (parts >= 0),
    solde_calcule   BIGINT      NOT NULL DEFAULT 0 CHECK (solde_calcule >= 0),
    interets_acquis BIGINT      NOT NULL DEFAULT 0 CHECK (interets_acquis >= 0),
    cree_le         TIMESTAMPTZ NOT NULL DEFAULT now(),
    modifie_le      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE epargne_membre IS
    'Spécialisation ASCA (F-EPA-01). Une ligne par membre et par cycle.';
COMMENT ON COLUMN epargne_membre.solde_calcule IS
    'CACHE du solde porté par le compte EPARGNE_MEMBRE du journal. Jamais la '
    'source de vérité : l''écart entre les deux est ce que détecte F-ANO-04.';
COMMENT ON COLUMN epargne_membre.parts IS
    'Parts détenues (F-EPA-02). Servent au prorata de la redistribution de fin '
    'de cycle : un membre entré à mi-cycle ne peut prétendre à la même part '
    'qu''un membre présent depuis l''ouverture.';

CREATE UNIQUE INDEX IF NOT EXISTS epargne_membre_unique_idx
    ON epargne_membre (cycle_id, membre_id);

DROP TRIGGER IF EXISTS trg_epargne_modifie_le ON epargne_membre;
CREATE TRIGGER trg_epargne_modifie_le
    BEFORE UPDATE ON epargne_membre
    FOR EACH ROW EXECUTE FUNCTION toucher_modifie_le();

-- -----------------------------------------------------------------------------
-- pret — F-PRE-01 à F-PRE-07
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pret (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id           UUID        NOT NULL REFERENCES cycle(id)  ON DELETE RESTRICT,
    emprunteur_id      UUID        NOT NULL REFERENCES membre(id) ON DELETE RESTRICT,
    montant_demande    BIGINT      NOT NULL CHECK (montant_demande > 0),
    montant_accorde    BIGINT      CHECK (montant_accorde > 0),
    taux_interet       NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (taux_interet >= 0),
    nombre_echeances   INTEGER     NOT NULL DEFAULT 1 CHECK (nombre_echeances > 0),
    capital_restant_du BIGINT      NOT NULL DEFAULT 0,
    statut             statut_pret NOT NULL DEFAULT 'DEMANDE',
    motif_demande      TEXT        NOT NULL CHECK (length(btrim(motif_demande)) > 0),
    date_demande       DATE        NOT NULL DEFAULT CURRENT_DATE,
    date_decision      DATE,
    decide_par         UUID        REFERENCES membre(id) ON DELETE RESTRICT,
    motif_decision     TEXT,
    ecriture_octroi_id UUID        REFERENCES ecriture(id) ON DELETE RESTRICT,
    cree_le            TIMESTAMPTZ NOT NULL DEFAULT now(),
    modifie_le         TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- R-07 — le capital restant dû décroît jusqu'à zéro, jamais en deçà, et
    -- n'excède jamais le montant accordé. Un remboursement excédentaire est
    -- refusé plutôt qu'absorbé : il révèle une erreur de saisie.
    CONSTRAINT pret_capital_borne CHECK (
        capital_restant_du >= 0
        AND (montant_accorde IS NULL OR capital_restant_du <= montant_accorde)
    ),

    -- Une décision porte toujours son décideur et sa date (N-TRC-03). REFUSE
    -- exige en outre un motif : un refus sans explication est ingérable pour
    -- le groupe.
    CONSTRAINT pret_decision_coherente CHECK (
        (statut = 'DEMANDE' AND date_decision IS NULL AND decide_par IS NULL)
        OR
        (statut <> 'DEMANDE' AND date_decision IS NOT NULL AND decide_par IS NOT NULL)
    ),
    CONSTRAINT pret_refus_motive CHECK (
        statut <> 'REFUSE' OR length(btrim(motif_decision)) > 0
    ),
    CONSTRAINT pret_accorde_si_approuve CHECK (
        statut IN ('DEMANDE', 'REFUSE') OR montant_accorde IS NOT NULL
    )
);

COMMENT ON TABLE pret IS
    'Spécialisation ASCA (F-PRE). Créance de la caisse sur un membre. REFUSE est '
    'terminal : une nouvelle demande donne lieu à un nouveau prêt, jamais à la '
    'réouverture de celui-ci.';
COMMENT ON COLUMN pret.capital_restant_du IS
    'R-07 — borné par CHECK. Doublé par le compte CREANCE_PRET du membre au '
    'journal, qui en porte la version comptable. Leur écart est ce que '
    'surveille F-ANO-04.';

CREATE INDEX IF NOT EXISTS pret_cycle_statut_idx ON pret (cycle_id, statut);
CREATE INDEX IF NOT EXISTS pret_emprunteur_idx   ON pret (emprunteur_id);

DROP TRIGGER IF EXISTS trg_pret_modifie_le ON pret;
CREATE TRIGGER trg_pret_modifie_le
    BEFORE UPDATE ON pret
    FOR EACH ROW EXECUTE FUNCTION toucher_modifie_le();

-- Cohérence de type ET de cloisonnement, comme `tour` pour ROSCA.
CREATE OR REPLACE FUNCTION verifier_pret_asca()
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

    IF v_type <> 'ASCA' THEN
        RAISE EXCEPTION
            'Un prêt n''existe que pour un groupe ASCA (décision 0002), pas %',
            v_type
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT m.groupe_id INTO v_groupe_membre
      FROM membre m WHERE m.id = NEW.emprunteur_id;

    IF v_groupe_membre IS DISTINCT FROM v_groupe_cycle THEN
        RAISE EXCEPTION
            'Cloisonnement (N-SEC-02) : l''emprunteur n''appartient pas au groupe du cycle'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pret_asca ON pret;
CREATE TRIGGER trg_pret_asca
    BEFORE INSERT OR UPDATE ON pret
    FOR EACH ROW EXECUTE FUNCTION verifier_pret_asca();

-- REFUSE et SOLDE sont terminaux (etats.md §3). Rouvrir un prêt soldé
-- ressusciterait une dette éteinte.
CREATE OR REPLACE FUNCTION refuser_transition_pret()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.statut IN ('REFUSE', 'SOLDE') AND NEW.statut <> OLD.statut THEN
        RAISE EXCEPTION
            'Un prêt % ne change plus d''état (F-PRE-02) : % refusé',
            OLD.statut, NEW.statut
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pret_terminal ON pret;
CREATE TRIGGER trg_pret_terminal
    BEFORE UPDATE ON pret
    FOR EACH ROW EXECUTE FUNCTION refuser_transition_pret();

-- -----------------------------------------------------------------------------
-- echeance_pret — F-PRE-03
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS echeance_pret (
    id               UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    pret_id          UUID            NOT NULL REFERENCES pret(id) ON DELETE RESTRICT,
    numero           INTEGER         NOT NULL CHECK (numero > 0),
    date_echeance    DATE            NOT NULL,
    montant_capital  BIGINT          NOT NULL CHECK (montant_capital >= 0),
    montant_interet  BIGINT          NOT NULL DEFAULT 0 CHECK (montant_interet >= 0),
    montant_regle    BIGINT          NOT NULL DEFAULT 0 CHECK (montant_regle >= 0),
    statut           statut_echeance NOT NULL DEFAULT 'ATTENDUE',
    cree_le          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    modifie_le       TIMESTAMPTZ     NOT NULL DEFAULT now()
);

COMMENT ON TABLE echeance_pret IS
    'Échéancier de remboursement (F-PRE-03), produit à l''octroi. Capital et '
    'intérêt sont SÉPARÉS : les confondre interdirait de distinguer ce qui '
    'éteint la dette de ce qui rémunère la caisse.';

CREATE UNIQUE INDEX IF NOT EXISTS echeance_pret_unique_idx
    ON echeance_pret (pret_id, numero);
CREATE INDEX IF NOT EXISTS echeance_pret_date_idx
    ON echeance_pret (date_echeance, statut);

DROP TRIGGER IF EXISTS trg_echeance_pret_modifie_le ON echeance_pret;
CREATE TRIGGER trg_echeance_pret_modifie_le
    BEFORE UPDATE ON echeance_pret
    FOR EACH ROW EXECUTE FUNCTION toucher_modifie_le();

-- -----------------------------------------------------------------------------
-- remboursement — les versements réellement effectués sur un prêt
--
-- Même distinction que cotisation/échéance : l'échéancier est ce qui DOIT être
-- remboursé, le remboursement ce qui l'A ÉTÉ. Les confondre rendrait
-- indétectable le remboursement manquant (F-ANO-02).
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS remboursement (
    id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    pret_id           UUID           NOT NULL REFERENCES pret(id)     ON DELETE RESTRICT,
    echeance_pret_id  UUID           REFERENCES echeance_pret(id)     ON DELETE RESTRICT,
    montant_capital   BIGINT         NOT NULL CHECK (montant_capital >= 0),
    montant_interet   BIGINT         NOT NULL DEFAULT 0 CHECK (montant_interet >= 0),
    date_versement    DATE           NOT NULL,
    moyen             moyen_paiement NOT NULL,
    ecriture_id       UUID           NOT NULL REFERENCES ecriture(id) ON DELETE RESTRICT,
    saisi_par         UUID           NOT NULL REFERENCES membre(id)   ON DELETE RESTRICT,
    cree_le           TIMESTAMPTZ    NOT NULL DEFAULT now(),

    CONSTRAINT remboursement_non_nul
        CHECK (montant_capital + montant_interet > 0)
);

COMMENT ON TABLE remboursement IS
    'Versement effectif sur un prêt (F-PRE-04). `ecriture_id` est NOT NULL : '
    'aucun mouvement d''argent n''existe hors du journal (F-TRX-01).';

CREATE INDEX IF NOT EXISTS remboursement_pret_idx ON remboursement (pret_id);

-- Recalcul du capital restant dû et du statut de l'échéancier. Seul auteur de
-- ces colonnes, comme `recalculer_echeance` pour les cotisations.
CREATE OR REPLACE FUNCTION recalculer_pret()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_pret_id  UUID;
    v_accorde  BIGINT;
    v_rembourse BIGINT;
    v_statut   statut_pret;
BEGIN
    v_pret_id := COALESCE(NEW.pret_id, OLD.pret_id);

    SELECT p.montant_accorde, p.statut INTO v_accorde, v_statut
      FROM pret p WHERE p.id = v_pret_id;

    IF NOT FOUND OR v_accorde IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(SUM(r.montant_capital), 0) INTO v_rembourse
      FROM remboursement r WHERE r.pret_id = v_pret_id;

    UPDATE pret
       SET capital_restant_du = GREATEST(v_accorde - v_rembourse, 0),
           -- Le passage à SOLDE est une conséquence du dernier remboursement,
           -- jamais une action. Les états REFUSE et SOLDE étant terminaux, on
           -- ne repasse jamais un prêt soldé en remboursement.
           statut = CASE
               WHEN v_accorde - v_rembourse <= 0 THEN 'SOLDE'::statut_pret
               WHEN v_statut = 'SOLDE'           THEN 'SOLDE'::statut_pret
               WHEN v_statut IN ('APPROUVE', 'EN_RETARD', 'REECHELONNE')
                                                 THEN v_statut
               ELSE 'EN_REMBOURSEMENT'::statut_pret
           END
     WHERE id = v_pret_id;

    -- Imputation sur l'échéance visée, le cas échéant.
    IF COALESCE(NEW.echeance_pret_id, OLD.echeance_pret_id) IS NOT NULL THEN
        UPDATE echeance_pret ep
           SET montant_regle = sous.total,
               statut = CASE
                   WHEN sous.total >= ep.montant_capital + ep.montant_interet
                       THEN 'REGLEE'::statut_echeance
                   WHEN sous.total > 0            THEN 'PARTIELLE'::statut_echeance
                   WHEN ep.date_echeance < CURRENT_DATE
                       THEN 'IMPAYEE'::statut_echeance
                   ELSE 'ATTENDUE'::statut_echeance
               END
          FROM (
              SELECT COALESCE(SUM(r.montant_capital + r.montant_interet), 0) AS total
                FROM remboursement r
               WHERE r.echeance_pret_id = COALESCE(NEW.echeance_pret_id, OLD.echeance_pret_id)
          ) sous
         WHERE ep.id = COALESCE(NEW.echeance_pret_id, OLD.echeance_pret_id);
    END IF;

    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_remboursement_recalcul ON remboursement;
CREATE TRIGGER trg_remboursement_recalcul
    AFTER INSERT OR UPDATE OR DELETE ON remboursement
    FOR EACH ROW EXECUTE FUNCTION recalculer_pret();

GRANT SELECT, INSERT, UPDATE ON epargne_membre, pret, echeance_pret TO tontine_app;
GRANT SELECT, INSERT ON remboursement TO tontine_app;

-- LE DELETE EST ACCORDÉ SUR `echeance_pret`, ET SUR ELLE SEULE.
--
-- Le rééchelonnement (F-PRE-07) remplace les échéances NON honorées par un
-- nouvel échéancier : il doit donc pouvoir les supprimer. Sans ce privilège, la
-- fonction échoue sur « permission denied for table echeance_pret » — et le
-- refus remonte en 403, ce qui fait croire à un défaut d'habilitation alors que
-- c'est un défaut de droits sur la base.
--
-- POURQUOI PAS `SECURITY DEFINER` SUR LA FONCTION. Ce serait plus court, mais
-- cela ferait exécuter TOUTE la fonction avec les droits du propriétaire — y
-- compris ses écritures au journal, qui perdraient alors la protection de la
-- révocation R-02. Accorder un privilège précis sur une table précise laisse
-- les autres verrous intacts.
--
-- Une échéance de prêt n'est pas une pièce du journal : elle décrit ce qui
-- reste à payer, pas ce qui a été payé. Les remboursements, eux, restent
-- INSERT seul — ils portent des écritures et ne se suppriment jamais.
GRANT DELETE ON echeance_pret TO tontine_app;

COMMIT;
