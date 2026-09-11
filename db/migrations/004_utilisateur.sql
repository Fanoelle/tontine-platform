-- =============================================================================
-- 004 — Utilisateurs et journal d'accès
--
-- MEMBRE ET UTILISATEUR SONT DISTINCTS (modèle §7). Tout membre n'a pas de
-- compte : dans beaucoup de groupes, seul le bureau se connecte. Et un membre
-- radié conserve son historique comptable alors que son accès est révoqué
-- (R-08). Confondre les deux forcerait à créer un identifiant à chaque
-- adhésion, et à supprimer des données financières à chaque radiation.
--
-- LE GROUPE N'EST PAS PORTÉ PAR L'UTILISATEUR. Il se déduit de `membre_id`,
-- donc du jeton (N-SEC-03). Le dupliquer ici créerait deux vérités possibles et
-- rendrait concevable un jeton dont le groupe ne correspond pas au membre.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS utilisateur (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    membre_id          UUID        NOT NULL UNIQUE REFERENCES membre(id) ON DELETE RESTRICT,
    email              TEXT        CHECK (email IS NULL OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
    telephone          TEXT        NOT NULL CHECK (telephone ~ '^\+[1-9]\d{7,14}$'),
    mot_de_passe_hash  TEXT        NOT NULL,
    actif              BOOLEAN     NOT NULL DEFAULT true,
    dernier_acces_le   TIMESTAMPTZ,
    cree_le            TIMESTAMPTZ NOT NULL DEFAULT now(),
    modifie_le         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE utilisateur IS
    'Compte de connexion, rattaché à un membre (N-SEC-01). Distinct de `membre` : '
    'tout membre n''a pas de compte, et un membre radié perd son accès sans '
    'perdre son historique (R-08).';
COMMENT ON COLUMN utilisateur.mot_de_passe_hash IS
    'bcrypt (N-SEC-01). Jamais le mot de passe en clair, jamais un hachage '
    'rapide type SHA : la lenteur de bcrypt est sa fonction, pas son défaut.';
COMMENT ON COLUMN utilisateur.telephone IS
    'Identifiant de connexion. Le téléphone et non l''e-mail : beaucoup de '
    'membres n''ont pas d''adresse électronique (F-MBR-01).';

-- Identifiant de connexion unique à l'échelle de la plateforme — contrairement
-- au téléphone de `membre`, unique seulement par groupe (R-10). Une même
-- personne appartenant à deux groupes aura donc deux comptes : c'est voulu, le
-- cloisonnement N-SEC-02 interdit une session couvrant plusieurs groupes.
CREATE UNIQUE INDEX IF NOT EXISTS utilisateur_telephone_idx
    ON utilisateur (telephone)
    WHERE actif;

DROP TRIGGER IF EXISTS trg_utilisateur_modifie_le ON utilisateur;
CREATE TRIGGER trg_utilisateur_modifie_le
    BEFORE UPDATE ON utilisateur
    FOR EACH ROW EXECUTE FUNCTION toucher_modifie_le();

-- -----------------------------------------------------------------------------
-- journal_acces — N-SEC-06
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS journal_acces (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    utilisateur_id UUID        REFERENCES utilisateur(id) ON DELETE RESTRICT,
    action         TEXT        NOT NULL,
    ressource      TEXT        NOT NULL,
    autorise       BOOLEAN     NOT NULL,
    adresse_ip     INET,
    horodatage     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE journal_acces IS
    'Journal d''audit des accès aux données financières (N-SEC-06). '
    '`utilisateur_id` est NULLABLE : une tentative de connexion échouée n''a pas '
    'd''utilisateur identifié, et c''est précisément celle qu''il faut tracer.';
COMMENT ON COLUMN journal_acces.autorise IS
    'false = tentative refusée. Une habilitation insuffisante est consignée '
    '(E2 du cas « lever une anomalie ») : le refus est une information d''audit.';

CREATE INDEX IF NOT EXISTS journal_acces_utilisateur_idx
    ON journal_acces (utilisateur_id, horodatage DESC);
CREATE INDEX IF NOT EXISTS journal_acces_refus_idx
    ON journal_acces (horodatage DESC)
    WHERE NOT autorise;

-- Vue d'authentification : rassemble ce qu'il faut pour ouvrir une session, en
-- une seule requête. Le groupe vient du membre — jamais d'ailleurs (N-SEC-03).
CREATE OR REPLACE VIEW v_authentification AS
SELECT u.id                AS utilisateur_id,
       u.telephone,
       u.mot_de_passe_hash,
       u.actif,
       m.id                AS membre_id,
       m.groupe_id,
       m.nom_complet,
       m.statut            AS statut_membre,
       m.supprime,
       g.nom               AS groupe_nom,
       g.type              AS groupe_type,
       COALESCE(
           ARRAY(SELECT mr.role::TEXT
                   FROM membre_role mr
                  WHERE mr.membre_id = m.id
                    AND mr.retire_le IS NULL
                  ORDER BY mr.role::TEXT),
           ARRAY[]::TEXT[]
       )                   AS roles
FROM utilisateur u
JOIN membre m ON m.id = u.membre_id
JOIN groupe g ON g.id = m.groupe_id;

COMMENT ON VIEW v_authentification IS
    'Tout ce que porte une session : utilisateur, membre, groupe et rôles ACTIFS '
    '(retire_le IS NULL). Un ancien trésorier ne conserve pas ses droits, mais '
    'ses écritures passées restent signées de son nom (N-TRC-01).';

GRANT SELECT, INSERT, UPDATE, DELETE ON utilisateur   TO tontine_app;
GRANT SELECT, INSERT                 ON journal_acces TO tontine_app;
GRANT SELECT ON v_authentification TO tontine_app;

-- Le journal d'audit ne se réécrit pas davantage que le journal comptable.
REVOKE UPDATE, DELETE ON journal_acces FROM tontine_app;

COMMIT;
