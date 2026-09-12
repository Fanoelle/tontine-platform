-- =============================================================================
-- 016 — Historique des opérations (N-TRC-01, N-SEC-06)
--
-- CE QUI MANQUAIT. `journal_acces` consigne les connexions et les REFUS
-- d'habilitation ; le journal comptable consigne les écritures. Entre les deux,
-- rien ne disait « qui a fait quoi, quand, et sur quoi » pour les opérations
-- RÉUSSIES qui ne produisent pas d'écriture : une dispense accordée, un prêt
-- refusé, une anomalie levée, un relevé importé.
--
-- Or ce sont précisément les décisions les plus contestables en assemblée.
-- Un trésorier peut montrer le journal pour prouver un versement ; il ne
-- pouvait rien montrer pour prouver qui avait accordé une dispense.
--
-- POURQUOI UNE TABLE SÉPARÉE PLUTÔT QUE D'ÉTENDRE journal_acces. Celui-ci est
-- technique : il trace des ACCÈS, y compris refusés, et sert à l'exploitation.
-- Celui-ci est métier : il trace des DÉCISIONS réussies, et se lit en assemblée.
-- Les mêmes lignes serviraient mal les deux usages — et l'un se purge au bout
-- de quelques mois quand l'autre doit survivre au cycle.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    CREATE TYPE type_operation AS ENUM (
        'VERSEMENT_ENREGISTRE',
        'VERSEMENT_ANNULE',
        'DISPENSE_ACCORDEE',
        'CAGNOTTE_REMISE',
        'PRET_DEMANDE',
        'PRET_APPROUVE',
        'PRET_REFUSE',
        'PRET_REECHELONNE',
        'REMBOURSEMENT_ENREGISTRE',
        'AIDE_DEMANDEE',
        'AIDE_APPROUVEE',
        'AIDE_VERSEE',
        'ANOMALIE_LEVEE',
        'RELEVE_IMPORTE',
        'GROUPE_ARCHIVE',
        'MEMBRE_AJOUTE',
        'ROLE_ATTRIBUE'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS historique (
    id           UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
    groupe_id    UUID           NOT NULL REFERENCES groupe(id) ON DELETE RESTRICT,
    type         type_operation NOT NULL,

    -- L'AUTEUR EST OBLIGATOIRE. Une opération sans auteur ne prouve rien : en
    -- assemblée, « le système a accordé la dispense » ne répond à personne.
    auteur_id    UUID           NOT NULL REFERENCES membre(id) ON DELETE RESTRICT,

    -- LE LIBELLÉ EST FIGÉ À L'ÉCRITURE, en langage courant.
    --
    -- Le recomposer à la lecture le ferait varier avec les données : un membre
    -- renommé changerait l'historique du passé, ce qui ruine sa valeur
    -- probante. On stocke la phrase telle qu'elle sera lue.
    libelle      TEXT           NOT NULL CHECK (length(btrim(libelle)) > 0),

    -- Le motif, quand la décision en exige un (N-TRC-03).
    motif        TEXT,

    montant      BIGINT,
    membre_vise  UUID           REFERENCES membre(id) ON DELETE RESTRICT,

    -- Rattachements facultatifs : ils permettent de remonter à la pièce.
    ecriture_id  UUID REFERENCES ecriture(id)  ON DELETE RESTRICT,
    echeance_id  UUID REFERENCES echeance(id)  ON DELETE RESTRICT,
    pret_id      UUID REFERENCES pret(id)      ON DELETE RESTRICT,
    aide_id      UUID REFERENCES aide(id)      ON DELETE RESTRICT,
    anomalie_id  UUID REFERENCES anomalie(id)  ON DELETE RESTRICT,

    horodatage   TIMESTAMPTZ    NOT NULL DEFAULT now()
);

COMMENT ON TABLE historique IS
    'Piste d''audit MÉTIER : qui a fait quoi, quand (N-TRC-01). Distincte de '
    '`journal_acces`, qui trace les accès techniques y compris refusés. '
    'Celle-ci trace les décisions réussies, et se lit en assemblée.';
COMMENT ON COLUMN historique.libelle IS
    'Figé à l''écriture, en langage courant. Le recomposer à la lecture le '
    'ferait varier avec les données — un membre renommé réécrirait le passé.';

-- L'HISTORIQUE EST IMMUABLE, comme le journal comptable. Une piste d'audit
-- modifiable ne prouve rien : c'est le même raisonnement que R-02, appliqué
-- aux décisions plutôt qu'aux écritures.
CREATE OR REPLACE FUNCTION refuser_modification_historique()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'L''historique est immuable : % interdit. Une piste d''audit '
        'modifiable ne prouve rien.', TG_OP
        USING ERRCODE = 'check_violation';
END $$;

DROP TRIGGER IF EXISTS trg_historique_immuable ON historique;
CREATE TRIGGER trg_historique_immuable
    BEFORE UPDATE OR DELETE ON historique
    FOR EACH ROW EXECUTE FUNCTION refuser_modification_historique();

CREATE INDEX IF NOT EXISTS historique_groupe_idx
    ON historique (groupe_id, horodatage DESC);
CREATE INDEX IF NOT EXISTS historique_auteur_idx
    ON historique (auteur_id, horodatage DESC);
CREATE INDEX IF NOT EXISTS historique_type_idx
    ON historique (groupe_id, type, horodatage DESC);

-- -----------------------------------------------------------------------------
-- consigner — point d'entrée unique
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION consigner(
    p_type        type_operation,
    p_auteur_id   UUID,
    p_libelle     TEXT,
    p_motif       TEXT   DEFAULT NULL,
    p_montant     BIGINT DEFAULT NULL,
    p_membre_vise UUID   DEFAULT NULL,
    p_ecriture_id UUID   DEFAULT NULL,
    p_echeance_id UUID   DEFAULT NULL,
    p_pret_id     UUID   DEFAULT NULL,
    p_aide_id     UUID   DEFAULT NULL,
    p_anomalie_id UUID   DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_groupe_id UUID;
    v_id        UUID;
BEGIN
    SELECT m.groupe_id INTO v_groupe_id FROM membre m WHERE m.id = p_auteur_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Auteur % introuvable', p_auteur_id
            USING ERRCODE = 'no_data_found';
    END IF;

    INSERT INTO historique (groupe_id, type, auteur_id, libelle, motif,
                            montant, membre_vise, ecriture_id, echeance_id,
                            pret_id, aide_id, anomalie_id)
    VALUES (v_groupe_id, p_type, p_auteur_id, btrim(p_libelle),
            NULLIF(btrim(COALESCE(p_motif, '')), ''),
            p_montant, p_membre_vise, p_ecriture_id, p_echeance_id,
            p_pret_id, p_aide_id, p_anomalie_id)
    RETURNING id INTO v_id;

    RETURN v_id;
END $$;

COMMENT ON FUNCTION consigner IS
    'Point d''entrée UNIQUE de l''historique. Le groupe est déduit de l''auteur, '
    'jamais fourni : un appelant ne peut pas consigner une opération dans un '
    'groupe qui n''est pas le sien.';

-- -----------------------------------------------------------------------------
-- Vue de lecture — le libellé est prêt à afficher
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_historique AS
SELECT h.id,
       h.groupe_id,
       h.type,
       h.horodatage,
       h.libelle,
       h.motif,
       h.montant,
       a.nom_complet AS auteur,
       v.nom_complet AS membre_vise,
       h.ecriture_id,
       h.echeance_id,
       h.pret_id,
       h.aide_id,
       h.anomalie_id,
       -- Catégorie, pour filtrer sans connaître les dix-sept types.
       CASE
           WHEN h.type::TEXT LIKE 'VERSEMENT%'
             OR h.type = 'CAGNOTTE_REMISE'
             OR h.type = 'REMBOURSEMENT_ENREGISTRE' THEN 'Argent'
           WHEN h.type::TEXT LIKE 'PRET%'  THEN 'Prêts'
           WHEN h.type::TEXT LIKE 'AIDE%'  THEN 'Aides'
           WHEN h.type = 'ANOMALIE_LEVEE'  THEN 'Contrôle'
           WHEN h.type = 'DISPENSE_ACCORDEE' THEN 'Décisions'
           ELSE 'Gestion'
       END AS categorie
FROM historique h
JOIN membre a ON a.id = h.auteur_id
LEFT JOIN membre v ON v.id = h.membre_vise
ORDER BY h.horodatage DESC;

COMMENT ON VIEW v_historique IS
    'Historique prêt à lire. Le libellé vient tel quel de la table : il a été '
    'figé au moment de l''opération.';

GRANT SELECT, INSERT ON historique TO tontine_app;
GRANT SELECT ON v_historique TO tontine_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO tontine_app;

COMMIT;
