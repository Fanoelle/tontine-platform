-- =============================================================================
-- 017 — Alimentation automatique de l'historique
--
-- POURQUOI DES DÉCLENCHEURS PLUTÔT QUE D'APPELER `consigner` DANS LES ONZE
-- FONCTIONS MÉTIER.
--
-- Deux raisons, et la seconde est la vraie.
--
-- La première : modifier onze fonctions éprouvées pour y ajouter un appel,
-- c'est onze occasions de casser ce qui marche.
--
-- La seconde, décisive : un appel dans le code peut être OUBLIÉ. Une douzième
-- fonction écrite dans six mois n'aurait aucune raison de penser à consigner,
-- et son absence ne se verrait qu'en assemblée, le jour où quelqu'un cherche
-- qui a pris une décision. Un déclencheur sur la table, lui, capte TOUT ce qui
-- s'y insère — y compris ce qu'on n'a pas prévu.
--
-- C'est le même raisonnement que R-01 : l'équilibre est tenu par la base, pas
-- par la discipline de l'appelant.
--
-- CE QUI N'EST PAS CONSIGNÉ ICI : les écritures comptables elles-mêmes. Elles
-- sont déjà au journal, immuables et horodatées. Les redoubler créerait deux
-- vérités à tenir d'accord.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Versements et annulations
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION historiser_cotisation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_membre   TEXT;
    v_membre_id UUID;
    v_devise   CHAR(3);
BEGIN
    SELECT m.nom_complet, m.id, g.devise
      INTO v_membre, v_membre_id, v_devise
      FROM echeance e
      JOIN membre m ON m.id = e.membre_id
      JOIN cycle  c ON c.id = e.cycle_id
      JOIN groupe g ON g.id = c.groupe_id
     WHERE e.id = NEW.echeance_id;

    PERFORM consigner(
        'VERSEMENT_ENREGISTRE'::type_operation,
        NEW.saisi_par,
        format('Versement de %s %s enregistré pour %s',
               NEW.montant, v_devise, v_membre),
        NULL, NEW.montant, v_membre_id, NEW.ecriture_id, NEW.echeance_id);

    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_historiser_cotisation ON cotisation;
CREATE TRIGGER trg_historiser_cotisation
    AFTER INSERT ON cotisation
    FOR EACH ROW EXECUTE FUNCTION historiser_cotisation();

-- L'annulation se détecte à la SUPPRESSION de la cotisation : `annuler_versement`
-- retire la ligne après avoir posé l'écriture inverse.
CREATE OR REPLACE FUNCTION historiser_annulation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_membre    TEXT;
    v_membre_id UUID;
    v_devise    CHAR(3);
    v_motif     TEXT;
    v_auteur    UUID;
BEGIN
    SELECT m.nom_complet, m.id, g.devise
      INTO v_membre, v_membre_id, v_devise
      FROM echeance e
      JOIN membre m ON m.id = e.membre_id
      JOIN cycle  c ON c.id = e.cycle_id
      JOIN groupe g ON g.id = c.groupe_id
     WHERE e.id = OLD.echeance_id;

    -- L'écriture inverse porte le motif et son auteur. On les reprend plutôt
    -- que de les redemander : c'est la même décision.
    SELECT e.motif_correction, e.saisi_par INTO v_motif, v_auteur
      FROM ecriture e
     WHERE e.ecriture_corrigee_id = OLD.ecriture_id
     LIMIT 1;

    PERFORM consigner(
        'VERSEMENT_ANNULE'::type_operation,
        COALESCE(v_auteur, OLD.saisi_par),
        format('Versement de %s %s annulé pour %s',
               OLD.montant, v_devise, v_membre),
        v_motif, OLD.montant, v_membre_id, OLD.ecriture_id, OLD.echeance_id);

    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_historiser_annulation ON cotisation;
CREATE TRIGGER trg_historiser_annulation
    AFTER DELETE ON cotisation
    FOR EACH ROW EXECUTE FUNCTION historiser_annulation();

-- -----------------------------------------------------------------------------
-- Dispenses et remises de cagnotte — détectées sur `echeance` et `tour`
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION historiser_dispense()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_membre TEXT;
BEGIN
    -- Seule la BASCULE vers DISPENSEE nous intéresse : un recalcul de statut
    -- qui laisse l'échéance dispensée n'est pas une nouvelle décision.
    IF NEW.statut <> 'DISPENSEE' OR OLD.statut = 'DISPENSEE' THEN
        RETURN NULL;
    END IF;

    SELECT m.nom_complet INTO v_membre
      FROM membre m WHERE m.id = NEW.membre_id;

    PERFORM consigner(
        'DISPENSE_ACCORDEE'::type_operation,
        NEW.dispense_par,
        format('Dispense accordée à %s pour l''échéance du %s',
               v_membre, to_char(NEW.date_echeance, 'DD/MM/YYYY')),
        NEW.motif_dispense, NEW.montant_attendu - NEW.montant_regle,
        NEW.membre_id, NULL, NEW.id);

    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_historiser_dispense ON echeance;
CREATE TRIGGER trg_historiser_dispense
    AFTER UPDATE ON echeance
    FOR EACH ROW EXECUTE FUNCTION historiser_dispense();

CREATE OR REPLACE FUNCTION historiser_remise()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_benef  TEXT;
    v_devise CHAR(3);
    v_auteur UUID;
BEGIN
    IF NEW.date_remise_reelle IS NULL OR OLD.date_remise_reelle IS NOT NULL THEN
        RETURN NULL;
    END IF;

    SELECT m.nom_complet INTO v_benef
      FROM membre m WHERE m.id = NEW.beneficiaire_id;

    SELECT g.devise, e.saisi_par INTO v_devise, v_auteur
      FROM ecriture e JOIN groupe g ON g.id = e.groupe_id
     WHERE e.id = NEW.ecriture_remise_id;

    PERFORM consigner(
        'CAGNOTTE_REMISE'::type_operation,
        v_auteur,
        format('Cagnotte du tour %s remise à %s : %s %s',
               NEW.rang, v_benef, NEW.montant_cagnotte, v_devise),
        NULL, NEW.montant_cagnotte, NEW.beneficiaire_id,
        NEW.ecriture_remise_id);

    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_historiser_remise ON tour;
CREATE TRIGGER trg_historiser_remise
    AFTER UPDATE ON tour
    FOR EACH ROW EXECUTE FUNCTION historiser_remise();

-- -----------------------------------------------------------------------------
-- Prêts — demande, décision, rééchelonnement
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION historiser_pret()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_emprunteur TEXT;
    v_devise     CHAR(3);
BEGIN
    SELECT m.nom_complet INTO v_emprunteur
      FROM membre m WHERE m.id = NEW.emprunteur_id;

    SELECT g.devise INTO v_devise
      FROM cycle c JOIN groupe g ON g.id = c.groupe_id
     WHERE c.id = NEW.cycle_id;

    IF TG_OP = 'INSERT' THEN
        PERFORM consigner(
            'PRET_DEMANDE'::type_operation,
            NEW.emprunteur_id,
            format('Prêt de %s %s demandé par %s',
                   NEW.montant_demande, v_devise, v_emprunteur),
            NEW.motif_demande, NEW.montant_demande, NEW.emprunteur_id,
            NULL, NULL, NEW.id);
        RETURN NULL;
    END IF;

    -- Seuls les CHANGEMENTS d'état sont des décisions.
    IF NEW.statut = OLD.statut THEN
        RETURN NULL;
    END IF;

    IF NEW.statut = 'APPROUVE' OR
       (NEW.statut = 'EN_REMBOURSEMENT' AND OLD.statut = 'DEMANDE') THEN
        PERFORM consigner(
            'PRET_APPROUVE'::type_operation,
            NEW.decide_par,
            format('Prêt de %s %s accordé à %s',
                   NEW.montant_accorde, v_devise, v_emprunteur),
            NEW.motif_decision, NEW.montant_accorde, NEW.emprunteur_id,
            NEW.ecriture_octroi_id, NULL, NEW.id);

    ELSIF NEW.statut = 'REFUSE' THEN
        PERFORM consigner(
            'PRET_REFUSE'::type_operation,
            NEW.decide_par,
            format('Prêt de %s %s refusé à %s',
                   NEW.montant_demande, v_devise, v_emprunteur),
            NEW.motif_decision, NEW.montant_demande, NEW.emprunteur_id,
            NULL, NULL, NEW.id);

    ELSIF NEW.statut = 'REECHELONNE' THEN
        PERFORM consigner(
            'PRET_REECHELONNE'::type_operation,
            -- Le décideur du rééchelonnement est dans la table dédiée.
            COALESCE((SELECT r.decide_par FROM reechelonnement r
                       WHERE r.pret_id = NEW.id
                       ORDER BY r.cree_le DESC LIMIT 1), NEW.decide_par),
            format('Prêt de %s rééchelonné sur %s échéances, %s %s restant dus',
                   v_emprunteur, NEW.nombre_echeances,
                   NEW.capital_restant_du, v_devise),
            (SELECT r.motif FROM reechelonnement r
              WHERE r.pret_id = NEW.id ORDER BY r.cree_le DESC LIMIT 1),
            NEW.capital_restant_du, NEW.emprunteur_id, NULL, NULL, NEW.id);
    END IF;

    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_historiser_pret ON pret;
CREATE TRIGGER trg_historiser_pret
    AFTER INSERT OR UPDATE ON pret
    FOR EACH ROW EXECUTE FUNCTION historiser_pret();

CREATE OR REPLACE FUNCTION historiser_remboursement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_emprunteur TEXT;
    v_devise     CHAR(3);
    v_membre_id  UUID;
BEGIN
    SELECT m.nom_complet, m.id, g.devise
      INTO v_emprunteur, v_membre_id, v_devise
      FROM pret p
      JOIN membre m ON m.id = p.emprunteur_id
      JOIN cycle  c ON c.id = p.cycle_id
      JOIN groupe g ON g.id = c.groupe_id
     WHERE p.id = NEW.pret_id;

    PERFORM consigner(
        'REMBOURSEMENT_ENREGISTRE'::type_operation,
        NEW.saisi_par,
        format('Remboursement de %s %s reçu de %s%s',
               NEW.montant_capital + NEW.montant_interet, v_devise, v_emprunteur,
               CASE WHEN NEW.montant_interet > 0
                    THEN format(' (dont %s d''intérêt)', NEW.montant_interet)
                    ELSE '' END),
        NULL, NEW.montant_capital + NEW.montant_interet, v_membre_id,
        NEW.ecriture_id, NULL, NEW.pret_id);

    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_historiser_remboursement ON remboursement;
CREATE TRIGGER trg_historiser_remboursement
    AFTER INSERT ON remboursement
    FOR EACH ROW EXECUTE FUNCTION historiser_remboursement();

-- -----------------------------------------------------------------------------
-- Aides
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION historiser_aide()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_benef  TEXT;
    v_devise CHAR(3);
BEGIN
    SELECT m.nom_complet INTO v_benef
      FROM membre m WHERE m.id = NEW.beneficiaire_id;

    SELECT g.devise INTO v_devise
      FROM cycle c JOIN groupe g ON g.id = c.groupe_id
     WHERE c.id = NEW.cycle_id;

    IF TG_OP = 'INSERT' THEN
        PERFORM consigner(
            'AIDE_DEMANDEE'::type_operation,
            NEW.beneficiaire_id,
            format('Aide de %s %s demandée par %s',
                   NEW.montant_demande, v_devise, v_benef),
            NEW.motif, NEW.montant_demande, NEW.beneficiaire_id,
            NULL, NULL, NULL, NEW.id);
        RETURN NULL;
    END IF;

    IF NEW.statut = OLD.statut THEN
        RETURN NULL;
    END IF;

    IF NEW.statut = 'APPROUVEE' THEN
        PERFORM consigner(
            'AIDE_APPROUVEE'::type_operation,
            NEW.decide_par,
            format('Aide de %s %s accordée à %s%s',
                   NEW.montant_accorde, v_devise, v_benef,
                   CASE WHEN NEW.montant_accorde < NEW.montant_demande
                        THEN format(' (demandé : %s)', NEW.montant_demande)
                        ELSE '' END),
            NEW.motif_decision, NEW.montant_accorde, NEW.beneficiaire_id,
            NULL, NULL, NULL, NEW.id);

    ELSIF NEW.statut = 'VERSEE' THEN
        PERFORM consigner(
            'AIDE_VERSEE'::type_operation,
            NEW.decide_par,
            format('Aide de %s %s remise à %s',
                   NEW.montant_accorde, v_devise, v_benef),
            NEW.motif, NEW.montant_accorde, NEW.beneficiaire_id,
            NEW.ecriture_id, NULL, NULL, NEW.id);

    ELSIF NEW.statut = 'REFUSEE' THEN
        PERFORM consigner(
            'AIDE_APPROUVEE'::type_operation,
            NEW.decide_par,
            format('Aide de %s %s refusée à %s',
                   NEW.montant_demande, v_devise, v_benef),
            NEW.motif_decision, NEW.montant_demande, NEW.beneficiaire_id,
            NULL, NULL, NULL, NEW.id);
    END IF;

    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_historiser_aide ON aide;
CREATE TRIGGER trg_historiser_aide
    AFTER INSERT OR UPDATE ON aide
    FOR EACH ROW EXECUTE FUNCTION historiser_aide();

-- -----------------------------------------------------------------------------
-- Anomalies levées — la décision la plus contestable de toutes
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION historiser_levee()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.statut <> 'LEVEE' OR OLD.statut = 'LEVEE' THEN
        RETURN NULL;
    END IF;

    PERFORM consigner(
        'ANOMALIE_LEVEE'::type_operation,
        NEW.levee_par,
        format('Point à vérifier justifié : %s', left(NEW.description, 120)),
        NEW.motif_levee, NULL, NEW.membre_id,
        NEW.ecriture_id, NEW.echeance_id, NEW.pret_id, NULL, NEW.id);

    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_historiser_levee ON anomalie;
CREATE TRIGGER trg_historiser_levee
    AFTER UPDATE ON anomalie
    FOR EACH ROW EXECUTE FUNCTION historiser_levee();

-- -----------------------------------------------------------------------------
-- Relevés Mobile Money et archivage
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION historiser_releve()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM consigner(
        'RELEVE_IMPORTE'::type_operation,
        NEW.importe_par,
        format('Relevé %s importé, période du %s au %s',
               NEW.operateur,
               to_char(NEW.periode_debut, 'DD/MM/YYYY'),
               to_char(NEW.periode_fin, 'DD/MM/YYYY')));
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_historiser_releve ON releve_mobile_money;
CREATE TRIGGER trg_historiser_releve
    AFTER INSERT ON releve_mobile_money
    FOR EACH ROW EXECUTE FUNCTION historiser_releve();

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO tontine_app;

COMMIT;
