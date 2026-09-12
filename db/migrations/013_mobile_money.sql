-- =============================================================================
-- 013 — Rapprochement d'un relevé Mobile Money (F-TRX-06)
--
-- CE QUE FAIT LE RAPPROCHEMENT, ET CE QU'IL NE FAIT PAS.
--
-- Il compare deux sources : les versements enregistrés dans la plateforme, et
-- les mouvements figurant sur un relevé d'opérateur. Il SIGNALE les écarts. Il
-- ne corrige rien, n'enregistre aucun versement, ne supprime aucune écriture.
--
-- POURQUOI CETTE RETENUE. Un relevé d'opérateur est une source EXTERNE, dont
-- la plateforme ne maîtrise ni le format ni la fiabilité. Importer
-- automatiquement ses lignes comme des versements reviendrait à laisser un
-- tiers écrire dans le journal du groupe. L'écart est soumis au trésorier, qui
-- saisit s'il y a lieu — la décision reste humaine, comme pour les anomalies.
--
-- DEUX ÉCARTS POSSIBLES, DE NATURES OPPOSÉES :
--   au relevé mais pas au registre  -> un versement reçu n'a pas été saisi
--   au registre mais pas au relevé  -> un versement saisi n'a pas été reçu
-- Le second est le plus grave : il signale de l'argent compté qui n'existe pas.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    CREATE TYPE statut_rapprochement AS ENUM
        ('RAPPROCHE', 'ABSENT_DU_REGISTRE', 'ABSENT_DU_RELEVE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- releve_mobile_money — l'import brut, conservé tel quel
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS releve_mobile_money (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    groupe_id    UUID        NOT NULL REFERENCES groupe(id) ON DELETE RESTRICT,
    operateur    TEXT        NOT NULL CHECK (length(btrim(operateur)) > 0),
    periode_debut DATE       NOT NULL,
    periode_fin  DATE        NOT NULL,
    importe_par  UUID        NOT NULL REFERENCES membre(id) ON DELETE RESTRICT,
    importe_le   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT releve_periode_coherente CHECK (periode_fin >= periode_debut)
);

COMMENT ON TABLE releve_mobile_money IS
    'Un import de relevé d''opérateur (F-TRX-06). Conservé pour que le '
    'rapprochement soit rejouable et vérifiable : sans la source, un écart '
    'signalé hier serait invérifiable aujourd''hui.';

CREATE INDEX IF NOT EXISTS releve_groupe_idx
    ON releve_mobile_money (groupe_id, periode_debut);

CREATE TABLE IF NOT EXISTS ligne_releve (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    releve_id     UUID        NOT NULL REFERENCES releve_mobile_money(id) ON DELETE RESTRICT,
    reference     TEXT        NOT NULL CHECK (length(btrim(reference)) > 0),
    montant       BIGINT      NOT NULL CHECK (montant > 0),
    date_operation DATE       NOT NULL,
    telephone     TEXT,
    libelle       TEXT,
    cree_le       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE ligne_releve IS
    'Une ligne du relevé, telle qu''importée. JAMAIS transformée en écriture '
    'automatiquement : un relevé est une source externe, et l''importer dans le '
    'journal reviendrait à laisser un tiers écrire dans les comptes du groupe.';

COMMENT ON COLUMN ligne_releve.reference IS
    'Référence de transaction de l''opérateur. C''est la clé du rapprochement : '
    'elle est censée être unique côté opérateur, et `cotisation.reference_externe` '
    'porte la même valeur côté registre.';

-- La même référence ne peut pas figurer deux fois dans un même relevé : ce
-- serait soit un doublon d'import, soit un relevé corrompu.
CREATE UNIQUE INDEX IF NOT EXISTS ligne_releve_reference_idx
    ON ligne_releve (releve_id, reference);

CREATE INDEX IF NOT EXISTS ligne_releve_recherche_idx
    ON ligne_releve (reference, montant);

GRANT SELECT, INSERT ON releve_mobile_money, ligne_releve TO tontine_app;

-- -----------------------------------------------------------------------------
-- rapprocher_releve — F-TRX-06
--
-- Renvoie un état, ligne à ligne, des deux côtés de la comparaison. Fonction de
-- LECTURE : elle n'écrit rien, pas même une anomalie. C'est au trésorier de
-- décider ce que chaque écart appelle.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rapprocher_releve(p_releve_id UUID)
RETURNS TABLE (
    statut           statut_rapprochement,
    reference        TEXT,
    montant_releve   BIGINT,
    montant_registre BIGINT,
    date_operation   DATE,
    membre           TEXT,
    commentaire      TEXT
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_groupe_id UUID;
    v_debut     DATE;
    v_fin       DATE;
BEGIN
    SELECT r.groupe_id, r.periode_debut, r.periode_fin
      INTO v_groupe_id, v_debut, v_fin
      FROM releve_mobile_money r WHERE r.id = p_releve_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Relevé % introuvable', p_releve_id
            USING ERRCODE = 'no_data_found';
    END IF;

    RETURN QUERY
    -- 1. Les lignes du relevé, rapprochées ou non.
    SELECT
        CASE
            WHEN c.id IS NULL THEN 'ABSENT_DU_REGISTRE'::statut_rapprochement
            ELSE 'RAPPROCHE'::statut_rapprochement
        END,
        lr.reference,
        lr.montant,
        c.montant,
        lr.date_operation,
        m.nom_complet,
        CASE
            WHEN c.id IS NULL THEN
                'Ce versement figure au relevé de l''opérateur mais n''a pas été '
                'enregistré. À vérifier auprès du trésorier.'
            WHEN c.montant <> lr.montant THEN
                'Rapproché par référence, mais les montants diffèrent.'
            ELSE NULL
        END
    FROM ligne_releve lr
    LEFT JOIN cotisation c
           ON c.reference_externe = lr.reference
    LEFT JOIN echeance e ON e.id = c.echeance_id
    LEFT JOIN membre   m ON m.id = e.membre_id
    WHERE lr.releve_id = p_releve_id

    UNION ALL

    -- 2. Les versements Mobile Money du registre absents du relevé.
    --
    -- L'ÉCART LE PLUS GRAVE DES DEUX : de l'argent compté dans la caisse dont
    -- l'opérateur n'a pas trace. Il peut s'agir d'une erreur de saisie, d'une
    -- référence mal recopiée — ou d'un versement qui n'a jamais eu lieu.
    SELECT
        'ABSENT_DU_RELEVE'::statut_rapprochement,
        COALESCE(c.reference_externe, '(aucune référence)'),
        NULL::BIGINT,
        c.montant,
        c.date_versement,
        m.nom_complet,
        'Ce versement est enregistré comme Mobile Money mais ne figure pas au '
        'relevé de la période. À vérifier.'
    FROM cotisation c
    JOIN echeance e ON e.id = c.echeance_id
    JOIN cycle   cy ON cy.id = e.cycle_id
    JOIN membre   m ON m.id = e.membre_id
    WHERE cy.groupe_id = v_groupe_id
      AND c.moyen = 'MOBILE_MONEY'
      AND c.date_versement BETWEEN v_debut AND v_fin
      AND NOT EXISTS (
          SELECT 1 FROM ligne_releve lr2
           WHERE lr2.releve_id = p_releve_id
             AND lr2.reference = c.reference_externe
      )

    ORDER BY 1, 5;
END $$;

COMMENT ON FUNCTION rapprocher_releve(UUID) IS
    'F-TRX-06 — compare relevé et registre, dans les DEUX sens. Fonction de '
    'lecture : elle signale, elle ne corrige rien. Importer automatiquement un '
    'relevé reviendrait à laisser un opérateur écrire dans le journal.';

-- Synthèse chiffrée, pour l'écran de rapprochement.
CREATE OR REPLACE FUNCTION synthese_rapprochement(p_releve_id UUID)
RETURNS TABLE (
    rapproches         INTEGER,
    absents_du_registre INTEGER,
    absents_du_releve  INTEGER,
    montant_rapproche  BIGINT,
    montant_en_ecart   BIGINT
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        count(*) FILTER (WHERE statut = 'RAPPROCHE')::INTEGER,
        count(*) FILTER (WHERE statut = 'ABSENT_DU_REGISTRE')::INTEGER,
        count(*) FILTER (WHERE statut = 'ABSENT_DU_RELEVE')::INTEGER,
        COALESCE(SUM(montant_releve) FILTER (WHERE statut = 'RAPPROCHE'), 0),
        COALESCE(SUM(COALESCE(montant_releve, montant_registre))
                 FILTER (WHERE statut <> 'RAPPROCHE'), 0)
      FROM rapprocher_releve(p_releve_id);
$$;

COMMIT;
