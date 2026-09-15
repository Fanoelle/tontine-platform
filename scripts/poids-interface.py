#!/usr/bin/env python3
"""
Mesure ce que CHAQUE PROFIL d'utilisateur télécharge réellement.

POURQUOI PAR PROFIL, ET NON EN TOTAL. N-USG-02 impose moins de 100 ko « par
écran utile » — pas au dépôt entier. Tant que l'interface tenait en un fichier,
les deux revenaient au même : tout le monde téléchargeait tout. Depuis le
découpage en modules, la question juste est « que télécharge une trésorière de
ROSCA à sa première visite ? », et la réponse n'est plus le total.

Le total reste affiché, parce qu'il dit autre chose : jusqu'où le projet peut
grossir avant qu'un seul profil ne dépasse.

UN MODULE DÉCLARÉ MAIS ABSENT EST UNE ERREUR, jamais un zéro silencieux. Sans
cela, renommer un fichier sans mettre ce script à jour produirait une mesure
fausse — et rassurante, ce qui est pire.

Usage :  python3 scripts/poids-interface.py
"""

import pathlib
import sys

RACINE = pathlib.Path(__file__).resolve().parent.parent
SERVI = RACINE / 'web-servi'
PLAFOND = 100 * 1024

# Le NOYAU est ce que tout le monde charge : page, style, service worker, et le
# module principal (session, navigation, outils, hors-ligne).
NOYAU = ['index.html', 'style.css', 'sw.js', 'app.js']

# Un profil = ce qu'un utilisateur donné charge EN PLUS, selon son rôle et le
# mécanisme de son groupe. Les écrans d'un autre mécanisme ne sont jamais
# téléchargés : un groupe ROSCA n'a pas de prêts.
PROFILS = {
    # Un membre ordinaire ne voit ni les anomalies, ni le rapprochement : dans
    # un groupe de douze, onze personnes sont dans ce cas.
    'Membre — ROSCA':          ['ecrans-rosca.js'],
    'Membre — ASCA':           ['ecrans-asca.js'],
    'Membre — MUTUELLE':       ['ecrans-mutuelle.js'],

    # Le bureau ajoute les écrans de contrôle.
    'Trésorière — ROSCA':      ['ecrans-rosca.js', 'ecrans-bureau.js'],
    'Trésorier — ASCA':        ['ecrans-asca.js', 'ecrans-bureau.js'],
    'Trésorier — MUTUELLE':    ['ecrans-mutuelle.js', 'ecrans-bureau.js'],

    # Le seul profil qui charge la reprise de cahier : un président dont le
    # groupe n'a pas encore de cycle. Une fois le cahier repris, l'onglet
    # disparaît et ce module n'est plus jamais demandé.
    'Président — groupe neuf': ['ecrans-rosca.js', 'ecrans-bureau.js',
                                'ecran-import.js'],
}


def taille(nom: str) -> int:
    fichier = SERVI / nom
    return fichier.stat().st_size if fichier.exists() else 0


def main() -> int:
    if not SERVI.is_dir():
        print("web-servi/ absent — lancez d'abord scripts/construire-web.py",
              file=sys.stderr)
        return 1

    absents_noyau = [f for f in NOYAU if taille(f) == 0]
    if absents_noyau:
        print(f'Fichiers du noyau introuvables : {", ".join(absents_noyau)}',
              file=sys.stderr)
        return 1

    noyau = sum(taille(f) for f in NOYAU)

    print(f'\n  {"NOYAU (chargé par tous)":34} {noyau / 1024:6.1f} ko')
    for f in NOYAU:
        print(f'    {f:32} {taille(f) / 1024:6.1f} ko')

    print(f'\n  {"PROFIL":34} {"chargé":>8}   {"marge":>8}')
    print('  ' + '-' * 54)

    pire = 0
    probleme = False

    for nom, modules in PROFILS.items():
        absents = [m for m in modules if taille(m) == 0]
        if absents:
            print(f'  {nom:34} MODULES ABSENTS : {", ".join(absents)}')
            probleme = True
            continue

        total = noyau + sum(taille(m) for m in modules)
        pire = max(pire, total)
        marge = PLAFOND - total
        etat = '' if marge >= 0 else '  DÉPASSE'
        if marge < 0:
            probleme = True
        print(f'  {nom:34} {total / 1024:6.1f} ko  {marge / 1024:+6.1f} ko{etat}')

    tous = sorted({f for m in PROFILS.values() for f in m} | set(NOYAU))
    total_depot = sum(taille(f) for f in tous)

    print('  ' + '-' * 54)
    print(f'  {"PIRE PROFIL":34} {pire / 1024:6.1f} ko  '
          f'{(PLAFOND - pire) / 1024:+6.1f} ko')
    print(f'  {"Tous fichiers confondus":34} {total_depot / 1024:6.1f} ko'
          f'   (référence, hors plafond)')
    print()

    if probleme:
        print('  N-USG-02 VIOLÉ pour au moins un profil.', file=sys.stderr)
        return 1

    return 0


if __name__ == '__main__':
    sys.exit(main())
