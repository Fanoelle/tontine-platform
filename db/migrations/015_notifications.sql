-- =============================================================================
-- 015 — Notifications (F-NOT-01 à F-NOT-06, F-COT-06, F-ANO-09)
--
-- UNE FILE D'ATTENTE, PAS UN ENVOI DIRECT. C'est le choix structurant de ce
-- fichier, et il découle de trois exigences qui, prises ensemble, interdisent
-- d'envoyer au moment où l'événement survient :
--
--   F-NOT-06 impose une plage horaire décente. Un versement saisi à 23 h ne
--   doit pas réveiller le membre : l'accusé attend le matin.
--
--   N-PRF-03 interdit de bloquer une saisie. Envoyer dans la transaction d'un
--   versement lierait la durabilité de l'écriture à la disponibilité d'un
--   service externe — et ferait échouer N-USG-04, qui impose 30 secondes.
--
--   Un envoi qui échoue doit pouvoir être rejoué. Sans file, un e-mail perdu
--   est perdu sans trace, et personne ne sait qu'un membre n'a pas été prévenu.
--
-- LA FILE EST AUSSI UNE PIÈCE D'AUDIT. Savoir qu'un trésorier a été alerté
-- d'une anomalie — et quand — fait partie de ce qui protège le groupe autant
-- que le trésorier lui-même.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    CREATE TYPE canal_notification AS ENUM ('EMAIL', 'WHATSAPP', 'SMS');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE type_notification AS ENUM (
        'RAPPEL_ECHEANCE',      -- F-NOT-01, F-COT-06
        'ACCUSE_VERSEMENT',     -- F-NOT-02
        'ALERTE_ANOMALIE',      -- F-NOT-03, F-ANO-09
        'RETARD_COTISATION',    -- F-COT-06 (après échéance)
        'REMISE_CAGNOTTE',      -- information au bénéficiaire
        'DECISION_PRET',        -- approbation ou refus
        'DECISION_AIDE'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    CREATE TYPE statut_notification AS ENUM
        ('EN_ATTENTE', 'ENVOYEE', 'ECHOUEE', 'ABANDONNEE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- notification — la file
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification (
    id             UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    groupe_id      UUID                NOT NULL REFERENCES groupe(id) ON DELETE RESTRICT,
    destinataire_id UUID               NOT NULL REFERENCES membre(id) ON DELETE RESTRICT,
    type           type_notification   NOT NULL,
    canal          canal_notification  NOT NULL,
    statut         statut_notification NOT NULL DEFAULT 'EN_ATTENTE',

    -- L'adresse est FIGÉE à la mise en file, et non relue à l'envoi. Un membre
    -- qui change de numéro entre-temps ne doit pas recevoir sur le nouveau une
    -- notification décidée pour l'ancien — et surtout, la trace doit dire où le
    -- message est réellement parti.
    adresse        TEXT                NOT NULL CHECK (length(btrim(adresse)) > 0),

    objet          TEXT                NOT NULL CHECK (length(btrim(objet)) > 0),
    corps          TEXT                NOT NULL CHECK (length(btrim(corps)) > 0),

    -- Rattachements facultatifs, pour retrouver ce qui a motivé l'envoi.
    echeance_id    UUID REFERENCES echeance(id)  ON DELETE RESTRICT,
    cotisation_id  UUID REFERENCES cotisation(id) ON DELETE RESTRICT,
    anomalie_id    UUID REFERENCES anomalie(id)  ON DELETE RESTRICT,
    pret_id        UUID REFERENCES pret(id)      ON DELETE RESTRICT,
    aide_id        UUID REFERENCES aide(id)      ON DELETE RESTRICT,

    -- F-NOT-06 — l'heure à partir de laquelle l'envoi devient acceptable.
    envoyable_a    TIMESTAMPTZ         NOT NULL DEFAULT now(),
    envoyee_le     TIMESTAMPTZ,
    tentatives     INTEGER             NOT NULL DEFAULT 0 CHECK (tentatives >= 0),
    derniere_erreur TEXT,
    cree_le        TIMESTAMPTZ         NOT NULL DEFAULT now(),

    CONSTRAINT notification_envoi_coherent CHECK (
        (statut = 'ENVOYEE' AND envoyee_le IS NOT NULL)
        OR
        (statut <> 'ENVOYEE' AND envoyee_le IS NULL)
    )
);

COMMENT ON TABLE notification IS
    'File d''attente des notifications (F-NOT). Rien n''est envoyé au moment de '
    'l''événement : F-NOT-06 impose une plage horaire décente, N-PRF-03 interdit '
    'de bloquer une saisie, et un envoi échoué doit pouvoir être rejoué.';
COMMENT ON COLUMN notification.adresse IS
    'Figée à la mise en file. La trace doit dire où le message est parti, pas où '
    'il partirait aujourd''hui.';
COMMENT ON COLUMN notification.envoyable_a IS
    'F-NOT-06 — calculé par `prochaine_heure_decente`. Une notification créée à '
    '23 h attend le matin ; une anomalie critique, elle, part immédiatement.';

CREATE INDEX IF NOT EXISTS notification_file_idx
    ON notification (statut, envoyable_a)
    WHERE statut IN ('EN_ATTENTE', 'ECHOUEE');

CREATE INDEX IF NOT EXISTS notification_destinataire_idx
    ON notification (destinataire_id, cree_le DESC);

CREATE INDEX IF NOT EXISTS notification_groupe_idx
    ON notification (groupe_id, cree_le DESC);

-- NON-DUPLICATION. Sans cet index, un balayage quotidien renverrait chaque jour
-- le même rappel pour la même échéance, et le membre cesserait de les lire —
-- exactement l'effet que la notification cherche à éviter.
CREATE UNIQUE INDEX IF NOT EXISTS notification_rappel_unique_idx
    ON notification (destinataire_id, type, echeance_id)
    WHERE echeance_id IS NOT NULL AND statut <> 'ABANDONNEE';

CREATE UNIQUE INDEX IF NOT EXISTS notification_anomalie_unique_idx
    ON notification (destinataire_id, type, anomalie_id)
    WHERE anomalie_id IS NOT NULL AND statut <> 'ABANDONNEE';

-- -----------------------------------------------------------------------------
-- F-NOT-06 — plage horaire décente
--
-- Entre 7 h et 20 h. Une notification créée hors de cette plage est reportée au
-- prochain créneau acceptable, jamais annulée : le membre doit être prévenu,
-- simplement pas à 3 h du matin.
--
-- L'URGENCE FAIT EXCEPTION. Une anomalie critique porte sur de l'argent qui a
-- peut-être déjà disparu ; attendre le matin par politesse serait un mauvais
-- arbitrage. La fonction accepte donc un drapeau d'urgence, et c'est l'appelant
-- qui en assume l'usage.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prochaine_heure_decente(
    p_maintenant TIMESTAMPTZ DEFAULT now(),
    p_urgent     BOOLEAN     DEFAULT false
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_heure INTEGER;
    v_jour  DATE;
BEGIN
    IF p_urgent THEN
        RETURN p_maintenant;
    END IF;

    v_heure := EXTRACT(HOUR FROM p_maintenant);
    v_jour  := p_maintenant::DATE;

    IF v_heure < 7 THEN
        -- Trop tôt : on attend 7 h le jour même.
        RETURN (v_jour + TIME '07:00')::TIMESTAMPTZ;
    ELSIF v_heure >= 20 THEN
        -- Trop tard : on attend 7 h le lendemain.
        RETURN (v_jour + INTERVAL '1 day' + TIME '07:00')::TIMESTAMPTZ;
    END IF;

    RETURN p_maintenant;
END $$;

COMMENT ON FUNCTION prochaine_heure_decente(TIMESTAMPTZ, BOOLEAN) IS
    'F-NOT-06 — reporte un envoi hors de la plage 7 h – 20 h. Jamais annulé, '
    'seulement différé : le membre doit être prévenu, pas réveillé. Une anomalie '
    'critique fait exception — attendre le matin par politesse serait un mauvais '
    'arbitrage sur de l''argent peut-être déjà disparu.';

-- -----------------------------------------------------------------------------
-- Canal et adresse d'un destinataire
--
-- LE TÉLÉPHONE EST L'IDENTIFIANT NATUREL (F-MBR-01) : beaucoup de membres n'ont
-- pas d'adresse électronique. On privilégie donc WhatsApp quand seul le
-- téléphone est connu, et l'e-mail sinon — un e-mail étant moins intrusif et
-- sans coût pour le destinataire.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION canal_du_membre(p_membre_id UUID)
RETURNS TABLE (canal canal_notification, adresse TEXT)
LANGUAGE sql
STABLE
AS $$
    SELECT CASE
               WHEN m.email IS NOT NULL AND length(btrim(m.email)) > 0
                   THEN 'EMAIL'::canal_notification
               ELSE 'WHATSAPP'::canal_notification
           END,
           COALESCE(NULLIF(btrim(m.email), ''), m.telephone)
      FROM membre m
     WHERE m.id = p_membre_id;
$$;

-- -----------------------------------------------------------------------------
-- mettre_en_file — point d'entrée unique
--
-- Toutes les notifications passent par ici. Un point d'entrée unique garantit
-- que la plage horaire et la déduplication s'appliquent SANS EXCEPTION : un
-- INSERT direct dans la table les contournerait, et c'est précisément le genre
-- d'oubli qui produit un rappel à 3 h du matin.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION mettre_en_file(
    p_destinataire_id UUID,
    p_type            type_notification,
    p_objet           TEXT,
    p_corps           TEXT,
    p_urgent          BOOLEAN DEFAULT false,
    p_echeance_id     UUID DEFAULT NULL,
    p_cotisation_id   UUID DEFAULT NULL,
    p_anomalie_id     UUID DEFAULT NULL,
    p_pret_id         UUID DEFAULT NULL,
    p_aide_id         UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_groupe_id UUID;
    v_canal     canal_notification;
    v_adresse   TEXT;
    v_statut    statut_membre;
    v_id        UUID;
BEGIN
    SELECT m.groupe_id, m.statut INTO v_groupe_id, v_statut
      FROM membre m WHERE m.id = p_destinataire_id AND NOT m.supprime;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Destinataire % introuvable', p_destinataire_id
            USING ERRCODE = 'no_data_found';
    END IF;

    -- Un membre radié ne reçoit plus rien. Son historique comptable demeure
    -- (R-08), mais lui écrire après son départ serait au mieux inutile, au pire
    -- une intrusion.
    IF v_statut = 'RADIE' THEN
        RETURN NULL;
    END IF;

    SELECT c.canal, c.adresse INTO v_canal, v_adresse
      FROM canal_du_membre(p_destinataire_id) c;

    INSERT INTO notification (groupe_id, destinataire_id, type, canal, adresse,
                              objet, corps, envoyable_a,
                              echeance_id, cotisation_id, anomalie_id,
                              pret_id, aide_id)
    VALUES (v_groupe_id, p_destinataire_id, p_type, v_canal, v_adresse,
            p_objet, p_corps,
            prochaine_heure_decente(now(), p_urgent),
            p_echeance_id, p_cotisation_id, p_anomalie_id,
            p_pret_id, p_aide_id)
    -- Le doublon n'est pas une erreur : c'est le comportement normal d'un
    -- balayage quotidien qui repasse sur la même échéance.
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_id;

    RETURN v_id;
END $$;

COMMENT ON FUNCTION mettre_en_file IS
    'Point d''entrée UNIQUE des notifications. Applique la plage horaire '
    '(F-NOT-06) et la déduplication sans exception possible — un INSERT direct '
    'dans la table les contournerait.';

-- -----------------------------------------------------------------------------
-- F-NOT-01, F-COT-06 — rappels avant et après échéance
--
-- LE VOCABULAIRE EST CELUI DU MEMBRE, jamais celui de la comptabilité
-- (N-USG-05). On écrit « il vous reste 15 000 F à verser », pas « échéance
-- partiellement réglée ». Et le mot « payer » n'apparaît nulle part : la
-- plateforme n'encaisse rien.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION preparer_rappels(
    p_groupe_id UUID,
    p_jours_avant INTEGER DEFAULT 3
)
RETURNS TABLE (rappels_avant INTEGER, rappels_retard INTEGER)
LANGUAGE plpgsql
AS $$
DECLARE
    v_ligne  RECORD;
    v_avant  INTEGER := 0;
    v_retard INTEGER := 0;
    v_devise CHAR(3);
    v_nom    TEXT;
BEGIN
    SELECT g.devise, g.nom INTO v_devise, v_nom
      FROM groupe g WHERE g.id = p_groupe_id;

    -- Rappel AVANT échéance (F-NOT-01).
    FOR v_ligne IN
        SELECT e.id, e.membre_id, e.date_echeance,
               e.montant_attendu - e.montant_regle AS reste,
               m.nom_complet
          FROM echeance e
          JOIN cycle  c ON c.id = e.cycle_id
          JOIN membre m ON m.id = e.membre_id
         WHERE c.groupe_id = p_groupe_id
           AND e.statut IN ('ATTENDUE', 'PARTIELLE')
           AND e.date_echeance BETWEEN CURRENT_DATE
                                   AND CURRENT_DATE + p_jours_avant
           AND m.statut = 'ACTIF'
           -- Une échéance de tour non encore appelé n'est pas exigible : la
           -- rappeler serait réclamer ce que personne ne doit encore.
           AND (e.tour_id IS NULL
                OR EXISTS (SELECT 1 FROM tour t
                            WHERE t.id = e.tour_id
                              AND (t.date_remise_reelle IS NOT NULL
                                   OR t.id = tour_en_cours(e.cycle_id))))
    LOOP
        IF mettre_en_file(
            v_ligne.membre_id, 'RAPPEL_ECHEANCE',
            format('%s — cotisation du %s', v_nom,
                   to_char(v_ligne.date_echeance, 'DD/MM')),
            format('Bonjour %s,'
                   || E'\n\n'
                   || 'Votre cotisation de %s %s est attendue le %s.'
                   || E'\n\n'
                   || 'Vous pouvez la remettre au trésorier en espèces ou par '
                   || 'Mobile Money, comme d''habitude.'
                   || E'\n\n'
                   || '%s',
                   v_ligne.nom_complet, v_ligne.reste, v_devise,
                   to_char(v_ligne.date_echeance, 'DD/MM/YYYY'), v_nom),
            false, v_ligne.id) IS NOT NULL
        THEN
            v_avant := v_avant + 1;
        END IF;
    END LOOP;

    -- Rappel APRÈS échéance (F-COT-06). Le ton reste neutre : un retard
    -- s'explique souvent, et un rappel accusateur abîmerait la confiance que la
    -- plateforme existe pour restaurer.
    FOR v_ligne IN
        SELECT e.id, e.membre_id, e.date_echeance,
               e.montant_attendu - e.montant_regle AS reste,
               (CURRENT_DATE - e.date_echeance) AS jours,
               m.nom_complet
          FROM echeance e
          JOIN cycle  c ON c.id = e.cycle_id
          JOIN membre m ON m.id = e.membre_id
         WHERE c.groupe_id = p_groupe_id
           AND e.statut IN ('ATTENDUE', 'PARTIELLE', 'IMPAYEE')
           -- Sept jours de grâce RÉVOLUS, borne incluse. Le seuil reprend celui
           -- du détecteur de cotisations manquantes (F-ANO-01) : rappeler plus
           -- tôt que le moment où l'on signale un impayé serait incohérent, et
           -- rappeler plus tard laisserait le membre sans nouvelle une semaine
           -- de plus.
           AND e.date_echeance <= CURRENT_DATE - 7
           AND m.statut = 'ACTIF'
           AND (e.tour_id IS NULL
                OR EXISTS (SELECT 1 FROM tour t
                            WHERE t.id = e.tour_id
                              AND (t.date_remise_reelle IS NOT NULL
                                   OR t.id = tour_en_cours(e.cycle_id))))
    LOOP
        IF mettre_en_file(
            v_ligne.membre_id, 'RETARD_COTISATION',
            format('%s — cotisation en attente', v_nom),
            format('Bonjour %s,'
                   || E'\n\n'
                   || 'Il reste %s %s à verser sur votre cotisation du %s.'
                   || E'\n\n'
                   || 'Si vous l''avez déjà remise, signalez-le au trésorier : '
                   || 'elle n''a peut-être pas encore été enregistrée.'
                   || E'\n\n'
                   || '%s',
                   v_ligne.nom_complet, v_ligne.reste, v_devise,
                   to_char(v_ligne.date_echeance, 'DD/MM/YYYY'), v_nom),
            false, v_ligne.id) IS NOT NULL
        THEN
            v_retard := v_retard + 1;
        END IF;
    END LOOP;

    RETURN QUERY SELECT v_avant, v_retard;
END $$;

COMMENT ON FUNCTION preparer_rappels(UUID, INTEGER) IS
    'F-NOT-01, F-COT-06 — met en file les rappels avant et après échéance. Le '
    'ton reste neutre : un retard s''explique souvent, et un rappel accusateur '
    'abîmerait la confiance que la plateforme existe pour restaurer.';

-- -----------------------------------------------------------------------------
-- F-NOT-03, F-ANO-09 — alerte d'anomalie
--
-- LE COMMISSAIRE EST TOUJOURS INFORMÉ DES ANOMALIES CRITIQUES. Ce n'est pas une
-- présomption de mauvaise foi envers le trésorier : c'est le principe du
-- contrôle mutuel, qui le protège aussi en attestant qu'il n'a rien dissimulé.
-- Un signalement qui ne transiterait que par celui dont il questionne la saisie
-- ne serait pas un signalement.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION alerter_anomalies(p_groupe_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_ano     RECORD;
    v_dest    RECORD;
    v_nom     TEXT;
    v_nb      INTEGER := 0;
BEGIN
    SELECT g.nom INTO v_nom FROM groupe g WHERE g.id = p_groupe_id;

    FOR v_ano IN
        SELECT a.id, a.gravite, a.description, a.type
          FROM v_anomalie_ouverte a
         WHERE a.groupe_id = p_groupe_id
    LOOP
        FOR v_dest IN
            SELECT m.id, m.nom_complet
              FROM membre m
             WHERE m.groupe_id = p_groupe_id
               AND m.statut = 'ACTIF'
               AND (
                   -- Le trésorier est informé de tout : c'est sa saisie.
                   membre_a_role(m.id, 'TRESORIER')
                   -- Le commissaire, des seules anomalies critiques (F-ANO-09).
                   -- L'alerter de tout reviendrait à ne l'alerter de rien.
                   OR (v_ano.gravite = 'CRITIQUE'
                       AND membre_a_role(m.id, 'COMMISSAIRE'))
               )
        LOOP
            IF mettre_en_file(
                v_dest.id, 'ALERTE_ANOMALIE',
                format('%s — un point à vérifier', v_nom),
                format('Bonjour %s,'
                       || E'\n\n'
                       || '%s'
                       || E'\n\n'
                       || 'Il ne s''agit pas d''une accusation : la plupart de ces '
                       || 'écarts s''expliquent simplement. Consultez l''application '
                       || 'pour le vérifier et, le cas échéant, le justifier.'
                       || E'\n\n'
                       || '%s',
                       v_dest.nom_complet, v_ano.description, v_nom),
                -- Une anomalie critique porte sur de l'argent peut-être déjà
                -- disparu : elle ne dort pas jusqu'au matin.
                v_ano.gravite = 'CRITIQUE',
                NULL, NULL, v_ano.id) IS NOT NULL
            THEN
                v_nb := v_nb + 1;
            END IF;
        END LOOP;
    END LOOP;

    RETURN v_nb;
END $$;

COMMENT ON FUNCTION alerter_anomalies(UUID) IS
    'F-NOT-03, F-ANO-09 — alerte le trésorier de toute anomalie, et le '
    'commissaire des seules critiques. Un signalement qui ne transiterait que '
    'par celui dont il questionne la saisie ne serait pas un signalement.';

-- -----------------------------------------------------------------------------
-- F-NOT-02 — accusé de réception d'un versement
--
-- Appelé après l'enregistrement, jamais pendant : la notification sort de la
-- transaction (séquences §1). Envoyer dedans lierait la durabilité de
-- l'écriture à la disponibilité d'un service externe.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION accuser_versement(p_cotisation_id UUID)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_ligne  RECORD;
    v_devise CHAR(3);
    v_nom    TEXT;
BEGIN
    SELECT c.montant, c.date_versement, e.membre_id, m.nom_complet,
           e.montant_attendu - e.montant_regle AS reste,
           g.devise, g.nom AS groupe_nom
      INTO v_ligne
      FROM cotisation c
      JOIN echeance e  ON e.id = c.echeance_id
      JOIN cycle   cy  ON cy.id = e.cycle_id
      JOIN groupe   g  ON g.id = cy.groupe_id
      JOIN membre   m  ON m.id = e.membre_id
     WHERE c.id = p_cotisation_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Versement % introuvable', p_cotisation_id
            USING ERRCODE = 'no_data_found';
    END IF;

    RETURN mettre_en_file(
        v_ligne.membre_id, 'ACCUSE_VERSEMENT',
        format('%s — versement enregistré', v_ligne.groupe_nom),
        format('Bonjour %s,'
               || E'\n\n'
               || 'Votre versement de %s %s du %s a bien été enregistré.'
               || E'\n\n'
               || '%s'
               || E'\n\n'
               || '%s',
               v_ligne.nom_complet, v_ligne.montant, v_ligne.devise,
               to_char(v_ligne.date_versement, 'DD/MM/YYYY'),
               CASE WHEN v_ligne.reste > 0
                    THEN format('Il reste %s %s à verser sur cette échéance.',
                                v_ligne.reste, v_ligne.devise)
                    ELSE 'Vous êtes à jour pour cette échéance.'
               END,
               v_ligne.groupe_nom),
        false, NULL, p_cotisation_id);
END $$;

-- -----------------------------------------------------------------------------
-- La file, prête à l'envoi
--
-- Une notification est prête si son heure est venue et si ses tentatives n'ont
-- pas épuisé la patience. CINQ TENTATIVES, puis abandon : réessayer sans fin un
-- envoi vers une adresse erronée encombrerait la file et masquerait les envois
-- réellement en attente.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_notification_a_envoyer AS
SELECT n.id, n.groupe_id, n.destinataire_id, n.type, n.canal, n.adresse,
       n.objet, n.corps, n.envoyable_a, n.tentatives, n.derniere_erreur,
       m.nom_complet AS destinataire
FROM notification n
JOIN membre m ON m.id = n.destinataire_id
WHERE n.statut IN ('EN_ATTENTE', 'ECHOUEE')
  AND n.envoyable_a <= now()
  AND n.tentatives < 5
ORDER BY
    -- Les alertes d'anomalie passent devant : elles portent sur de l'argent.
    CASE n.type WHEN 'ALERTE_ANOMALIE' THEN 1 ELSE 2 END,
    n.envoyable_a;

COMMENT ON VIEW v_notification_a_envoyer IS
    'File prête à l''envoi. Cinq tentatives puis abandon : réessayer sans fin '
    'vers une adresse erronée masquerait les envois réellement en attente.';

CREATE OR REPLACE FUNCTION marquer_envoyee(p_notification_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE notification
       SET statut = 'ENVOYEE', envoyee_le = now(),
           tentatives = tentatives + 1, derniere_erreur = NULL
     WHERE id = p_notification_id;
    RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION marquer_echouee(
    p_notification_id UUID,
    p_erreur          TEXT
)
RETURNS statut_notification
LANGUAGE plpgsql
AS $$
DECLARE
    v_statut statut_notification;
BEGIN
    UPDATE notification
       SET tentatives = tentatives + 1,
           derniere_erreur = left(COALESCE(p_erreur, 'erreur inconnue'), 500),
           -- L'abandon après cinq échecs est consigné, pas silencieux : savoir
           -- qu'un membre n'a JAMAIS pu être prévenu est une information.
           statut = CASE WHEN tentatives + 1 >= 5
                         THEN 'ABANDONNEE'::statut_notification
                         ELSE 'ECHOUEE'::statut_notification END,
           -- Report progressif : 5 min, puis 10, puis 20…
           envoyable_a = now() + (INTERVAL '5 minutes' * power(2, tentatives))
     WHERE id = p_notification_id
    RETURNING statut INTO v_statut;

    RETURN v_statut;
END $$;

GRANT SELECT, INSERT, UPDATE ON notification TO tontine_app;
GRANT SELECT ON v_notification_a_envoyer TO tontine_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO tontine_app;

COMMIT;
