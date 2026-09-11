-- =============================================================================
-- 001 — Socle commun : types, groupe, règles datées, membres, rôles
--
-- Ce fichier crée ce qui vaut pour les trois mécanismes (décision 0002). Les
-- spécialisations ROSCA/ASCA/MUTUELLE viennent plus tard : leurs règles d'argent
-- sont incompatibles et ne doivent pas contaminer le socle.
--
-- POURQUOI btree_gist. La contrainte d'exclusion de `regle_groupe` (R-09) mêle
-- une égalité sur UUID et un chevauchement de plage de dates. GiST ne sait pas
-- indexer l'égalité d'un UUID sans cette extension.
--
-- RÉ-EXÉCUTABLE sans effet de bord : il n'existe pas de table de suivi des
-- migrations (décision 0001), l'idempotence en tient lieu.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- Types énumérés
--
-- POURQUOI des ENUM plutôt que des tables de référence. Ces domaines sont fermés
-- et stables : un quatrième sens comptable n'existe pas, une quatrième valeur de
-- `statut_echeance` demanderait de revoir la machine à états (etats.md). Un ENUM
-- rend la valeur invalide impossible à insérer, là où une table de référence la
-- rend seulement improbable. Le coût — ajouter une valeur exige une migration —
-- est ici un bénéfice : cela force à traiter le cas.
-- -----------------------------------------------------------------------------

DO $$
BEGIN
    CREATE TYPE type_groupe AS ENUM ('ROSCA', 'ASCA', 'MUTUELLE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE periodicite AS ENUM
        ('HEBDOMADAIRE', 'QUINZAINE', 'MENSUELLE', 'TRIMESTRIELLE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE role_membre AS ENUM
        ('MEMBRE', 'TRESORIER', 'PRESIDENT', 'COMMISSAIRE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE statut_membre AS ENUM ('ACTIF', 'SUSPENDU', 'RADIE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- groupe — entité racine, tout est cloisonné par elle (N-SEC-02)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS groupe (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    nom           TEXT        NOT NULL CHECK (length(btrim(nom)) > 0),
    type          type_groupe NOT NULL,
    devise        CHAR(3)     NOT NULL DEFAULT 'XAF' CHECK (devise ~ '^[A-Z]{3}$'),
    date_creation DATE        NOT NULL DEFAULT CURRENT_DATE,
    archive       BOOLEAN     NOT NULL DEFAULT false,
    cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
    modifie_le    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE groupe IS
    'Entité racine (F-GRP-01). Le type est immuable : voir le déclencheur '
    'refuser_changement_type_groupe.';
COMMENT ON COLUMN groupe.type IS
    'Mécanisme du groupe. Conditionne les tables spécialisées accessibles '
    '(décision 0002). IMMUABLE après création.';
COMMENT ON COLUMN groupe.devise IS 'Code ISO 4217. XAF par défaut (franc CFA).';

-- POURQUOI interdire le changement de type. Un groupe ROSCA ne devient pas une
-- mutuelle : les règles d'argent diffèrent et les écritures déjà passées
-- deviendraient ininterprétables. Un `tour` rattaché à un groupe devenu MUTUELLE
-- n'aurait plus aucun sens, et la contrainte de cohérence de type le refuserait
-- rétroactivement — sur des données déjà écrites.
CREATE OR REPLACE FUNCTION refuser_changement_type_groupe()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.type <> OLD.type THEN
        RAISE EXCEPTION
            'Le type d''un groupe est immuable (F-GRP-01) : % ne peut pas devenir %',
            OLD.type, NEW.type
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_groupe_type_immuable ON groupe;
CREATE TRIGGER trg_groupe_type_immuable
    BEFORE UPDATE ON groupe
    FOR EACH ROW EXECUTE FUNCTION refuser_changement_type_groupe();

-- Tenue de `modifie_le`. Confier cette colonne à l'application garantirait qu'un
-- chemin d'écriture finisse par l'oublier ; le déclencheur la rend inévitable.
CREATE OR REPLACE FUNCTION toucher_modifie_le()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.modifie_le := now();
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_groupe_modifie_le ON groupe;
CREATE TRIGGER trg_groupe_modifie_le
    BEFORE UPDATE ON groupe
    FOR EACH ROW EXECUTE FUNCTION toucher_modifie_le();

-- -----------------------------------------------------------------------------
-- regle_groupe — règles DATÉES, jamais modifiées en place (F-GRP-04, R-09)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS regle_groupe (
    id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    groupe_id           UUID          NOT NULL REFERENCES groupe(id) ON DELETE RESTRICT,
    montant_cotisation  BIGINT        NOT NULL CHECK (montant_cotisation > 0),
    periodicite         periodicite   NOT NULL,
    taux_interet_pret   NUMERIC(5,4)  CHECK (taux_interet_pret >= 0),
    penalite_retard     BIGINT        NOT NULL DEFAULT 0 CHECK (penalite_retard >= 0),
    date_effet          DATE          NOT NULL,
    date_fin_effet      DATE,
    cree_le             TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT regle_groupe_periode_coherente
        CHECK (date_fin_effet IS NULL OR date_fin_effet > date_effet)
);

COMMENT ON TABLE regle_groupe IS
    'Règles datées (F-GRP-04, R-09). Changer le montant de cotisation crée une '
    'nouvelle ligne et clôt la précédente ; modifier en place réécrirait le passé '
    'et rendrait faux tout arriéré déjà appelé.';
COMMENT ON COLUMN regle_groupe.date_fin_effet IS
    'NULL = règle en vigueur. Borne supérieure exclue.';
COMMENT ON COLUMN regle_groupe.taux_interet_pret IS
    'Taux par période, NULL si le groupe prête sans intérêt. NUMERIC et non '
    'flottant, mais il ne porte jamais un montant : seul un résultat de calcul '
    'arrondi à l''entier est stocké (N-INT-03).';

-- R-09 — les périodes d'effet d'un même groupe ne se chevauchent pas.
-- POURQUOI une contrainte d'exclusion plutôt qu'un contrôle applicatif : deux
-- transactions concurrentes passeraient chacune un SELECT de vérification avant
-- que l'autre ne valide. L'exclusion tient sous concurrence, pas le SELECT.
-- `daterange(..., '[)')` : borne haute exclue, donc une règle finissant le 1er
-- mars et la suivante commençant le 1er mars ne se chevauchent pas.
DO $$
BEGIN
    ALTER TABLE regle_groupe ADD CONSTRAINT regle_groupe_sans_chevauchement
        EXCLUDE USING gist (
            groupe_id WITH =,
            daterange(date_effet, date_fin_effet, '[)') WITH &&
        );
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS regle_groupe_groupe_effet_idx
    ON regle_groupe (groupe_id, date_effet DESC);

-- Règle en vigueur à une date donnée. Utilisée pour figer `montant_attendu` à la
-- génération des échéances (F-COT-01) : c'est ce figeage qui empêche qu'un
-- changement de règle modifie rétroactivement les arriérés.
CREATE OR REPLACE FUNCTION regle_en_vigueur(p_groupe_id UUID, p_date DATE)
RETURNS regle_groupe
LANGUAGE sql
STABLE
AS $$
    SELECT r.*
    FROM regle_groupe r
    WHERE r.groupe_id = p_groupe_id
      AND r.date_effet <= p_date
      AND (r.date_fin_effet IS NULL OR r.date_fin_effet > p_date)
    LIMIT 1;
$$;

COMMENT ON FUNCTION regle_en_vigueur(UUID, DATE) IS
    'Règle applicable à une date (R-09). La contrainte d''exclusion garantit '
    'qu''au plus une ligne correspond : le LIMIT 1 documente l''intention, il ne '
    'masque pas une ambiguïté.';

-- -----------------------------------------------------------------------------
-- membre
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS membre (
    id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    groupe_id     UUID          NOT NULL REFERENCES groupe(id) ON DELETE RESTRICT,
    nom_complet   TEXT          NOT NULL CHECK (length(btrim(nom_complet)) > 0),
    telephone     TEXT          NOT NULL CHECK (telephone ~ '^\+[1-9]\d{7,14}$'),
    email         TEXT          CHECK (email IS NULL OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
    date_adhesion DATE          NOT NULL DEFAULT CURRENT_DATE,
    statut        statut_membre NOT NULL DEFAULT 'ACTIF',
    supprime      BOOLEAN       NOT NULL DEFAULT false,
    cree_le       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    modifie_le    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE membre IS
    'Personne physique rattachée à un groupe (F-MBR-01). Suppression logique '
    'uniquement (R-08) : un membre radié conserve son historique comptable.';
COMMENT ON COLUMN membre.telephone IS
    'Identifiant naturel, format international strict (R-10). Beaucoup de membres '
    'n''ont pas d''e-mail ; le numéro est stable et sert de canal de rappel. '
    'Normalisé AVANT insertion : +237690..., 690... et 00237690... créeraient '
    'sinon trois membres distincts.';
COMMENT ON COLUMN membre.supprime IS
    'Suppression logique (R-08). Le journal comptable ignore ce drapeau : filtrer '
    'dessus dans une requête comptable changerait les soldes historiques.';

-- R-10 — téléphone unique par groupe. Partiel sur `NOT supprime` : un numéro
-- réattribué à une nouvelle personne après radiation reste utilisable.
CREATE UNIQUE INDEX IF NOT EXISTS membre_groupe_telephone_idx
    ON membre (groupe_id, telephone)
    WHERE NOT supprime;

CREATE INDEX IF NOT EXISTS membre_groupe_actif_idx
    ON membre (groupe_id)
    WHERE NOT supprime;

DROP TRIGGER IF EXISTS trg_membre_modifie_le ON membre;
CREATE TRIGGER trg_membre_modifie_le
    BEFORE UPDATE ON membre
    FOR EACH ROW EXECUTE FUNCTION toucher_modifie_le();

-- -----------------------------------------------------------------------------
-- membre_role — attribution DATÉE, cumul autorisé (F-MBR-02)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS membre_role (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    membre_id    UUID        NOT NULL REFERENCES membre(id) ON DELETE RESTRICT,
    role         role_membre NOT NULL,
    attribue_le  DATE        NOT NULL DEFAULT CURRENT_DATE,
    attribue_par UUID        REFERENCES membre(id) ON DELETE RESTRICT,
    retire_le    DATE,
    cree_le      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT membre_role_periode_coherente
        CHECK (retire_le IS NULL OR retire_le >= attribue_le)
);

COMMENT ON TABLE membre_role IS
    'Association datée membre/rôle. Table d''association et non colonne, car le '
    'cumul est la norme dans les petits groupes (F-MBR-02). Le cumul '
    'TRESORIER + COMMISSAIRE est permis mais doit être signalé par l''interface '
    '(F-MBR-06) : leur séparation est la garantie du contrôle mutuel.';
COMMENT ON COLUMN membre_role.retire_le IS
    'Retrait daté, jamais supprimé : savoir qui était trésorier en mars est '
    'nécessaire pour interpréter les écritures de mars (N-TRC-01).';

-- Un même couple membre/rôle n'a qu'une attribution active à la fois.
CREATE UNIQUE INDEX IF NOT EXISTS membre_role_actif_idx
    ON membre_role (membre_id, role)
    WHERE retire_le IS NULL;

CREATE INDEX IF NOT EXISTS membre_role_membre_idx ON membre_role (membre_id);

-- Habilitation à une date. Les écritures passées restent signées d'un ancien
-- trésorier, mais il ne conserve pas ses droits (classes.md, Membre.aRole).
CREATE OR REPLACE FUNCTION membre_a_role(
    p_membre_id UUID,
    p_role      role_membre,
    p_date      DATE DEFAULT CURRENT_DATE
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM membre_role mr
        WHERE mr.membre_id = p_membre_id
          AND mr.role      = p_role
          AND mr.attribue_le <= p_date
          AND (mr.retire_le IS NULL OR mr.retire_le > p_date)
    );
$$;

COMMIT;
