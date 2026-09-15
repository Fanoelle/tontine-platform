#!/usr/bin/env python3
"""
Vérifie la cohérence du découpage en modules.

LE DÉFAUT QU'IL ATTRAPE. Un écran différé qui n'est pas inscrit dans la
COQUILLE du Service Worker fonctionne parfaitement en ligne, et échoue hors
ligne — au moment précis où l'utilisateur en a besoin, et chez lui seulement.
Le genre de panne qui ne se voit ni en développement, ni en relecture.

TROIS VÉRIFICATIONS, chacune pour une façon distincte de casser :

  1. Tout module déclaré dans ECRANS existe sur le disque.
     Sinon : l'onglet s'ouvre sur une erreur de téléchargement.

  2. Tout module déclaré dans ECRANS est dans la COQUILLE du Service Worker.
     Sinon : l'écran marche en ligne et casse hors ligne.

  3. Tout symbole importé depuis './app.js' y est bien exporté.
     Sinon : le module se charge et lève `undefined is not a function` à
     l'exécution — donc au clic de l'utilisateur, pas au démarrage.

Usage :  python3 scripts/verifier-modules.py
"""

import pathlib
import re
import subprocess
import sys

RACINE = pathlib.Path(__file__).resolve().parent.parent
WEB = RACINE / 'web'


def modules_declares() -> list[tuple[str, str]]:
    """Les couples (chemin, export attendu) cités dans le registre ECRANS."""
    app = (WEB / 'app.js').read_text(encoding='utf-8')
    bloc = re.search(r'const ECRANS = \{(.*?)\n\};', app, re.S)
    if not bloc:
        raise SystemExit('Registre ECRANS introuvable dans web/app.js')
    return re.findall(r"\['(\./[\w.-]+\.js)',\s*'(\w+)'\]", bloc.group(1))


def exports_du_module(fichier: pathlib.Path) -> set[str]:
    texte = fichier.read_text(encoding='utf-8')
    return set(re.findall(r'^export (?:async )?function (\w+)', texte, re.M))


def syntaxe_valide(fichier: pathlib.Path) -> str | None:
    """Rend le message d'erreur de syntaxe, ou None si le fichier est bon.

    POURQUOI CE CONTRÔLE EXISTE. Un script de refactoring a un jour inséré
    sept lignes contenant le seul mot « export », orphelines. Les fichiers
    passaient toutes les vérifications structurelles de ce script, et le
    navigateur refusait app.js en bloc avec « Unexpected token 'export' » —
    l'application ne démarrait plus du tout. Un vérificateur qui contrôle la
    cohérence sans contrôler la syntaxe rassure à tort.

    Node sert d'analyseur : `--input-type=module` lui fait lire le fichier
    comme un module ES. Les erreurs d'EXÉCUTION (« window is not defined »)
    sont attendues et ignorées — seule la syntaxe nous intéresse ici.
    """
    resultat = subprocess.run(
        ['node', '--input-type=module', '--eval',
         fichier.read_text(encoding='utf-8')],
        capture_output=True, text=True,
    )
    for ligne in resultat.stderr.split('\n'):
        if 'SyntaxError' in ligne:
            return ligne.strip()
    return None


def coquille() -> set[str]:
    """Les chemins mis en cache à l'installation du Service Worker."""
    sw = (WEB / 'sw.js').read_text(encoding='utf-8')
    bloc = re.search(r'const COQUILLE = \[(.*?)\];', sw, re.S)
    if not bloc:
        raise SystemExit('Liste COQUILLE introuvable dans web/sw.js')
    return set(re.findall(r"'(/[\w.-]*)'", bloc.group(1)))


def exports_du_noyau() -> set[str]:
    app = (WEB / 'app.js').read_text(encoding='utf-8')
    return set(
        re.findall(r'^export (?:async )?function (\w+)', app, re.M)
    ) | set(re.findall(r'^export (?:let|const) (\w+)', app, re.M))


def imports_du_module(fichier: pathlib.Path) -> set[str]:
    texte = fichier.read_text(encoding='utf-8')
    bloc = re.search(r"import\s*\{(.*?)\}\s*from\s*'\./app\.js'", texte, re.S)
    if not bloc:
        return set()
    return {
        nom.strip()
        for nom in bloc.group(1).replace('\n', ' ').split(',')
        if nom.strip()
    }


def main() -> int:
    declares = modules_declares()
    en_cache = coquille()
    exportes = exports_du_noyau()

    fautes: list[str] = []

    print(f'\n  Écrans différés : {len(declares)}')

    for chemin, attendu in sorted(declares):
        nom = chemin.lstrip('./')
        fichier = WEB / nom
        ligne = f'    {nom:22} {attendu:20}'

        if not fichier.exists():
            print(ligne + ' ABSENT DU DISQUE')
            fautes.append(f'{nom} est déclaré dans ECRANS mais n\'existe pas')
            continue

        etats = []

        faute_syntaxe = syntaxe_valide(fichier)
        if faute_syntaxe:
            etats.append(faute_syntaxe)
            fautes.append(f'{nom} : {faute_syntaxe}')

        if f'/{nom}' not in en_cache:
            etats.append('PAS DANS LA COQUILLE')
            fautes.append(
                f'{nom} manque dans COQUILLE (sw.js) — '
                'l\'écran sera indisponible hors ligne'
            )

        # L'EXPORT ATTENDU DOIT EXISTER. Le registre le nomme explicitement
        # depuis qu'un module peut porter deux écrans (ecrans-bureau.js) : une
        # faute de frappe ici ne se verrait qu'au clic de l'utilisateur.
        if attendu not in exports_du_module(fichier):
            etats.append(f'N\'EXPORTE PAS {attendu}')
            fautes.append(f'{nom} n\'exporte pas {attendu}')

        inconnus = imports_du_module(fichier) - exportes
        if inconnus:
            etats.append(f'IMPORTE {", ".join(sorted(inconnus))} — non exporté(s)')
            fautes.append(
                f'{nom} importe {", ".join(sorted(inconnus))} '
                'que app.js n\'exporte pas'
            )

        print(ligne + ('  ' + ' ; '.join(etats) if etats else '  ok'))

    faute_noyau = syntaxe_valide(WEB / 'app.js')
    if faute_noyau:
        print(f'\n  app.js : {faute_noyau}')
        fautes.append(f'app.js : {faute_noyau}')

    print(f'\n  Symboles exportés par app.js : {len(exportes)}')
    print(f'    {", ".join(sorted(exportes))}')

    if fautes:
        print('\n  DÉCOUPAGE INCOHÉRENT :', file=sys.stderr)
        for faute in fautes:
            print(f'    — {faute}', file=sys.stderr)
        print()
        return 1

    print('\n  Découpage cohérent.\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
