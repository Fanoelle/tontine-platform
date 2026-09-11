-- =============================================================================
-- Comptes de connexion du jeu de démonstration
--
-- Trois comptes seulement, pour les trois membres du bureau. C'est fidèle à la
-- réalité : dans la plupart des groupes, les membres ordinaires ne se connectent
-- pas — ils consultent leur relevé par l'intermédiaire du trésorier ou reçoivent
-- un rappel par téléphone. `utilisateur` est distinct de `membre` précisément
-- pour permettre cela (modèle §7).
--
-- MOT DE PASSE COMMUN : « tontine2026 »
-- Hachage bcrypt coût 12, identique pour les trois — acceptable pour un jeu de
-- démonstration, inadmissible ailleurs.
--
-- RÉ-EXÉCUTABLE : les comptes sont recréés à chaque passage.
-- =============================================================================

BEGIN;

DO $$
DECLARE
    v_groupe UUID;
    -- Hachage bcrypt de « tontine2026 », coût 12, VÉRIFIÉ par comparaison
    -- avant d'être inscrit ici. Un hachage recopié sans être éprouvé produit
    -- des comptes qui existent en base mais dont personne ne peut se servir.
    v_hash   TEXT := '$2b$12$bd0aQLSwtB9YjHpTTOjqOOY7.cwZ8nk1bUBczf0Q2KBjrS2fg7ur6';
    v_membre UUID;
BEGIN
    SELECT id INTO v_groupe FROM groupe WHERE nom = 'Tontine des Femmes de Bonabéri';

    IF v_groupe IS NULL THEN
        RAISE NOTICE 'Jeu de démonstration absent — exécutez d''abord 001_demonstration.sql';
        RETURN;
    END IF;

    DELETE FROM journal_acces WHERE utilisateur_id IN (
        SELECT u.id FROM utilisateur u
          JOIN membre m ON m.id = u.membre_id
         WHERE m.groupe_id = v_groupe);

    DELETE FROM utilisateur WHERE membre_id IN (
        SELECT id FROM membre WHERE groupe_id = v_groupe);

    -- Awa Ndiaye — présidente
    SELECT id INTO v_membre FROM membre
     WHERE groupe_id = v_groupe AND nom_complet = 'Awa Ndiaye';
    INSERT INTO utilisateur (membre_id, telephone, mot_de_passe_hash)
    VALUES (v_membre, '+237690110001', v_hash);

    -- Marie Ebolo — trésorière. C'est elle qui saisit les versements.
    SELECT id INTO v_membre FROM membre
     WHERE groupe_id = v_groupe AND nom_complet = 'Marie Ebolo';
    INSERT INTO utilisateur (membre_id, telephone, mot_de_passe_hash)
    VALUES (v_membre, '+237690110002', v_hash);

    -- Fatou Bâ — commissaire aux comptes
    SELECT id INTO v_membre FROM membre
     WHERE groupe_id = v_groupe AND nom_complet = 'Fatou Bâ';
    INSERT INTO utilisateur (membre_id, telephone, mot_de_passe_hash)
    VALUES (v_membre, '+237690110003', v_hash);

    RAISE NOTICE '3 comptes créés (présidente, trésorière, commissaire) — mot de passe : tontine2026';
END $$;

COMMIT;
