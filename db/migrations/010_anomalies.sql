-- =============================================================================
-- 010 — Moteur de détection d'anomalies (F-ANO-01 à F-ANO-09)
--
-- L'APPORT DIFFÉRENCIANT DE LA PLATEFORME. Voir docs/detection-anomalies.md.
--
-- TROIS PRINCIPES QUI GOUVERNENT TOUT CE FICHIER :
--
--   UNE ANOMALIE EST UN SIGNALEMENT, JAMAIS UNE ACCUSATION. Le vocabulaire des
--   descriptions le reflète : « à vérifier », jamais « fraude ». Une tontine
--   repose sur la confiance ; un outil qui désignerait un coupable détruirait
--   ce qu'il prétend protéger.
--
--   LA DÉTECTION NE BLOQUE JAMAIS UNE SAISIE (N-PRF-03). Ces fonctions sont
--   appelées en tâche de fond, jamais dans la transaction d'un versement. Un
--   trésorier qui enregistre un montant inhabituel n'est pas empêché : il est
--   peut-être dans son droit.
--
--   ELLE NE CORRIGE RIEN. Aucune fonction ici n'écrit dans le journal. Elle
--   constate un écart et le soumet à un humain — la décision reste humaine.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    CREATE TYPE type_anomalie AS ENUM (
        'COTISATION_MANQUANTE', 'REMBOURSEMENT_RETARD', 'MONTANT_INHABITUEL',
        'SOLDE_INCOHERENT', 'DOUBLE_SAISIE', 'SAISIE_TARDIVE'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE gravite_anomalie AS ENUM
        ('INFORMATION', 'AVERTISSEMENT', 'CRITIQUE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE statut_anomalie AS ENUM
        ('DETECTEE', 'EN_VERIFICATION', 'CONFIRMEE', 'LEVEE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS anomalie (
    id            UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    groupe_id     UUID             NOT NULL REFERENCES groupe(id) ON DELETE RESTRICT,
    type          type_anomalie    NOT NULL,
    gravite       gravite_anomalie NOT NULL,
    statut        statut_anomalie  NOT NULL DEFAULT 'DETECTEE',
    description   TEXT             NOT NULL CHECK (length(btrim(description)) > 0),
    donnees       JSONB            NOT NULL DEFAULT '{}'::JSONB,

    membre_id     UUID REFERENCES membre(id)   ON DELETE RESTRICT,
    echeance_id   UUID REFERENCES echeance(id) ON DELETE RESTRICT,
    ecriture_id   UUID REFERENCES ecriture(id) ON DELETE RESTRICT,
    pret_id       UUID REFERENCES pret(id)     ON DELETE RESTRICT,

    detectee_le   TIMESTAMPTZ      NOT NULL DEFAULT now(),
    verifiee_par  UUID REFERENCES membre(id) ON DELETE RESTRICT,
    levee_par     UUID REFERENCES membre(id) ON DELETE RESTRICT,
    motif_levee   TEXT,
    levee_le      TIMESTAMPTZ,

    -- F-ANO-08 — une levée exige un motif et un décideur. Sans eux, la levée
    -- serait un effacement déguisé, et la piste d'audit perdrait ce qui fait
    -- sa valeur : savoir qu'un écart a été constaté PUIS justifié.
    CONSTRAINT anomalie_levee_motivee CHECK (
        statut <> 'LEVEE'
        OR (length(btrim(motif_levee)) > 0 AND levee_par IS NOT NULL
            AND levee_le IS NOT NULL)
    )
);

COMMENT ON TABLE anomalie IS
    'Signalement d''une incohérence détectée automatiquement (F-ANO). JAMAIS une '
    'accusation. Une anomalie levée reste consignée avec son motif : elle sort '
    'du tableau de bord, jamais de la piste d''audit.';
COMMENT ON COLUMN anomalie.donnees IS
    'Seule entorse au typage strict, assumée. Chaque type d''anomalie a des '
    'attributs propres — un montant inhabituel porte médiane et écart médian, '
    'une cotisation manquante une date. Quinze colonnes nullables seraient '
    'pires. Ce champ est DESCRIPTIF et n''entre dans aucun calcul financier.';

-- NON-DUPLICATION (detection-anomalies.md §4). Sans cet index, chaque passage
-- du détecteur recréerait les mêmes signalements et noierait les nouveaux.
-- L'unicité porte sur le périmètre : type + ressource concernée, tant que
-- l'anomalie est ouverte.
CREATE UNIQUE INDEX IF NOT EXISTS anomalie_ouverte_echeance_idx
    ON anomalie (type, echeance_id)
    WHERE statut <> 'LEVEE' AND echeance_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS anomalie_ouverte_ecriture_idx
    ON anomalie (type, ecriture_id)
    WHERE statut <> 'LEVEE' AND ecriture_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS anomalie_ouverte_pret_idx
    ON anomalie (type, pret_id)
    WHERE statut <> 'LEVEE' AND pret_id IS NOT NULL;

-- Tableau de bord des anomalies ouvertes (F-TDB-04).
CREATE INDEX IF NOT EXISTS anomalie_tableau_idx
    ON anomalie (groupe_id, statut, gravite);

-- LEVEE est terminal (etats.md §4). Si l'écart réapparaît, une NOUVELLE
-- anomalie est créée : rouvrir modifierait un enregistrement d'audit clos et
-- rendrait ambiguë la lecture de l'historique.
CREATE OR REPLACE FUNCTION refuser_reouverture_anomalie()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.statut = 'LEVEE' AND NEW.statut <> 'LEVEE' THEN
        RAISE EXCEPTION
            'Une anomalie levée ne se rouvre pas (F-ANO-08). Si l''écart '
            'réapparaît, une nouvelle anomalie est créée.'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_anomalie_terminal ON anomalie;
CREATE TRIGGER trg_anomalie_terminal
    BEFORE UPDATE ON anomalie
    FOR EACH ROW EXECUTE FUNCTION refuser_reouverture_anomalie();

-- -----------------------------------------------------------------------------
-- Création d'une anomalie, sans doublon
--
-- L'index unique partiel refuserait un doublon par une erreur technique. On
-- devance : si une anomalie ouverte de même type et même périmètre existe, on
-- l'actualise au lieu d'en créer une seconde (detection-anomalies.md §4).
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION signaler_anomalie(
    p_groupe_id   UUID,
    p_type        type_anomalie,
    p_gravite     gravite_anomalie,
    p_description TEXT,
    p_donnees     JSONB   DEFAULT '{}'::JSONB,
    p_membre_id   UUID    DEFAULT NULL,
    p_echeance_id UUID    DEFAULT NULL,
    p_ecriture_id UUID    DEFAULT NULL,
    p_pret_id     UUID    DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_existante UUID;
    v_id        UUID;
BEGIN
    SELECT a.id INTO v_existante
      FROM anomalie a
     WHERE a.type = p_type
       AND a.statut <> 'LEVEE'
       AND a.echeance_id IS NOT DISTINCT FROM p_echeance_id
       AND a.ecriture_id IS NOT DISTINCT FROM p_ecriture_id
       AND a.pret_id     IS NOT DISTINCT FROM p_pret_id
       AND a.membre_id   IS NOT DISTINCT FROM p_membre_id
     LIMIT 1;

    IF v_existante IS NOT NULL THEN
        -- Actualisation sans nouvelle notification : signaler dix fois le même
        -- écart revient à ne rien signaler du tout.
        UPDATE anomalie
           SET gravite     = p_gravite,
               description = p_description,
               donnees     = p_donnees
         WHERE id = v_existante;
        RETURN v_existante;
    END IF;

    INSERT INTO anomalie (groupe_id, type, gravite, description, donnees,
                          membre_id, echeance_id, ecriture_id, pret_id)
    VALUES (p_groupe_id, p_type, p_gravite, p_description, p_donnees,
            p_membre_id, p_echeance_id, p_ecriture_id, p_pret_id)
    RETURNING id INTO v_id;

    RETURN v_id;
END $$;

-- -----------------------------------------------------------------------------
-- F-ANO-01 — Cotisation manquante
--
-- Délai de grâce : 3 jours en hebdomadaire, 7 au-delà. Sans lui, une échéance
-- serait signalée le lendemain de sa date, alors que les versements arrivent
-- souvent avec quelques jours de décalage — le signal serait du bruit.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION detecter_cotisations_manquantes(p_groupe_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_ligne   RECORD;
    v_gravite gravite_anomalie;
    v_nb      INTEGER := 0;
    v_impayes INTEGER;
    v_servi   BOOLEAN;
BEGIN
    FOR v_ligne IN
        SELECT e.id, e.membre_id, e.date_echeance, e.cycle_id,
               e.montant_attendu - e.montant_regle AS reliquat,
               (CURRENT_DATE - e.date_echeance)    AS jours_retard,
               m.nom_complet,
               r.periodicite
          FROM echeance e
          JOIN cycle  c ON c.id = e.cycle_id
          JOIN membre m ON m.id = e.membre_id
          LEFT JOIN LATERAL (
              SELECT * FROM regle_en_vigueur(c.groupe_id, e.date_echeance)
          ) r ON true
         WHERE c.groupe_id = p_groupe_id
           AND e.statut IN ('ATTENDUE', 'PARTIELLE', 'IMPAYEE')
           AND e.date_echeance < CURRENT_DATE
               - (CASE WHEN r.periodicite = 'HEBDOMADAIRE'
                       THEN INTERVAL '3 days' ELSE INTERVAL '7 days' END)
           -- UNE ÉCHÉANCE N'EST EXIGIBLE QUE SI SON TOUR A ÉTÉ APPELÉ.
           --
           -- En ROSCA, les 144 échéances du cycle sont générées d'un coup à
           -- l'ouverture (F-COT-01), tours futurs compris. Sans ce filtre, le
           -- détecteur réclamait les cotisations des tours 4 à 12 — que
           -- personne n'a encore demandées — et produisait soixante
           -- signalements pour deux impayés réels.
           --
           -- Le tour est appelé lorsqu'il est le tour courant ou qu'il est
           -- déjà remis. C'est la même règle que celle qui gouverne l'ordre de
           -- passage : on ne doit rien pour un tour qui n'est pas arrivé.
           AND (e.tour_id IS NULL
                OR EXISTS (
                    SELECT 1 FROM tour t
                     WHERE t.id = e.tour_id
                       AND (t.date_remise_reelle IS NOT NULL
                            OR t.id = tour_en_cours(e.cycle_id))))
    LOOP
        -- Le cas ROSCA aggravé : un membre qui a DÉJÀ reçu sa cagnotte et cesse
        -- de cotiser fait peser le risque sur ceux qui ne sont pas encore
        -- passés. C'est le mode de défaillance classique des tontines
        -- rotatives — d'où la gravité relevée.
        SELECT EXISTS (
            SELECT 1 FROM tour t
             WHERE t.cycle_id = v_ligne.cycle_id
               AND t.beneficiaire_id = v_ligne.membre_id
               AND t.date_remise_reelle IS NOT NULL
        ) INTO v_servi;

        SELECT count(*)::INTEGER INTO v_impayes
          FROM echeance e2
         WHERE e2.membre_id = v_ligne.membre_id
           AND e2.statut IN ('ATTENDUE', 'PARTIELLE', 'IMPAYEE')
           AND e2.date_echeance < CURRENT_DATE;

        v_gravite := CASE
            WHEN v_impayes >= 3 OR v_servi        THEN 'CRITIQUE'::gravite_anomalie
            WHEN v_ligne.jours_retard >= 30       THEN 'AVERTISSEMENT'::gravite_anomalie
            ELSE                                       'INFORMATION'::gravite_anomalie
        END;

        PERFORM signaler_anomalie(
            p_groupe_id, 'COTISATION_MANQUANTE', v_gravite,
            format('%s n''a pas versé %s F attendus le %s (%s jours de retard). À vérifier.',
                   v_ligne.nom_complet, v_ligne.reliquat,
                   to_char(v_ligne.date_echeance, 'DD/MM/YYYY'),
                   v_ligne.jours_retard),
            jsonb_build_object(
                'reliquat', v_ligne.reliquat,
                'jours_retard', v_ligne.jours_retard,
                'echeances_impayees', v_impayes,
                'deja_beneficiaire', v_servi),
            v_ligne.membre_id, v_ligne.id, NULL, NULL);

        v_nb := v_nb + 1;
    END LOOP;

    RETURN v_nb;
END $$;

COMMENT ON FUNCTION detecter_cotisations_manquantes(UUID) IS
    'F-ANO-01 — échéances dépassées au-delà du délai de grâce. Gravité relevée '
    'à CRITIQUE si le membre a déjà bénéficié de sa cagnotte : le risque pèse '
    'alors sur ceux qui ne sont pas encore passés.';

-- -----------------------------------------------------------------------------
-- F-ANO-04 — Solde incohérent. LA RÈGLE LA PLUS IMPORTANTE.
--
-- Elle vérifie que les valeurs dénormalisées coïncident avec le journal.
-- GRAVITÉ TOUJOURS CRITIQUE, sans seuil de tolérance, pas même d'un franc : en
-- partie double, un écart d'un franc n'est pas un arrondi, c'est le symptôme
-- d'un mécanisme défaillant — et il ne peut que s'aggraver.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION detecter_soldes_incoherents(p_groupe_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_ligne RECORD;
    v_nb    INTEGER := 0;
BEGIN
    -- Échéance : montant_regle contre la somme réelle des cotisations.
    FOR v_ligne IN
        SELECT e.id, e.membre_id, e.montant_regle, m.nom_complet,
               COALESCE((SELECT SUM(c.montant) FROM cotisation c
                          WHERE c.echeance_id = e.id), 0) AS reel
          FROM echeance e
          JOIN cycle  c ON c.id = e.cycle_id
          JOIN membre m ON m.id = e.membre_id
         WHERE c.groupe_id = p_groupe_id
           AND e.montant_regle <> COALESCE(
               (SELECT SUM(c2.montant) FROM cotisation c2
                 WHERE c2.echeance_id = e.id), 0)
    LOOP
        PERFORM signaler_anomalie(
            p_groupe_id, 'SOLDE_INCOHERENT', 'CRITIQUE',
            format('Le montant réglé de l''échéance de %s (%s F) ne correspond pas '
                   'à la somme des versements enregistrés (%s F). À vérifier.',
                   v_ligne.nom_complet, v_ligne.montant_regle, v_ligne.reel),
            jsonb_build_object('valeur_suivie', v_ligne.montant_regle,
                               'valeur_journal', v_ligne.reel,
                               'ecart', v_ligne.montant_regle - v_ligne.reel),
            v_ligne.membre_id, v_ligne.id, NULL, NULL);
        v_nb := v_nb + 1;
    END LOOP;

    -- Compte de cotisation : solde du journal contre la somme des cotisations
    -- imputées.
    --
    -- LA VÉRIFICATION PRÉCÉDENTE NE SUFFIT PAS. Elle compare `montant_regle` à
    -- la somme des `cotisation`, deux valeurs que le même déclencheur maintient
    -- — elles ne peuvent donc quasiment jamais diverger. Le vrai risque est
    -- ailleurs : une écriture qui crédite un compte de cotisation SANS passer
    -- par la table `cotisation`. Elle gonfle alors le journal sans trace de
    -- versement, et c'est précisément le genre d'écart qu'un registre doit
    -- révéler.
    FOR v_ligne IN
        SELECT co.membre_id, m.nom_complet,
               COALESCE(vs.solde, 0) AS solde_journal,
               COALESCE((SELECT SUM(c.montant)
                           FROM cotisation c
                           JOIN echeance e ON e.id = c.echeance_id
                          WHERE e.membre_id = co.membre_id), 0) AS somme_versements
          FROM compte co
          JOIN membre m ON m.id = co.membre_id
          LEFT JOIN v_solde_compte vs ON vs.compte_id = co.id
         WHERE co.groupe_id = p_groupe_id
           AND co.nature = 'COTISATION_MEMBRE'
           -- Le compte de cotisation est CRÉDITÉ par les versements et DÉBITÉ
           -- par la remise de cagnotte. Son solde est donc négatif du montant
           -- non encore redistribué : on compare la valeur absolue des crédits.
           AND COALESCE((SELECT SUM(l.montant) FROM ligne_ecriture l
                          WHERE l.compte_id = co.id AND l.sens = 'CREDIT'), 0)
               <> COALESCE((SELECT SUM(c.montant)
                              FROM cotisation c
                              JOIN echeance e ON e.id = c.echeance_id
                             WHERE e.membre_id = co.membre_id), 0)
    LOOP
        PERFORM signaler_anomalie(
            p_groupe_id, 'SOLDE_INCOHERENT', 'CRITIQUE',
            format('Le compte de cotisations de %s porte au journal des montants '
                   'qui ne correspondent pas aux versements enregistrés (%s F). '
                   'À vérifier.',
                   v_ligne.nom_complet, v_ligne.somme_versements),
            jsonb_build_object('somme_versements', v_ligne.somme_versements,
                               'solde_journal', v_ligne.solde_journal),
            v_ligne.membre_id, NULL, NULL, NULL);
        v_nb := v_nb + 1;
    END LOOP;

    -- Prêt : capital_restant_du contre le solde du compte CREANCE_PRET.
    FOR v_ligne IN
        SELECT p.id, p.emprunteur_id, p.capital_restant_du, m.nom_complet,
               COALESCE(vs.solde, 0) AS solde_journal
          FROM pret p
          JOIN cycle  c ON c.id = p.cycle_id
          JOIN membre m ON m.id = p.emprunteur_id
          LEFT JOIN compte co ON co.membre_id = p.emprunteur_id
                             AND co.nature    = 'CREANCE_PRET'
                             AND co.groupe_id = c.groupe_id
          LEFT JOIN v_solde_compte vs ON vs.compte_id = co.id
         WHERE c.groupe_id = p_groupe_id
           AND p.statut IN ('EN_REMBOURSEMENT', 'EN_RETARD', 'REECHELONNE')
           AND p.capital_restant_du <> COALESCE(vs.solde, 0)
    LOOP
        PERFORM signaler_anomalie(
            p_groupe_id, 'SOLDE_INCOHERENT', 'CRITIQUE',
            format('Le capital restant dû du prêt de %s (%s F) ne correspond pas '
                   'au journal (%s F). À vérifier.',
                   v_ligne.nom_complet, v_ligne.capital_restant_du,
                   v_ligne.solde_journal),
            jsonb_build_object('valeur_suivie', v_ligne.capital_restant_du,
                               'valeur_journal', v_ligne.solde_journal),
            v_ligne.emprunteur_id, NULL, NULL, v_ligne.id);
        v_nb := v_nb + 1;
    END LOOP;

    RETURN v_nb;
END $$;

COMMENT ON FUNCTION detecter_soldes_incoherents(UUID) IS
    'F-ANO-04 — compare les valeurs dénormalisées au journal. Toujours '
    'CRITIQUE : en partie double, un écart d''un franc est un symptôme, pas un '
    'arrondi.';

-- -----------------------------------------------------------------------------
-- F-ANO-05 — Double saisie probable
--
-- Deux versements du même membre, même montant, à moins de dix minutes. Une
-- référence Mobile Money identique ne laisse aucun doute : une même transaction
-- ne peut pas être encaissée deux fois. C'est le seul cas où la détection est
-- CERTAINE plutôt que probable — d'où la gravité relevée.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION detecter_doubles_saisies(p_groupe_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_ligne RECORD;
    v_nb    INTEGER := 0;
BEGIN
    FOR v_ligne IN
        SELECT c2.id AS cotisation_id, c2.ecriture_id, c2.montant,
               e.membre_id, m.nom_complet,
               (c1.reference_externe IS NOT NULL
                AND c1.reference_externe = c2.reference_externe) AS meme_reference
          FROM cotisation c1
          -- ORDRE DÉPARTAGÉ PAR L'IDENTIFIANT, PAS PAR L'HORODATAGE SEUL.
          --
          -- `cree_le` vaut `now()`, qui est FIGÉ pour toute la durée d'une
          -- transaction : deux versements saisis dans la même transaction —
          -- exactement le cas d'une double saisie par double clic — portent un
          -- horodatage rigoureusement identique. Une condition `c2.cree_le >
          -- c1.cree_le` est alors fausse dans les deux sens, et la paire la
          -- plus suspecte de toutes échappe à la détection.
          --
          -- Comparer (cree_le, id) donne un ordre total : à horodatage égal,
          -- l'identifiant départage, et chaque paire est examinée une seule
          -- fois.
          JOIN cotisation c2 ON c2.echeance_id = c1.echeance_id
                            AND c2.montant = c1.montant
                            AND (c2.cree_le, c2.id) > (c1.cree_le, c1.id)
                            AND c2.cree_le - c1.cree_le < INTERVAL '10 minutes'
          JOIN echeance e ON e.id = c2.echeance_id
          JOIN cycle   cy ON cy.id = e.cycle_id
          JOIN membre   m ON m.id = e.membre_id
         WHERE cy.groupe_id = p_groupe_id
    LOOP
        PERFORM signaler_anomalie(
            p_groupe_id, 'DOUBLE_SAISIE',
            CASE WHEN v_ligne.meme_reference THEN 'CRITIQUE'::gravite_anomalie
                 ELSE 'AVERTISSEMENT'::gravite_anomalie END,
            format('Deux versements de %s F pour %s ont été saisis à quelques '
                   'minutes d''intervalle%s. À vérifier.',
                   v_ligne.montant, v_ligne.nom_complet,
                   CASE WHEN v_ligne.meme_reference
                        THEN ', avec la même référence Mobile Money' ELSE '' END),
            jsonb_build_object('montant', v_ligne.montant,
                               'meme_reference', v_ligne.meme_reference),
            v_ligne.membre_id, NULL, v_ligne.ecriture_id, NULL);
        v_nb := v_nb + 1;
    END LOOP;

    RETURN v_nb;
END $$;

-- -----------------------------------------------------------------------------
-- F-ANO-06 — Saisie tardive ou antidatée
--
-- La saisie tardive n'est PAS fautive : un trésorier rattrape souvent son
-- retard en bloc. Elle est signalée parce qu'elle dégrade la fiabilité des
-- situations de caisse intermédiaires.
--
-- Une opération datée du FUTUR, elle, relève de l'erreur de frappe ou de la
-- manipulation — et fausse toute situation à date (F-TRX-04). D'où CRITIQUE.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION detecter_saisies_tardives(p_groupe_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_ligne RECORD;
    v_nb    INTEGER := 0;
BEGIN
    FOR v_ligne IN
        SELECT e.id, e.libelle, e.date_operation, e.cree_le,
               (e.cree_le::DATE - e.date_operation) AS jours_ecart
          FROM ecriture e
         WHERE e.groupe_id = p_groupe_id
           AND (e.date_operation > e.cree_le::DATE
                OR e.cree_le::DATE - e.date_operation >= 7)
           -- SEULES LES OPÉRATIONS RÉCENTES SONT EXAMINÉES.
           --
           -- Signaler une saisie tardive vieille de huit mois n'apporte rien :
           -- le retard est consommé, la situation intermédiaire qu'il dégradait
           -- appartient au passé, et personne n'y peut plus rien. Le signal
           -- n'a de valeur que tant qu'une correction reste possible.
           --
           -- Sans cette borne, toute reprise d'historique — un groupe qui
           -- saisit six mois de cahier papier d'un coup — produirait une
           -- anomalie par ligne et noierait les signaux utiles.
           AND e.cree_le > now() - INTERVAL '60 days'
    LOOP
        IF v_ligne.jours_ecart < 0 THEN
            PERFORM signaler_anomalie(
                p_groupe_id, 'SAISIE_TARDIVE', 'CRITIQUE',
                format('L''opération « %s » est datée du %s, soit après sa saisie. '
                       'Une date future fausse toute situation de caisse. À vérifier.',
                       v_ligne.libelle, to_char(v_ligne.date_operation, 'DD/MM/YYYY')),
                jsonb_build_object('date_operation', v_ligne.date_operation,
                                   'jours_ecart', v_ligne.jours_ecart),
                NULL, NULL, v_ligne.id, NULL);
        ELSE
            PERFORM signaler_anomalie(
                p_groupe_id, 'SAISIE_TARDIVE',
                CASE WHEN v_ligne.jours_ecart > 30
                     THEN 'AVERTISSEMENT'::gravite_anomalie
                     ELSE 'INFORMATION'::gravite_anomalie END,
                format('L''opération « %s » du %s a été enregistrée %s jours plus '
                       'tard. Sans faute, mais les situations intermédiaires en '
                       'sont affectées.',
                       v_ligne.libelle, to_char(v_ligne.date_operation, 'DD/MM/YYYY'),
                       v_ligne.jours_ecart),
                jsonb_build_object('jours_ecart', v_ligne.jours_ecart),
                NULL, NULL, v_ligne.id, NULL);
        END IF;
        v_nb := v_nb + 1;
    END LOOP;

    RETURN v_nb;
END $$;

-- -----------------------------------------------------------------------------
-- F-ANO-02 — Remboursement en retard
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION detecter_remboursements_retard(p_groupe_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_ligne RECORD;
    v_nb    INTEGER := 0;
BEGIN
    FOR v_ligne IN
        SELECT p.id AS pret_id, p.emprunteur_id, m.nom_complet,
               count(*)::INTEGER AS echeances_en_retard,
               max(CURRENT_DATE - ep.date_echeance) AS jours_retard,
               SUM(ep.montant_capital + ep.montant_interet - ep.montant_regle)
                   AS reste_du
          FROM echeance_pret ep
          JOIN pret   p ON p.id = ep.pret_id
          JOIN cycle  c ON c.id = p.cycle_id
          JOIN membre m ON m.id = p.emprunteur_id
         WHERE c.groupe_id = p_groupe_id
           AND ep.statut IN ('ATTENDUE', 'PARTIELLE', 'IMPAYEE')
           AND ep.date_echeance < CURRENT_DATE
         GROUP BY p.id, p.emprunteur_id, m.nom_complet
    LOOP
        PERFORM signaler_anomalie(
            p_groupe_id, 'REMBOURSEMENT_RETARD',
            CASE WHEN v_ligne.jours_retard >= 15 OR v_ligne.echeances_en_retard >= 2
                 THEN 'CRITIQUE'::gravite_anomalie
                 ELSE 'AVERTISSEMENT'::gravite_anomalie END,
            format('%s a %s échéance(s) de prêt en retard, %s F restant dus '
                   '(%s jours). À vérifier.',
                   v_ligne.nom_complet, v_ligne.echeances_en_retard,
                   v_ligne.reste_du, v_ligne.jours_retard),
            jsonb_build_object('echeances_en_retard', v_ligne.echeances_en_retard,
                               'jours_retard', v_ligne.jours_retard,
                               'reste_du', v_ligne.reste_du),
            v_ligne.emprunteur_id, NULL, NULL, v_ligne.pret_id);

        -- Le passage à EN_RETARD est une CONSÉQUENCE, pas une sanction : le
        -- groupe décide seul d'un rééchelonnement (F-PRE-07).
        UPDATE pret SET statut = 'EN_RETARD'
         WHERE id = v_ligne.pret_id AND statut = 'EN_REMBOURSEMENT';

        v_nb := v_nb + 1;
    END LOOP;

    RETURN v_nb;
END $$;

-- -----------------------------------------------------------------------------
-- F-ANO-03 — Montant inhabituel
--
-- MÉDIANE ET ÉCART MÉDIAN ABSOLU, PAS MOYENNE ET ÉCART-TYPE. Une moyenne est
-- tirée par les valeurs extrêmes : un seul versement exceptionnel déplacerait
-- la référence et rendrait aveugle aux suivants. Or ce sont précisément les
-- valeurs aberrantes que l'on cherche.
--
-- MINIMUM SIX VERSEMENTS. En deçà, l'historique ne décrit rien et la règle
-- produirait du bruit. Un nouveau membre ne doit pas être signalé simplement
-- parce qu'il est nouveau.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION detecter_montants_inhabituels(p_groupe_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_ligne RECORD;
    v_nb    INTEGER := 0;
BEGIN
    FOR v_ligne IN
        WITH historique AS (
            SELECT e.membre_id, c.id AS cotisation_id, c.ecriture_id, c.montant,
                   m.nom_complet
              FROM cotisation c
              JOIN echeance e  ON e.id = c.echeance_id
              JOIN cycle   cy  ON cy.id = e.cycle_id
              JOIN membre   m  ON m.id = e.membre_id
             WHERE cy.groupe_id = p_groupe_id
        ),
        reperes AS (
            SELECT membre_id,
                   count(*) AS n,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY montant) AS mediane
              FROM historique
             GROUP BY membre_id
            HAVING count(*) >= 6
        ),
        ecarts AS (
            SELECT h.membre_id,
                   percentile_cont(0.5) WITHIN GROUP (
                       ORDER BY abs(h.montant - r.mediane)) AS mad
              FROM historique h JOIN reperes r ON r.membre_id = h.membre_id
             GROUP BY h.membre_id
        )
        SELECT h.cotisation_id, h.ecriture_id, h.membre_id, h.montant,
               h.nom_complet, r.mediane, e.mad,
               abs(h.montant - r.mediane) AS ecart
          FROM historique h
          JOIN reperes r ON r.membre_id = h.membre_id
          JOIN ecarts  e ON e.membre_id = h.membre_id
         WHERE e.mad > 0
           AND abs(h.montant - r.mediane) > 3 * e.mad
    LOOP
        PERFORM signaler_anomalie(
            p_groupe_id, 'MONTANT_INHABITUEL',
            CASE WHEN v_ligne.ecart > 5 * v_ligne.mad
                 THEN 'AVERTISSEMENT'::gravite_anomalie
                 ELSE 'INFORMATION'::gravite_anomalie END,
            format('Un versement de %s F de %s s''écarte nettement de ses '
                   'versements habituels (environ %s F). À vérifier.',
                   v_ligne.montant, v_ligne.nom_complet,
                   round(v_ligne.mediane)),
            jsonb_build_object('montant', v_ligne.montant,
                               'mediane', round(v_ligne.mediane),
                               'ecart_median_absolu', round(v_ligne.mad)),
            v_ligne.membre_id, NULL, v_ligne.ecriture_id, NULL);
        v_nb := v_nb + 1;
    END LOOP;

    RETURN v_nb;
END $$;

-- -----------------------------------------------------------------------------
-- Balayage complet — appelé en tâche de fond (N-PRF-03)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION balayer_anomalies(p_groupe_id UUID)
RETURNS TABLE (
    cotisations_manquantes INTEGER,
    soldes_incoherents     INTEGER,
    doubles_saisies        INTEGER,
    saisies_tardives       INTEGER,
    remboursements_retard  INTEGER,
    montants_inhabituels   INTEGER
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY SELECT
        detecter_cotisations_manquantes(p_groupe_id),
        detecter_soldes_incoherents(p_groupe_id),
        detecter_doubles_saisies(p_groupe_id),
        detecter_saisies_tardives(p_groupe_id),
        detecter_remboursements_retard(p_groupe_id),
        detecter_montants_inhabituels(p_groupe_id);
END $$;

COMMENT ON FUNCTION balayer_anomalies(UUID) IS
    'Balayage complet, en tâche de fond (N-PRF-03). Ne bloque JAMAIS une '
    'saisie : un versement inhabituel reste enregistrable, le signalement '
    'arrive après, à qui de droit.';

-- -----------------------------------------------------------------------------
-- F-ANO-08 — Lever une anomalie
--
-- LEVER N'EST PAS EFFACER. L'anomalie sort du tableau de bord mais reste au
-- dossier avec son motif. Savoir qu'un écart a été constaté PUIS justifié vaut
-- souvent plus que l'écart lui-même.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION lever_anomalie(
    p_anomalie_id UUID,
    p_motif       TEXT,
    p_decideur_id UUID
)
RETURNS statut_anomalie
LANGUAGE plpgsql
AS $$
DECLARE
    v_gravite gravite_anomalie;
    v_statut  statut_anomalie;
BEGIN
    IF p_motif IS NULL OR length(btrim(p_motif)) = 0 THEN
        RAISE EXCEPTION
            'Une levée exige un motif (F-ANO-08, N-TRC-03) : sans lui, la levée '
            'serait un effacement déguisé.'
            USING ERRCODE = 'check_violation';
    END IF;

    SELECT gravite, statut INTO v_gravite, v_statut
      FROM anomalie WHERE id = p_anomalie_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Anomalie % introuvable', p_anomalie_id
            USING ERRCODE = 'no_data_found';
    END IF;

    IF v_statut = 'LEVEE' THEN
        RAISE EXCEPTION 'Cette anomalie est déjà levée — un état terminal n''est pas réinscriptible'
            USING ERRCODE = 'unique_violation';
    END IF;

    -- F-ANO-09 — une anomalie CRITIQUE ne peut être levée que par le
    -- commissaire aux comptes, afin qu'un écart sérieux ne soit jamais levé par
    -- la personne dont la saisie est en cause.
    IF v_gravite = 'CRITIQUE' AND NOT membre_a_role(p_decideur_id, 'COMMISSAIRE') THEN
        RAISE EXCEPTION
            'Une anomalie critique ne peut être levée que par le commissaire aux '
            'comptes (F-ANO-09)'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    UPDATE anomalie
       SET statut      = 'LEVEE',
           motif_levee = btrim(p_motif),
           levee_par   = p_decideur_id,
           levee_le    = now()
     WHERE id = p_anomalie_id
    RETURNING statut INTO v_statut;

    RETURN v_statut;
END $$;

-- -----------------------------------------------------------------------------
-- Vue du tableau de bord des anomalies (F-TDB-04)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_anomalie_ouverte AS
SELECT a.id, a.groupe_id, a.type, a.gravite, a.statut, a.description,
       a.donnees, a.detectee_le,
       a.membre_id, m.nom_complet AS membre,
       a.echeance_id, a.ecriture_id, a.pret_id
FROM anomalie a
LEFT JOIN membre m ON m.id = a.membre_id
WHERE a.statut <> 'LEVEE'
ORDER BY
    CASE a.gravite WHEN 'CRITIQUE' THEN 1
                   WHEN 'AVERTISSEMENT' THEN 2
                   ELSE 3 END,
    a.detectee_le DESC;

COMMENT ON VIEW v_anomalie_ouverte IS
    'F-TDB-04 — anomalies à vérifier, les plus graves d''abord. Les anomalies '
    'levées en sortent, sans jamais quitter la piste d''audit.';

GRANT SELECT, INSERT, UPDATE ON anomalie TO tontine_app;
GRANT SELECT ON v_anomalie_ouverte TO tontine_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO tontine_app;

COMMIT;
