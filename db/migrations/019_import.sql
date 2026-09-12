-- =====================================================================
-- 019 — IMPORT D'UN CAHIER EXISTANT
--
-- LE PROBLÈME. Un groupe qui tient son cahier depuis deux ans ne va pas
-- ressaisir vingt-quatre mois d'historique pour essayer la plateforme. Sans
-- import, l'adoption suppose soit de repartir de zéro — en perdant la mémoire
-- du groupe, qui est précisément ce qui fonde la confiance — soit une saisie
-- manuelle si longue que personne ne la fera.
--
-- LE PRINCIPE DIRECTEUR : L'IMPORT NE CONTOURNE RIEN.
--
-- Il aurait été plus simple d'insérer directement dans `ligne_ecriture` les
-- soldes finaux. C'eût été une faute. Le journal en partie double tient sa
-- valeur de ce qu'AUCUN chemin ne permet d'y écrire sans équilibre (R-01) ni
-- d'y revenir ensuite (R-02). Une porte d'import qui écrirait directement
-- rendrait ces garanties conditionnelles à la bonne foi de celui qui importe —
-- et un contrôleur ne pourrait plus dire « le journal est juste », seulement
-- « le journal est juste sauf pour ce qui a été importé ».
--
-- L'import rejoue donc les versements par `enregistrer_versement()`, la même
-- fonction qu'utilise le trésorier au quotidien. Un cahier importé produit
-- exactement les écritures qu'aurait produites une saisie au fil de l'eau.
--
-- CE QUI EST IMPORTÉ, ET CE QUI NE L'EST PAS. Les membres, le cycle, l'ordre
-- de passage, les cotisations versées et les remises de cagnotte : c'est ce
-- qu'un cahier contient. Ni prêts, ni aides, ni anomalies — un cahier papier
-- ne les porte pas sous une forme exploitable, et les inventer serait pire
-- que de les omettre.
--
-- TOUT OU RIEN. Une ligne refusée annule l'import entier. Un import
-- partiellement appliqué laisserait un groupe dans un état que personne ne
-- saurait décrire : ni l'ancien cahier, ni le nouveau. L'exploitant corrige
-- son fichier et recommence.
-- =====================================================================

-- Un import est une opération du groupe comme une autre, et doit apparaître
-- dans l'historique consultable (N-TRC-01). L'omettre créerait un trou dans la
-- traçabilité exactement là où elle compte le plus : l'arrivée en masse de
-- données dont personne n'a vu la saisie.
ALTER TYPE type_operation ADD VALUE IF NOT EXISTS 'CAHIER_IMPORTE';

-- ---------------------------------------------------------------------
-- Trace des imports.
--
-- POURQUOI GARDER UNE TRACE D'UN IMPORT RÉUSSI. Parce qu'un an plus tard,
-- devant un solde contesté, la question « d'où vient cette écriture ? » doit
-- avoir une réponse. Une cotisation saisie par la trésorière et une cotisation
-- reprise d'un cahier papier n'ont pas la même force probante, et celui qui
-- vérifie doit pouvoir les distinguer.
-- ---------------------------------------------------------------------
CREATE TABLE import (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  groupe_id       UUID NOT NULL REFERENCES groupe(id) ON DELETE RESTRICT,
  importe_par     UUID NOT NULL REFERENCES membre(id) ON DELETE RESTRICT,
  source          TEXT NOT NULL,
  membres_crees   INTEGER NOT NULL DEFAULT 0,
  tours_crees     INTEGER NOT NULL DEFAULT 0,
  versements_crees INTEGER NOT NULL DEFAULT 0,
  montant_total   BIGINT NOT NULL DEFAULT 0,
  -- L'empreinte du fichier source. Deux imports du même fichier donnent la
  -- même empreinte : c'est ce qui permet de répondre « ce cahier a déjà été
  -- importé le 3 mars » plutôt que de le charger une seconde fois.
  empreinte       TEXT NOT NULL,
  cree_le         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT import_source_check CHECK (length(btrim(source)) > 0)
);

CREATE INDEX import_groupe_idx ON import (groupe_id, cree_le DESC);
CREATE INDEX import_importe_par_idx ON import (importe_par);

-- Un même fichier ne s'importe pas deux fois dans le même groupe. Sans cette
-- contrainte, un double clic sur « Importer » doublerait tout l'historique —
-- et le déséquilibre ne se verrait qu'au moment où quelqu'un rapprocherait les
-- soldes du cahier papier.
CREATE UNIQUE INDEX import_empreinte_unique_idx ON import (groupe_id, empreinte);

COMMENT ON TABLE import IS
  'Trace des reprises de cahier. Permet de distinguer une écriture saisie au '
  'fil de l''eau d''une écriture reprise d''un cahier papier.';

REVOKE UPDATE, DELETE ON import FROM PUBLIC;
GRANT SELECT, INSERT ON import TO tontine_app;

-- ---------------------------------------------------------------------
-- Type composite décrivant une ligne de cahier.
--
-- Le client compose un tableau de ces lignes ; la fonction d'import le traite
-- en une transaction. Passer par un type plutôt que par du JSON donne au
-- moteur la vérification des types : une date mal formée est refusée à la
-- frontière, pas au milieu du traitement.
-- ---------------------------------------------------------------------
-- DEUX RANGS DISTINCTS, ET LES CONFONDRE A COÛTÉ UN ESSAI RATÉ.
--
-- `rang_beneficiaire` dit QUAND CE MEMBRE TOUCHE la cagnotte : c'est une
-- propriété de la personne, constante sur tout le cycle, négociée à l'avance.
--
-- `tour_verse` dit À QUEL TOUR SE RATTACHE CE VERSEMENT : c'est une propriété
-- de la ligne, qui change à chaque échéance.
--
-- Le premier jet n'avait qu'un champ `rang_tour` pour les deux. Une membre
-- passant en troisième position et versant au deuxième tour produisait une
-- ligne contradictoire : l'import cherchait son échéance du tour 3, ne la
-- trouvait pas ouverte, et refusait un cahier pourtant juste.
CREATE TYPE ligne_cahier AS (
  membre_nom        TEXT,
  membre_telephone  TEXT,
  membre_email      TEXT,
  rang_beneficiaire INTEGER,
  tour_verse        INTEGER,
  date_operation    DATE,
  montant           BIGINT,
  moyen             moyen_paiement
);

-- ---------------------------------------------------------------------
-- IMPORTER_CAHIER — la fonction principale.
--
-- ELLE EST DÉLIBÉRÉMENT LONGUE ET LINÉAIRE. Un import se lit comme un
-- procès-verbal : d'abord qui, puis dans quel ordre, puis qui a versé quoi et
-- quand. Découper en sous-fonctions disperserait cette lecture sans rien
-- simplifier, chaque étape dépendant des identifiants créés par la précédente.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION importer_cahier(
  p_groupe_id       UUID,
  p_importe_par     UUID,
  p_source          TEXT,
  p_empreinte       TEXT,
  p_montant_cotisation BIGINT,
  p_periodicite     periodicite,
  p_date_debut      DATE,
  p_lignes          ligne_cahier[]
) RETURNS TABLE (
  import_id        UUID,
  membres_crees    INTEGER,
  tours_crees      INTEGER,
  versements_crees INTEGER,
  montant_total    BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_import_id      UUID;
  v_cycle_id       UUID;
  v_numero_cycle   INTEGER;
  v_ligne          ligne_cahier;
  v_membre_id      UUID;
  v_tour_id        UUID;
  v_echeance_id    UUID;
  v_membres        INTEGER := 0;
  v_tours          INTEGER := 0;
  v_versements     INTEGER := 0;
  v_total          BIGINT := 0;
  v_type_groupe    type_groupe;
  v_intervalle     INTERVAL;
  v_date_tour      DATE;
  v_rang           INTEGER;
  v_nb_membres     INTEGER;
BEGIN
  -- --- Vérifications préalables -------------------------------------
  -- Elles viennent toutes AVANT la moindre insertion. Un import qui échoue
  -- doit échouer avant d'avoir rien touché, même si la transaction protège
  -- déjà : un message d'erreur clair vaut mieux qu'un rollback muet.

  SELECT type INTO v_type_groupe FROM groupe WHERE id = p_groupe_id;

  IF v_type_groupe IS NULL THEN
    RAISE EXCEPTION 'Groupe % introuvable', p_groupe_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- SEUL LE ROSCA EST IMPORTABLE, et c'est assumé. Un cahier d'ASCA porte des
  -- prêts avec échéanciers et intérêts ; une mutuelle porte des demandes
  -- d'aide et leurs délibérations. Ni l'un ni l'autre ne se réduit à la forme
  -- « qui a versé combien, quand » d'un cahier de tontine. Prétendre les
  -- importer produirait des groupes amputés dont personne ne verrait ce qui
  -- manque.
  IF v_type_groupe <> 'ROSCA' THEN
    RAISE EXCEPTION
      'L''import ne couvre que les ROSCA — ce groupe est de type %. '
      'Un cahier d''ASCA ou de mutuelle porte des prêts ou des aides qu''un '
      'cahier de tontine ne contient pas.', v_type_groupe
      USING ERRCODE = 'feature_not_supported';
  END IF;

  IF NOT membre_a_role(p_importe_par, 'PRESIDENT')
     AND NOT membre_a_role(p_importe_par, 'TRESORIER') THEN
    RAISE EXCEPTION
      'Seuls le président et le trésorier peuvent importer un cahier'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF array_length(p_lignes, 1) IS NULL THEN
    RAISE EXCEPTION 'Le cahier est vide — rien à importer'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_montant_cotisation <= 0 THEN
    RAISE EXCEPTION 'Le montant de cotisation doit être positif (reçu : %)',
      p_montant_cotisation
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- UN GROUPE AYANT DÉJÀ UN CYCLE N'EST PAS IMPORTABLE. L'import reconstitue
  -- un passé ; l'ajouter à un présent déjà saisi mélangerait deux sources sans
  -- qu'on puisse ensuite les démêler.
  IF EXISTS (SELECT 1 FROM cycle WHERE groupe_id = p_groupe_id) THEN
    RAISE EXCEPTION
      'Ce groupe porte déjà un cycle — l''import est réservé à un groupe '
      'neuf. Créez un groupe vide pour reprendre un cahier.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- --- Règle du groupe ----------------------------------------------
  -- Posée seulement si le groupe n'en a pas : un exploitant qui a déjà
  -- renseigné le montant ne doit pas le voir écrasé par le fichier.
  IF NOT EXISTS (SELECT 1 FROM regle_groupe WHERE groupe_id = p_groupe_id) THEN
    INSERT INTO regle_groupe (groupe_id, montant_cotisation, periodicite,
                              date_effet)
    VALUES (p_groupe_id, p_montant_cotisation, p_periodicite, p_date_debut);
  END IF;

  -- --- Membres -------------------------------------------------------
  -- On crée d'abord TOUS les membres, avant tout versement : une ligne du
  -- cahier peut citer un membre qui n'apparaît qu'au vingtième rang.
  FOR v_ligne IN SELECT * FROM unnest(p_lignes) LOOP
    CONTINUE WHEN v_ligne.membre_telephone IS NULL;

    SELECT id INTO v_membre_id
      FROM membre
     WHERE groupe_id = p_groupe_id
       AND telephone = v_ligne.membre_telephone
       AND NOT supprime;

    IF v_membre_id IS NULL THEN
      INSERT INTO membre (groupe_id, nom_complet, telephone, email,
                          date_adhesion)
      VALUES (p_groupe_id, btrim(v_ligne.membre_nom), v_ligne.membre_telephone,
              nullif(btrim(coalesce(v_ligne.membre_email, '')), ''),
              p_date_debut)
      RETURNING id INTO v_membre_id;

      v_membres := v_membres + 1;
    END IF;

    -- LE COMPTE DE COTISATION EST CRÉÉ AVEC LE MEMBRE, pas plus tard.
    -- `enregistrer_versement()` le cherche et refuse le versement s'il manque ;
    -- l'import échouerait alors au premier montant, après avoir tout construit.
    -- C'est ce qui s'est produit au premier essai de cette fonction.
    IF NOT EXISTS (
      SELECT 1 FROM compte
       WHERE groupe_id = p_groupe_id
         AND membre_id = v_membre_id
         AND nature = 'COTISATION_MEMBRE'
    ) THEN
      INSERT INTO compte (groupe_id, nature, libelle, membre_id)
      SELECT p_groupe_id, 'COTISATION_MEMBRE',
             'Cotisations — ' || m.nom_complet, v_membre_id
        FROM membre m WHERE m.id = v_membre_id;
    END IF;
  END LOOP;

  -- --- Plan de comptes du groupe -------------------------------------
  -- La caisse et la banque n'appartiennent à personne : elles portent les
  -- fonds du groupe. Sans elles, aucun versement n'a de contrepartie.
  IF NOT EXISTS (
    SELECT 1 FROM compte WHERE groupe_id = p_groupe_id AND nature = 'CAISSE'
  ) THEN
    INSERT INTO compte (groupe_id, nature, libelle)
    VALUES (p_groupe_id, 'CAISSE', 'Caisse espèces');
  END IF;

  -- La banque sert au mobile money et aux virements. Un cahier qui ne cite que
  -- des espèces ne s'en servira pas, mais la créer coûte une ligne et évite
  -- qu'un import échoue sur son unique versement par téléphone.
  IF NOT EXISTS (
    SELECT 1 FROM compte WHERE groupe_id = p_groupe_id AND nature = 'BANQUE'
  ) THEN
    INSERT INTO compte (groupe_id, nature, libelle)
    VALUES (p_groupe_id, 'BANQUE', 'Compte mobile money');
  END IF;

  -- LES MEMBRES DÉJÀ PRÉSENTS AVANT L'IMPORT ont pu être créés sans compte —
  -- le président qui importe, typiquement, a été saisi à la main pour porter
  -- le rôle. Il figure dans les tours et doit donc cotiser comme les autres.
  INSERT INTO compte (groupe_id, nature, libelle, membre_id)
  SELECT p_groupe_id, 'COTISATION_MEMBRE', 'Cotisations — ' || m.nom_complet, m.id
    FROM membre m
   WHERE m.groupe_id = p_groupe_id
     AND NOT m.supprime
     AND NOT EXISTS (
       SELECT 1 FROM compte c
        WHERE c.membre_id = m.id AND c.nature = 'COTISATION_MEMBRE'
     );

  SELECT count(*) INTO v_nb_membres
    FROM membre WHERE groupe_id = p_groupe_id AND NOT supprime;

  IF v_nb_membres < 2 THEN
    RAISE EXCEPTION
      'Une tontine suppose au moins deux membres — le cahier n''en porte que %',
      v_nb_membres
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- --- Cycle ---------------------------------------------------------
  SELECT coalesce(max(numero), 0) + 1 INTO v_numero_cycle
    FROM cycle WHERE groupe_id = p_groupe_id;

  v_intervalle := CASE p_periodicite
                    WHEN 'HEBDOMADAIRE'  THEN INTERVAL '1 week'
                    WHEN 'QUINZAINE'     THEN INTERVAL '2 weeks'
                    WHEN 'MENSUELLE'     THEN INTERVAL '1 month'
                    WHEN 'TRIMESTRIELLE' THEN INTERVAL '3 months'
                  END;

  INSERT INTO cycle (groupe_id, numero, date_debut, date_fin_prevue, statut)
  VALUES (p_groupe_id, v_numero_cycle, p_date_debut,
          (p_date_debut + v_intervalle * v_nb_membres)::DATE,
          'EN_COURS')
  RETURNING id INTO v_cycle_id;

  -- --- Tours ---------------------------------------------------------
  -- L'ORDRE DE PASSAGE VIENT DU CAHIER, pas d'un tirage. C'est l'information
  -- la plus chargée politiquement d'une tontine : qui touche en premier a été
  -- négocié, parfois âprement. La plateforme ne la redistribue pas.
  --
  -- Un membre sans rang déclaré est placé après ceux qui en ont un, dans
  -- l'ordre de leur apparition dans le fichier.
  FOR v_membre_id, v_rang IN
    SELECT m.id,
           row_number() OVER (
             ORDER BY min(coalesce(l.rang_beneficiaire, 9999)), min(m.cree_le)
           )::INTEGER
      FROM membre m
      LEFT JOIN unnest(p_lignes) l
             ON l.membre_telephone = m.telephone
     WHERE m.groupe_id = p_groupe_id AND NOT m.supprime
     GROUP BY m.id
  LOOP
    v_date_tour := (p_date_debut + v_intervalle * (v_rang - 1))::DATE;

    INSERT INTO tour (cycle_id, rang, beneficiaire_id, date_remise_prevue)
    VALUES (v_cycle_id, v_rang, v_membre_id, v_date_tour)
    RETURNING id INTO v_tour_id;

    v_tours := v_tours + 1;

    -- Chaque membre doit une cotisation à chaque tour : c'est la définition
    -- même d'une tontine, et c'est ce qui rend la cagnotte prévisible.
    INSERT INTO echeance (cycle_id, membre_id, tour_id, date_echeance,
                          montant_attendu)
    SELECT v_cycle_id, m.id, v_tour_id, v_date_tour, p_montant_cotisation
      FROM membre m
     WHERE m.groupe_id = p_groupe_id AND NOT m.supprime;
  END LOOP;

  -- --- Versements -----------------------------------------------------
  -- REJOUÉS PAR `enregistrer_versement()`, la fonction du quotidien. C'est le
  -- cœur du principe posé en tête de fichier : le journal comptable est
  -- construit par la mécanique normale, et un contrôleur n'a pas à se demander
  -- si les écritures importées obéissent aux mêmes règles que les autres.
  -- ORDRE CHRONOLOGIQUE STRICT. Les versements doivent être rejoués dans
  -- l'ordre où ils ont eu lieu : `enregistrer_versement()` impute au solde
  -- courant de l'échéance, et deux versements partiels inversés produiraient
  -- les bons totaux avec les mauvaises dates dans le journal.
  FOR v_ligne IN
    SELECT * FROM unnest(p_lignes)
     WHERE montant IS NOT NULL AND montant > 0
     ORDER BY date_operation, tour_verse NULLS LAST
  LOOP
    SELECT id INTO v_membre_id
      FROM membre
     WHERE groupe_id = p_groupe_id
       AND telephone = v_ligne.membre_telephone
       AND NOT supprime;

    IF v_membre_id IS NULL THEN
      RAISE EXCEPTION
        'Versement de % daté du % : aucun membre ne porte le téléphone %',
        v_ligne.montant, v_ligne.date_operation, v_ligne.membre_telephone
        USING ERRCODE = 'no_data_found';
    END IF;

    -- L'échéance visée est celle du tour indiqué. À défaut, on prend la plus
    -- ancienne échéance non réglée du membre — ce que ferait un trésorier
    -- devant un versement sans mention de tour : il éponge le plus vieux dû.
    SELECT e.id INTO v_echeance_id
      FROM echeance e
      JOIN tour t ON t.id = e.tour_id
     WHERE e.cycle_id = v_cycle_id
       AND e.membre_id = v_membre_id
       AND (v_ligne.tour_verse IS NULL OR t.rang = v_ligne.tour_verse)
       AND e.statut <> 'REGLEE'
     ORDER BY t.rang
     LIMIT 1;

    IF v_echeance_id IS NULL THEN
      RAISE EXCEPTION
        'Versement de % daté du % pour % : aucune échéance ouverte (tour %). '
        'Soit le cahier verse plus que le dû, soit ce membre a déjà tout '
        'réglé pour ce tour.',
        v_ligne.montant, v_ligne.date_operation, v_ligne.membre_telephone,
        coalesce(v_ligne.tour_verse::TEXT, 'non précisé')
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    PERFORM enregistrer_versement(
      v_echeance_id,
      v_ligne.montant,
      v_ligne.date_operation,
      coalesce(v_ligne.moyen, 'ESPECES'),
      p_importe_par,
      'Reprise de cahier'
    );

    v_versements := v_versements + 1;
    v_total := v_total + v_ligne.montant;
  END LOOP;

  -- --- Trace ----------------------------------------------------------
  INSERT INTO import (groupe_id, importe_par, source, membres_crees,
                      tours_crees, versements_crees, montant_total, empreinte)
  VALUES (p_groupe_id, p_importe_par, p_source, v_membres, v_tours,
          v_versements, v_total, p_empreinte)
  RETURNING id INTO v_import_id;

  -- CONSIGNÉ EN UNE SEULE LIGNE, et non une par versement. Les versements
  -- rejoués ont déjà produit leurs propres entrées d'historique, par les
  -- triggers de la migration 017. Ce qu'il manque, et que cette ligne apporte,
  -- c'est le fait générateur : tel jour, telle personne a repris tel cahier.
  PERFORM consigner(
    'CAHIER_IMPORTE',
    p_importe_par,
    format('Reprise du cahier « %s » : %s membre(s), %s tour(s), %s versement(s)',
           p_source, v_membres, v_tours, v_versements),
    NULL,
    v_total
  );

  RETURN QUERY SELECT v_import_id, v_membres, v_tours, v_versements, v_total;
END;
$$;

COMMENT ON FUNCTION importer_cahier IS
  'Reprend un cahier de tontine. Rejoue les versements par '
  'enregistrer_versement() : le journal est construit par la mécanique '
  'normale, jamais contourné. Tout ou rien.';

REVOKE EXECUTE ON FUNCTION importer_cahier FROM PUBLIC;
GRANT EXECUTE ON FUNCTION importer_cahier TO tontine_app;

-- ---------------------------------------------------------------------
-- Historique des imports d'un groupe.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_import AS
SELECT i.id,
       i.groupe_id,
       i.source,
       m.nom_complet AS importe_par,
       i.membres_crees,
       i.tours_crees,
       i.versements_crees,
       i.montant_total,
       i.cree_le
  FROM import i
  JOIN membre m ON m.id = i.importe_par
 ORDER BY i.cree_le DESC;

GRANT SELECT ON v_import TO tontine_app;
