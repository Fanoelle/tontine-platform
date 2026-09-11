-- =============================================================================
-- 003 — Cycle, échéances, cotisations et tour de rôle ROSCA
--
-- Le cycle et ses échéances appartiennent au socle commun : les trois mécanismes
-- appellent des cotisations. Seule `tour` est une spécialisation ROSCA, isolée
-- par une contrainte de cohérence de type (décision 0002).
--
-- DISTINCTION STRUCTURANTE — échéance et cotisation sont deux tables :
--   echeance   ce qui DOIT être versé, généré à l'ouverture du cycle
--   cotisation ce qui l'A ÉTÉ, imputé à une échéance
-- Les confondre interdirait les versements partiels (F-COT-03) et surtout
-- rendrait INDÉTECTABLE la cotisation manquante (F-ANO-01) : on ne constate
-- l'absence que si l'attendu est matérialisé.
--
-- Ce fichier pose aussi le second verrou de R-02 : la révocation des privilèges
-- UPDATE et DELETE sur le journal, pour le rôle applicatif.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    CREATE TYPE statut_cycle AS ENUM
        ('PREPARATION', 'EN_COURS', 'SUSPENDU', 'CLOTURE', 'ANNULE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE statut_echeance AS ENUM
        ('ATTENDUE', 'PARTIELLE', 'REGLEE', 'IMPAYEE', 'DISPENSEE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE moyen_paiement AS ENUM
        ('ESPECES', 'MOBILE_MONEY', 'VIREMENT', 'COMPENSATION');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON TYPE moyen_paiement IS
    'COMPENSATION : une cotisation réglée en retenant la somme sur une cagnotte '
    'à recevoir. Aucun argent ne change de main, l''écriture existe pourtant. '
    'L''omettre forcerait le trésorier à inventer un versement fictif.';

-- -----------------------------------------------------------------------------
-- cycle
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cycle (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    groupe_id       UUID         NOT NULL REFERENCES groupe(id) ON DELETE RESTRICT,
    numero          INTEGER      NOT NULL CHECK (numero > 0),
    date_debut      DATE         NOT NULL,
    date_fin_prevue DATE,
    date_cloture    DATE,
    statut          statut_cycle NOT NULL DEFAULT 'PREPARATION',
    motif_cloture   TEXT,
    cree_le         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    modifie_le      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT cycle_fin_coherente
        CHECK (date_fin_prevue IS NULL OR date_fin_prevue > date_debut),
    -- Un cycle clôturé porte sa date ; un cycle non clôturé ne peut pas en avoir.
    CONSTRAINT cycle_cloture_coherente CHECK (
        (statut = 'CLOTURE' AND date_cloture IS NOT NULL)
        OR
        (statut <> 'CLOTURE' AND date_cloture IS NULL)
    )
);

COMMENT ON TABLE cycle IS
    'Période au terme de laquelle, en ROSCA, tous les membres ont bénéficié d''un '
    'tour (F-GRP-05). CLOTURE est terminal : rouvrir permettrait de réécrire un '
    'exercice arrêté.';

CREATE UNIQUE INDEX IF NOT EXISTS cycle_numero_idx ON cycle (groupe_id, numero);

-- Un seul cycle EN_COURS par groupe. Index partiel plutôt que contrôle
-- applicatif : deux ouvertures concurrentes passeraient chacune un SELECT de
-- vérification avant que l'autre ne valide.
CREATE UNIQUE INDEX IF NOT EXISTS cycle_en_cours_unique_idx
    ON cycle (groupe_id)
    WHERE statut = 'EN_COURS';

DROP TRIGGER IF EXISTS trg_cycle_modifie_le ON cycle;
CREATE TRIGGER trg_cycle_modifie_le
    BEFORE UPDATE ON cycle
    FOR EACH ROW EXECUTE FUNCTION toucher_modifie_le();

-- CLOTURE est terminal (etats.md §1). Une transition sortante rendrait
-- réinscriptible un exercice arrêté.
CREATE OR REPLACE FUNCTION refuser_reouverture_cycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.statut = 'CLOTURE' AND NEW.statut <> 'CLOTURE' THEN
        RAISE EXCEPTION
            'Un cycle clôturé ne se rouvre pas (F-GRP-05) : % → % refusé',
            OLD.statut, NEW.statut
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cycle_terminal ON cycle;
CREATE TRIGGER trg_cycle_terminal
    BEFORE UPDATE ON cycle
    FOR EACH ROW EXECUTE FUNCTION refuser_reouverture_cycle();

-- -----------------------------------------------------------------------------
-- tour — SPÉCIALISATION ROSCA
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tour (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id            UUID        NOT NULL REFERENCES cycle(id) ON DELETE RESTRICT,
    rang                INTEGER     NOT NULL CHECK (rang > 0),
    beneficiaire_id     UUID        NOT NULL REFERENCES membre(id) ON DELETE RESTRICT,
    date_remise_prevue  DATE        NOT NULL,
    date_remise_reelle  DATE,
    montant_cagnotte    BIGINT      CHECK (montant_cagnotte > 0),
    ecriture_remise_id  UUID        REFERENCES ecriture(id) ON DELETE RESTRICT,
    cree_le             TIMESTAMPTZ NOT NULL DEFAULT now(),
    modifie_le          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Une remise porte ses trois informations, ou aucune : un tour remis sans
    -- écriture serait un mouvement d'argent hors journal (F-TRX-01).
    CONSTRAINT tour_remise_coherente CHECK (
        (date_remise_reelle IS NULL     AND montant_cagnotte IS NULL
                                        AND ecriture_remise_id IS NULL)
        OR
        (date_remise_reelle IS NOT NULL AND montant_cagnotte IS NOT NULL
                                        AND ecriture_remise_id IS NOT NULL)
    )
);

COMMENT ON TABLE tour IS
    'Spécialisation ROSCA (décision 0002). Un rang, un bénéficiaire, une '
    'cagnotte. N''existe que pour les groupes de type ROSCA — vérifié par '
    'déclencheur.';

CREATE UNIQUE INDEX IF NOT EXISTS tour_rang_idx ON tour (cycle_id, rang);

-- R-04, F-TOU-05 — un membre ne bénéficie qu'UNE fois par cycle. C'est
-- l'invariant qui protège du mode de défaillance classique des tontines
-- rotatives : un membre servi deux fois pendant que d'autres attendent.
CREATE UNIQUE INDEX IF NOT EXISTS tour_beneficiaire_unique_idx
    ON tour (cycle_id, beneficiaire_id);

CREATE INDEX IF NOT EXISTS tour_cycle_rang_idx ON tour (cycle_id, rang);

DROP TRIGGER IF EXISTS trg_tour_modifie_le ON tour;
CREATE TRIGGER trg_tour_modifie_le
    BEFORE UPDATE ON tour
    FOR EACH ROW EXECUTE FUNCTION toucher_modifie_le();

-- Cohérence de type ET de cloisonnement. Une ligne de `tour` ne peut référencer
-- qu'un cycle de groupe ROSCA : c'est ce qui rend la spécialisation sûre sans
-- héritage de tables (décision 0002).
CREATE OR REPLACE FUNCTION verifier_tour_rosca()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_type           type_groupe;
    v_groupe_cycle   UUID;
    v_groupe_benef   UUID;
BEGIN
    SELECT g.type, g.id INTO v_type, v_groupe_cycle
      FROM cycle c JOIN groupe g ON g.id = c.groupe_id
     WHERE c.id = NEW.cycle_id;

    IF v_type <> 'ROSCA' THEN
        RAISE EXCEPTION
            'Un tour de rôle n''existe que pour un groupe ROSCA (décision 0002), pas %',
            v_type
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT m.groupe_id INTO v_groupe_benef FROM membre m WHERE m.id = NEW.beneficiaire_id;

    IF v_groupe_benef IS DISTINCT FROM v_groupe_cycle THEN
        RAISE EXCEPTION
            'Cloisonnement (N-SEC-02) : le bénéficiaire n''appartient pas au groupe du cycle'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_tour_rosca ON tour;
CREATE TRIGGER trg_tour_rosca
    BEFORE INSERT OR UPDATE ON tour
    FOR EACH ROW EXECUTE FUNCTION verifier_tour_rosca();

-- -----------------------------------------------------------------------------
-- echeance — ce qui DOIT être versé (F-COT-01)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS echeance (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    cycle_id        UUID            NOT NULL REFERENCES cycle(id)  ON DELETE RESTRICT,
    membre_id       UUID            NOT NULL REFERENCES membre(id) ON DELETE RESTRICT,
    tour_id         UUID            REFERENCES tour(id) ON DELETE RESTRICT,
    date_echeance   DATE            NOT NULL,
    montant_attendu BIGINT          NOT NULL CHECK (montant_attendu > 0),
    montant_regle   BIGINT          NOT NULL DEFAULT 0 CHECK (montant_regle >= 0),
    statut          statut_echeance NOT NULL DEFAULT 'ATTENDUE',
    motif_dispense  TEXT,
    dispense_par    UUID            REFERENCES membre(id) ON DELETE RESTRICT,
    cree_le         TIMESTAMPTZ     NOT NULL DEFAULT now(),
    modifie_le      TIMESTAMPTZ     NOT NULL DEFAULT now(),

    -- Une dispense porte toujours son motif et son décideur (F-COT-07, N-TRC-03).
    CONSTRAINT echeance_dispense_coherente CHECK (
        statut <> 'DISPENSEE'
        OR (length(btrim(motif_dispense)) > 0 AND dispense_par IS NOT NULL)
    )
);

COMMENT ON TABLE echeance IS
    'Montant attendu d''un membre à une date (F-COT-01). Unité de suivi du '
    'recouvrement. Distincte de `cotisation` : sans attendu matérialisé, une '
    'cotisation manquante serait indétectable (F-ANO-01).';
COMMENT ON COLUMN echeance.montant_attendu IS
    'FIGÉ à la génération, au montant de la règle en vigueur ce jour-là (R-09). '
    'Sans ce figeage, changer la règle modifierait rétroactivement les arriérés '
    'de tous les membres.';
COMMENT ON COLUMN echeance.montant_regle IS
    'Dénormalisation ASSUMÉE, maintenue exclusivement par déclencheur depuis '
    '`cotisation`. Jamais écrite par l''application. La lecture est constante là '
    'où le recalcul serait une agrégation à chaque affichage (N-PRF-02). Un écart '
    'entre ce champ et la somme réelle est précisément ce que détecte F-ANO-04.';

CREATE UNIQUE INDEX IF NOT EXISTS echeance_unique_idx
    ON echeance (cycle_id, membre_id, date_echeance);

-- Impayés (F-COT-04) et relevé individuel (F-RAP-01).
CREATE INDEX IF NOT EXISTS echeance_cycle_statut_idx ON echeance (cycle_id, statut);
CREATE INDEX IF NOT EXISTS echeance_membre_date_idx  ON echeance (membre_id, date_echeance);

DROP TRIGGER IF EXISTS trg_echeance_modifie_le ON echeance;
CREATE TRIGGER trg_echeance_modifie_le
    BEFORE UPDATE ON echeance
    FOR EACH ROW EXECUTE FUNCTION toucher_modifie_le();

CREATE OR REPLACE FUNCTION verifier_echeance_cloisonnement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_groupe_cycle UUID;
    v_groupe_membre UUID;
BEGIN
    SELECT c.groupe_id INTO v_groupe_cycle  FROM cycle  c WHERE c.id = NEW.cycle_id;
    SELECT m.groupe_id INTO v_groupe_membre FROM membre m WHERE m.id = NEW.membre_id;

    IF v_groupe_cycle IS DISTINCT FROM v_groupe_membre THEN
        RAISE EXCEPTION
            'Cloisonnement (N-SEC-02) : le membre n''appartient pas au groupe du cycle'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_echeance_cloisonnement ON echeance;
CREATE TRIGGER trg_echeance_cloisonnement
    BEFORE INSERT OR UPDATE ON echeance
    FOR EACH ROW EXECUTE FUNCTION verifier_echeance_cloisonnement();

-- -----------------------------------------------------------------------------
-- cotisation — ce qui A ÉTÉ versé (F-COT-02)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cotisation (
    id                 UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    echeance_id        UUID           NOT NULL REFERENCES echeance(id) ON DELETE RESTRICT,
    montant            BIGINT         NOT NULL CHECK (montant > 0),
    date_versement     DATE           NOT NULL,
    moyen              moyen_paiement NOT NULL,
    reference_externe  TEXT,
    ecriture_id        UUID           NOT NULL REFERENCES ecriture(id) ON DELETE RESTRICT,
    saisi_par          UUID           NOT NULL REFERENCES membre(id)   ON DELETE RESTRICT,
    cree_le            TIMESTAMPTZ    NOT NULL DEFAULT now()
);

COMMENT ON TABLE cotisation IS
    'Versement effectif imputé à une échéance (F-COT-02). `ecriture_id` est NOT '
    'NULL : aucun versement n''existe hors du journal (F-TRX-01). Pas de '
    'modifie_le — une cotisation se corrige par écriture inverse, comme son '
    'écriture.';
COMMENT ON COLUMN cotisation.reference_externe IS
    'Référence Mobile Money (F-TRX-06). Deux cotisations de même référence sont '
    'une double saisie certaine, non probable (F-ANO-05).';

CREATE INDEX IF NOT EXISTS cotisation_echeance_idx  ON cotisation (echeance_id);
CREATE INDEX IF NOT EXISTS cotisation_ecriture_idx  ON cotisation (ecriture_id);

-- -----------------------------------------------------------------------------
-- Recalcul de montant_regle et du statut — SEUL auteur de ces deux colonnes
--
-- L'application ne les écrit jamais. C'est la condition qui rend la
-- dénormalisation sûre : une seule source d'écriture, dérivée du journal.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION recalculer_echeance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_echeance_id UUID;
    v_total       BIGINT;
    v_attendu     BIGINT;
    v_date        DATE;
    v_statut      statut_echeance;
    v_actuel      statut_echeance;
BEGIN
    v_echeance_id := COALESCE(NEW.echeance_id, OLD.echeance_id);

    SELECT e.montant_attendu, e.date_echeance, e.statut
      INTO v_attendu, v_date, v_actuel
      FROM echeance e WHERE e.id = v_echeance_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(SUM(c.montant), 0) INTO v_total
      FROM cotisation c WHERE c.echeance_id = v_echeance_id;

    -- Une dispense est une décision du groupe : elle n'est pas révisée par un
    -- versement. Le membre peut verser volontairement malgré la dispense.
    IF v_actuel = 'DISPENSEE' THEN
        UPDATE echeance SET montant_regle = v_total WHERE id = v_echeance_id;
        RETURN NULL;
    END IF;

    v_statut := CASE
        WHEN v_total >= v_attendu        THEN 'REGLEE'
        WHEN v_total > 0                 THEN 'PARTIELLE'
        WHEN v_date < CURRENT_DATE       THEN 'IMPAYEE'
        ELSE                                  'ATTENDUE'
    END;

    UPDATE echeance
       SET montant_regle = v_total,
           statut        = v_statut
     WHERE id = v_echeance_id;

    RETURN NULL;
END $$;

COMMENT ON FUNCTION recalculer_echeance() IS
    'Seul auteur de echeance.montant_regle et echeance.statut. L''état découle '
    'du journal : REGLEE si le reliquat est nul, PARTIELLE s''il reste dû, '
    'IMPAYEE si rien n''est versé et la date dépassée (etats.md §2). REGLEE '
    'admet un retour vers PARTIELLE — c''est la correction par écriture inverse '
    '(F-COT-05), et c''est volontaire.';

DROP TRIGGER IF EXISTS trg_cotisation_recalcul ON cotisation;
CREATE TRIGGER trg_cotisation_recalcul
    AFTER INSERT OR UPDATE OR DELETE ON cotisation
    FOR EACH ROW EXECUTE FUNCTION recalculer_echeance();

-- Cloisonnement et cohérence : la cotisation, son échéance et son écriture
-- appartiennent au même groupe.
CREATE OR REPLACE FUNCTION verifier_cotisation_cloisonnement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_groupe_echeance UUID;
    v_groupe_ecriture UUID;
BEGIN
    SELECT c.groupe_id INTO v_groupe_echeance
      FROM echeance e JOIN cycle c ON c.id = e.cycle_id
     WHERE e.id = NEW.echeance_id;

    SELECT e.groupe_id INTO v_groupe_ecriture
      FROM ecriture e WHERE e.id = NEW.ecriture_id;

    IF v_groupe_echeance IS DISTINCT FROM v_groupe_ecriture THEN
        RAISE EXCEPTION
            'Cloisonnement (N-SEC-02) : l''écriture n''appartient pas au groupe de l''échéance'
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cotisation_cloisonnement ON cotisation;
CREATE TRIGGER trg_cotisation_cloisonnement
    BEFORE INSERT OR UPDATE ON cotisation
    FOR EACH ROW EXECUTE FUNCTION verifier_cotisation_cloisonnement();

-- -----------------------------------------------------------------------------
-- Vues de restitution
-- -----------------------------------------------------------------------------

-- Relevé individuel en langage courant (F-RAP-01, N-USG-05). Aucun débit ni
-- crédit n'y figure : le membre lit « vous avez versé 5 000 F le 3 mars ».
CREATE OR REPLACE VIEW v_releve_membre AS
SELECT m.id                AS membre_id,
       m.groupe_id,
       m.nom_complet,
       e.id                AS echeance_id,
       e.date_echeance,
       e.montant_attendu,
       e.montant_regle,
       e.montant_attendu - e.montant_regle AS reliquat,
       e.statut,
       c.numero            AS cycle_numero
FROM membre m
JOIN echeance e ON e.membre_id = m.id
JOIN cycle    c ON c.id = e.cycle_id
ORDER BY m.nom_complet, e.date_echeance;

COMMENT ON VIEW v_releve_membre IS
    'F-RAP-01, N-USG-05 — relevé sans vocabulaire comptable. Ne filtre PAS sur '
    'membre.supprime : un membre radié conserve son historique (R-08).';

-- Cagnotte d'un tour ROSCA : attendue et réellement encaissée. L'écart entre les
-- deux est ce que surveille R-05 / F-ANO-04.
CREATE OR REPLACE VIEW v_cagnotte_tour AS
SELECT t.id                              AS tour_id,
       t.cycle_id,
       t.rang,
       t.beneficiaire_id,
       t.date_remise_prevue,
       t.date_remise_reelle,
       t.montant_cagnotte,
       COALESCE(SUM(e.montant_attendu), 0) AS cagnotte_attendue,
       COALESCE(SUM(e.montant_regle),   0) AS cagnotte_encaissee
FROM tour t
LEFT JOIN echeance e ON e.tour_id = t.id
GROUP BY t.id, t.cycle_id, t.rang, t.beneficiaire_id,
         t.date_remise_prevue, t.date_remise_reelle, t.montant_cagnotte;

COMMENT ON VIEW v_cagnotte_tour IS
    'R-05 — la cagnotte remise doit égaler la somme des cotisations du tour. '
    'L''écart n''est pas rejeté (une dispense peut le justifier) mais déclenche '
    'une anomalie à vérifier.';

-- -----------------------------------------------------------------------------
-- R-02 — SECOND VERROU : révocation des privilèges sur le journal
--
-- Le rôle applicatif n'a jamais le droit de modifier le journal. Le déclencheur
-- de 002 protège de l'erreur de code ; cette révocation protège d'un déclencheur
-- désactivé. Les deux sont nécessaires : N-INT-02 exige que le refus ne dépende
-- pas de la discipline du code.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tontine_app') THEN
        CREATE ROLE tontine_app LOGIN PASSWORD 'dev';
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO tontine_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tontine_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO tontine_app;

-- Puis on retire ce qui ne doit jamais être accordé.
REVOKE UPDATE, DELETE ON ecriture       FROM tontine_app;
REVOKE UPDATE, DELETE ON ligne_ecriture FROM tontine_app;

-- montant_regle et statut sont écrits par déclencheur uniquement. Le déclencheur
-- s'exécute avec les droits du propriétaire, la révocation ne le gêne donc pas ;
-- elle empêche en revanche l'application de les écrire directement.
REVOKE UPDATE (montant_regle, statut) ON echeance FROM tontine_app;

COMMENT ON ROLE tontine_app IS
    'Rôle applicatif (R-02). UPDATE et DELETE révoqués sur le journal : le refus '
    'ne dépend pas de la discipline du code.';

COMMIT;
