-- =============================================================================
-- 002 — Journal comptable immuable en partie double
--
-- Cœur du modèle (décision 0003). Toute opération qui déplace de l'argent y
-- aboutit, quel que soit le mécanisme du groupe.
--
-- DEUX INVARIANTS structurants, tenus par la base et non par l'application :
--
--   R-01 équilibre    Σ débits = Σ crédits, au moins deux lignes.
--                     CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED : le
--                     contrôle s'exécute en FIN de transaction. Un déclencheur
--                     immédiat rejetterait la première ligne, puisqu'une écriture
--                     est nécessairement déséquilibrée tant qu'elle est
--                     incomplète.
--
--   R-02 immuabilité  Ni UPDATE ni DELETE. Deux verrous superposés : révocation
--                     de privilèges (003) ET déclencheur. Le privilège protège
--                     de l'erreur de code, le déclencheur d'une configuration de
--                     privilèges erronée. N-INT-02 exige que la base refuse, pas
--                     seulement l'application.
--
-- Le montant n'est JAMAIS signé : le sens porte le signe. Un montant négatif
-- rendrait R-03 inexprimable en CHECK et ferait coexister deux représentations
-- du même fait comptable — un crédit de 5 000 et un débit de −5 000.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    CREATE TYPE sens_ecriture AS ENUM ('DEBIT', 'CREDIT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE nature_compte AS ENUM (
        'CAISSE',
        'BANQUE',
        'COTISATION_MEMBRE',
        'EPARGNE_MEMBRE',
        'CREANCE_PRET',
        'PRODUIT_INTERET',
        'FONDS_AIDE'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE nature_ecriture AS ENUM (
        'COTISATION',
        'REMISE_CAGNOTTE',
        'OCTROI_PRET',
        'REMBOURSEMENT_PRET',
        'VERSEMENT_AIDE',
        'CORRECTION'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- compte — plan de comptes, propre à chaque groupe
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS compte (
    id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    groupe_id  UUID          NOT NULL REFERENCES groupe(id) ON DELETE RESTRICT,
    nature     nature_compte NOT NULL,
    libelle    TEXT          NOT NULL CHECK (length(btrim(libelle)) > 0),
    membre_id  UUID          REFERENCES membre(id) ON DELETE RESTRICT,
    cree_le    TIMESTAMPTZ   NOT NULL DEFAULT now(),

    -- Un compte individuel EXIGE un membre ; un compte collectif l'INTERDIT.
    -- Sans cette contrainte, un compte de cotisation sans membre serait
    -- insérable et le relevé individuel (F-RAP-01) perdrait silencieusement des
    -- mouvements.
    CONSTRAINT compte_membre_coherent CHECK (
        (nature IN ('COTISATION_MEMBRE', 'EPARGNE_MEMBRE', 'CREANCE_PRET')
            AND membre_id IS NOT NULL)
        OR
        (nature IN ('CAISSE', 'BANQUE', 'PRODUIT_INTERET', 'FONDS_AIDE')
            AND membre_id IS NULL)
    )
);

COMMENT ON TABLE compte IS
    'Plan de comptes du groupe. Mêle comptes collectifs (caisse, banque, fonds) '
    'et comptes individuels (cotisations, épargne, créance de prêt).';
COMMENT ON COLUMN compte.membre_id IS
    'Renseigné pour les seuls comptes individuels. C''est ce qui permet de '
    'produire un relevé individuel (F-RAP-01) par simple filtrage du journal, '
    'sans maintenir aucun solde parallèle.';

-- Un seul compte par nature collective et par groupe : deux caisses espèces
-- rendraient la situation de caisse ambiguë.
CREATE UNIQUE INDEX IF NOT EXISTS compte_collectif_unique_idx
    ON compte (groupe_id, nature)
    WHERE membre_id IS NULL;

-- Un seul compte par nature individuelle et par membre.
CREATE UNIQUE INDEX IF NOT EXISTS compte_individuel_unique_idx
    ON compte (groupe_id, nature, membre_id)
    WHERE membre_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS compte_groupe_idx ON compte (groupe_id);

-- Cohérence de cloisonnement : un compte individuel ne peut pas référencer un
-- membre d'un AUTRE groupe. N-SEC-02 exige un cloisonnement strict ; une
-- clé étrangère simple ne l'exprime pas, puisqu'elle ignore le groupe.
CREATE OR REPLACE FUNCTION verifier_compte_membre_meme_groupe()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_groupe_membre UUID;
BEGIN
    IF NEW.membre_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT m.groupe_id INTO v_groupe_membre FROM membre m WHERE m.id = NEW.membre_id;

    IF v_groupe_membre IS DISTINCT FROM NEW.groupe_id THEN
        RAISE EXCEPTION
            'Cloisonnement (N-SEC-02) : le membre % appartient au groupe %, pas au groupe %',
            NEW.membre_id, v_groupe_membre, NEW.groupe_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_compte_meme_groupe ON compte;
CREATE TRIGGER trg_compte_meme_groupe
    BEFORE INSERT OR UPDATE ON compte
    FOR EACH ROW EXECUTE FUNCTION verifier_compte_membre_meme_groupe();

-- -----------------------------------------------------------------------------
-- ecriture — opération comptable. JAMAIS de modifie_le : jamais modifiée.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ecriture (
    id                   UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    groupe_id            UUID            NOT NULL REFERENCES groupe(id) ON DELETE RESTRICT,
    numero               BIGINT          NOT NULL,
    date_operation       DATE            NOT NULL,
    libelle              TEXT            NOT NULL CHECK (length(btrim(libelle)) > 0),
    nature               nature_ecriture NOT NULL,
    ecriture_corrigee_id UUID            REFERENCES ecriture(id) ON DELETE RESTRICT,
    motif_correction     TEXT,
    saisi_par            UUID            NOT NULL REFERENCES membre(id) ON DELETE RESTRICT,
    cree_le              TIMESTAMPTZ     NOT NULL DEFAULT now(),

    -- Une correction porte les deux informations, ou aucune. N-TRC-02 et
    -- N-TRC-03 : toute correction référence l'écriture corrigée ET son motif.
    CONSTRAINT ecriture_correction_coherente CHECK (
        (ecriture_corrigee_id IS NULL     AND motif_correction IS NULL)
        OR
        (ecriture_corrigee_id IS NOT NULL AND length(btrim(motif_correction)) > 0
            AND nature = 'CORRECTION')
    )
);

COMMENT ON TABLE ecriture IS
    'Opération comptable équilibrée (F-TRX-01). IMMUABLE : pas de colonne '
    'modifie_le, ni UPDATE ni DELETE (R-02). Une erreur se corrige par une '
    'écriture inverse, jamais par retouche.';
COMMENT ON COLUMN ecriture.numero IS
    'Numérotation continue par groupe. Une rupture de séquence est visible et '
    'constitue en soi un signal d''audit.';
COMMENT ON COLUMN ecriture.ecriture_corrigee_id IS
    'Auto-référence, PAS un état (N-TRC-02). Une écriture corrigée reste valide '
    'au journal, neutralisée par son inverse. Un booléen `annulee` violerait R-02 '
    'puisqu''il faudrait modifier l''écriture après coup.';

CREATE UNIQUE INDEX IF NOT EXISTS ecriture_numero_idx
    ON ecriture (groupe_id, numero);

-- Journal filtré et situation de caisse à date (F-TRX-03, F-TRX-04).
CREATE INDEX IF NOT EXISTS ecriture_groupe_date_idx
    ON ecriture (groupe_id, date_operation);

-- Une écriture ne peut être corrigée qu'UNE fois. Sans cet index, deux
-- écritures inverses neutraliseraient deux fois la même somme et créeraient
-- l'incohérence que le journal doit rendre impossible.
CREATE UNIQUE INDEX IF NOT EXISTS ecriture_correction_unique_idx
    ON ecriture (ecriture_corrigee_id)
    WHERE ecriture_corrigee_id IS NOT NULL;

-- Numérotation par groupe, attribuée à l'insertion.
-- POURQUOI pas une SEQUENCE : une séquence est globale et laisserait des trous
-- par groupe (numéros consommés par d'autres groupes), ce qui ôterait à la
-- continuité sa valeur de signal. Le verrou consultatif sérialise l'attribution
-- par groupe sans bloquer les autres groupes.
CREATE OR REPLACE FUNCTION attribuer_numero_ecriture()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.numero IS NOT NULL AND NEW.numero > 0 THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(NEW.groupe_id::text));

    SELECT COALESCE(MAX(e.numero), 0) + 1
      INTO NEW.numero
      FROM ecriture e
     WHERE e.groupe_id = NEW.groupe_id;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ecriture_numero ON ecriture;
CREATE TRIGGER trg_ecriture_numero
    BEFORE INSERT ON ecriture
    FOR EACH ROW EXECUTE FUNCTION attribuer_numero_ecriture();

-- Cohérence de cloisonnement : l'auteur appartient au groupe de l'écriture, et
-- une écriture corrigée appartient au même groupe.
CREATE OR REPLACE FUNCTION verifier_ecriture_cloisonnement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_groupe_auteur  UUID;
    v_groupe_corrige UUID;
BEGIN
    SELECT m.groupe_id INTO v_groupe_auteur FROM membre m WHERE m.id = NEW.saisi_par;

    IF v_groupe_auteur IS DISTINCT FROM NEW.groupe_id THEN
        RAISE EXCEPTION
            'Cloisonnement (N-SEC-02) : l''auteur % n''appartient pas au groupe %',
            NEW.saisi_par, NEW.groupe_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF NEW.ecriture_corrigee_id IS NOT NULL THEN
        SELECT e.groupe_id INTO v_groupe_corrige
          FROM ecriture e WHERE e.id = NEW.ecriture_corrigee_id;

        IF v_groupe_corrige IS DISTINCT FROM NEW.groupe_id THEN
            RAISE EXCEPTION
                'Cloisonnement (N-SEC-02) : l''écriture corrigée appartient à un autre groupe'
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ecriture_cloisonnement ON ecriture;
CREATE TRIGGER trg_ecriture_cloisonnement
    BEFORE INSERT ON ecriture
    FOR EACH ROW EXECUTE FUNCTION verifier_ecriture_cloisonnement();

-- -----------------------------------------------------------------------------
-- ligne_ecriture — mouvement élémentaire
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ligne_ecriture (
    id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    ecriture_id UUID          NOT NULL REFERENCES ecriture(id) ON DELETE RESTRICT,
    compte_id   UUID          NOT NULL REFERENCES compte(id)   ON DELETE RESTRICT,
    sens        sens_ecriture NOT NULL,
    montant     BIGINT        NOT NULL CHECK (montant > 0),
    ordre       INTEGER       NOT NULL DEFAULT 1 CHECK (ordre > 0)
);

COMMENT ON TABLE ligne_ecriture IS
    'Mouvement élémentaire : un compte, un sens, un montant. Au moins deux par '
    'écriture, équilibrées (R-01).';
COMMENT ON COLUMN ligne_ecriture.montant IS
    'BIGINT en francs, strictement positif (R-03, N-INT-03). Le signe est porté '
    'par le sens, jamais par le montant : un flottant ne porte pas d''argent et '
    'un montant négatif ferait coexister deux écritures pour un même fait.';

-- Calcul de solde (N-PRF-02) — index le plus sollicité du schéma.
CREATE INDEX IF NOT EXISTS ligne_ecriture_compte_idx ON ligne_ecriture (compte_id);
CREATE INDEX IF NOT EXISTS ligne_ecriture_ecriture_idx ON ligne_ecriture (ecriture_id);

-- Une ligne appartient au groupe de son écriture.
CREATE OR REPLACE FUNCTION verifier_ligne_cloisonnement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_groupe_ecriture UUID;
    v_groupe_compte   UUID;
BEGIN
    SELECT e.groupe_id INTO v_groupe_ecriture FROM ecriture e WHERE e.id = NEW.ecriture_id;
    SELECT c.groupe_id INTO v_groupe_compte   FROM compte   c WHERE c.id = NEW.compte_id;

    IF v_groupe_ecriture IS DISTINCT FROM v_groupe_compte THEN
        RAISE EXCEPTION
            'Cloisonnement (N-SEC-02) : le compte % n''appartient pas au groupe de l''écriture',
            NEW.compte_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ligne_cloisonnement ON ligne_ecriture;
CREATE TRIGGER trg_ligne_cloisonnement
    BEFORE INSERT ON ligne_ecriture
    FOR EACH ROW EXECUTE FUNCTION verifier_ligne_cloisonnement();

-- -----------------------------------------------------------------------------
-- R-01 — ÉQUILIBRE. Le contrôle le plus important du schéma.
--
-- CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED : vérifié en fin de
-- transaction, quand toutes les lignes sont insérées. C'est la seule forme
-- possible — une écriture est nécessairement déséquilibrée entre sa première et
-- sa dernière ligne.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION verifier_equilibre_ecriture()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_ecriture_id UUID;
    v_debit       BIGINT;
    v_credit      BIGINT;
    v_lignes      INTEGER;
BEGIN
    v_ecriture_id := COALESCE(NEW.ecriture_id, OLD.ecriture_id);

    -- L'écriture a pu être supprimée dans la même transaction (rollback partiel
    -- d'un scénario de test) : il n'y a alors plus rien à vérifier.
    IF NOT EXISTS (SELECT 1 FROM ecriture WHERE id = v_ecriture_id) THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(SUM(l.montant) FILTER (WHERE l.sens = 'DEBIT'),  0),
           COALESCE(SUM(l.montant) FILTER (WHERE l.sens = 'CREDIT'), 0),
           COUNT(*)
      INTO v_debit, v_credit, v_lignes
      FROM ligne_ecriture l
     WHERE l.ecriture_id = v_ecriture_id;

    IF v_lignes < 2 THEN
        RAISE EXCEPTION
            'Écriture % : une écriture comporte au moins deux lignes (R-01), % trouvée(s)',
            v_ecriture_id, v_lignes
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_debit <> v_credit THEN
        RAISE EXCEPTION
            'Écriture % déséquilibrée (R-01) : débit % ≠ crédit %, écart de %',
            v_ecriture_id, v_debit, v_credit, abs(v_debit - v_credit)
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
END $$;

COMMENT ON FUNCTION verifier_equilibre_ecriture() IS
    'R-01, N-INT-02 — la base rejette tout déséquilibre, indépendamment de '
    'l''application. Différé en fin de transaction car une écriture est '
    'nécessairement déséquilibrée tant qu''elle est incomplète.';

DROP TRIGGER IF EXISTS trg_equilibre_ecriture ON ligne_ecriture;
CREATE CONSTRAINT TRIGGER trg_equilibre_ecriture
    AFTER INSERT OR UPDATE OR DELETE ON ligne_ecriture
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION verifier_equilibre_ecriture();

-- Une écriture sans aucune ligne passerait entre les mailles du déclencheur
-- ci-dessus, qui ne se déclenche que sur `ligne_ecriture`.
CREATE OR REPLACE FUNCTION verifier_ecriture_non_vide()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ligne_ecriture WHERE ecriture_id = NEW.id) THEN
        RAISE EXCEPTION
            'Écriture % sans ligne (R-01) : une écriture porte au moins deux lignes',
            NEW.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_ecriture_non_vide ON ecriture;
CREATE CONSTRAINT TRIGGER trg_ecriture_non_vide
    AFTER INSERT ON ecriture
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION verifier_ecriture_non_vide();

-- -----------------------------------------------------------------------------
-- R-02 — IMMUABILITÉ. Premier des deux verrous (le second est la révocation de
-- privilèges, migration 003).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION refuser_modification_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'Le journal comptable est immuable (R-02, F-TRX-02) : % interdit sur %. '
        'Corrigez par une écriture inverse portant ecriture_corrigee_id.',
        TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
END $$;

COMMENT ON FUNCTION refuser_modification_journal() IS
    'R-02 — second verrou, doublant la révocation de privilèges. Le privilège '
    'protège de l''erreur de code, ce déclencheur d''une configuration de '
    'privilèges erronée.';

DROP TRIGGER IF EXISTS trg_ecriture_immuable ON ecriture;
CREATE TRIGGER trg_ecriture_immuable
    BEFORE UPDATE OR DELETE ON ecriture
    FOR EACH ROW EXECUTE FUNCTION refuser_modification_journal();

DROP TRIGGER IF EXISTS trg_ligne_immuable ON ligne_ecriture;
CREATE TRIGGER trg_ligne_immuable
    BEFORE UPDATE OR DELETE ON ligne_ecriture
    FOR EACH ROW EXECUTE FUNCTION refuser_modification_journal();

-- -----------------------------------------------------------------------------
-- Soldes — TOUJOURS recalculés, jamais stockés (F-TRX-04)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_solde_compte AS
SELECT c.id        AS compte_id,
       c.groupe_id,
       c.nature,
       c.libelle,
       c.membre_id,
       COALESCE(SUM(l.montant) FILTER (WHERE l.sens = 'DEBIT'),  0)
     - COALESCE(SUM(l.montant) FILTER (WHERE l.sens = 'CREDIT'), 0) AS solde
FROM compte c
LEFT JOIN ligne_ecriture l ON l.compte_id = c.id
GROUP BY c.id, c.groupe_id, c.nature, c.libelle, c.membre_id;

COMMENT ON VIEW v_solde_compte IS
    'Solde recalculé par sommation du journal. Aucun solde n''est stocké comme '
    'source de vérité : un solde maintenu peut diverger, un solde calculé ne le '
    'peut pas. C''est ce qui donne à F-ANO-04 une référence sûre.';

-- Situation de caisse à une date passée (F-TRX-04). Filtre sur date_operation —
-- la date réelle du mouvement — et non sur cree_le, qui est la date de saisie :
-- un versement de fin mars saisi en avril appartient à la situation de mars.
CREATE OR REPLACE FUNCTION solde_a_date(p_compte_id UUID, p_date DATE)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(SUM(l.montant) FILTER (WHERE l.sens = 'DEBIT'),  0)
         - COALESCE(SUM(l.montant) FILTER (WHERE l.sens = 'CREDIT'), 0)
    FROM ligne_ecriture l
    JOIN ecriture e ON e.id = l.ecriture_id
    WHERE l.compte_id = p_compte_id
      AND e.date_operation <= p_date;
$$;

COMMENT ON FUNCTION solde_a_date(UUID, DATE) IS
    'F-TRX-04 — solde à une date passée. Filtre sur date_operation (date réelle '
    'du mouvement), jamais sur cree_le (date de saisie) : un versement de mars '
    'saisi en avril appartient à la situation de mars.';

COMMIT;
