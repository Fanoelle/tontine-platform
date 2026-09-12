#!/usr/bin/env python3
"""
Allège l'interface servie, sans toucher aux sources.

LE PROBLÈME MESURÉ. N-USG-02 impose moins de 100 ko par écran utile. Les trois
fichiers de `web/` pèsent 90,6 ko — il ne reste que 9,4 ko de marge, et chaque
écran ajouté en consomme. Sur les 33 ko du CSS, 9,9 sont des commentaires.

LE DILEMME. Ces commentaires ont de la valeur : ils expliquent pourquoi le
bouton de remise est absent plutôt que grisé, pourquoi les pastilles gardent une
bordure en plus du fond. Les supprimer appauvrirait le code. Mais les servir au
navigateur à chaque chargement, sur une connexion lente, est un gaspillage.

LA SORTIE. On les garde dans la source et on les retire du fichier servi. La
source reste la vérité ; `web-servi/` est un artefact, régénérable, ignoré par
git.

CE QUE CE SCRIPT NE FAIT PAS. Il ne renomme aucune variable, ne réorganise
aucune règle, ne touche pas au JavaScript au-delà des commentaires et des
espaces. Un minificateur agressif gagnerait quelques kilo-octets de plus au prix
d'un code servi qu'on ne peut plus déboguer dans le navigateur — mauvais
échange pour une application que son auteur devra corriger sur le terrain.

Usage :  python3 scripts/construire-web.py
"""

import pathlib
import re
import sys

RACINE = pathlib.Path(__file__).resolve().parent.parent
SOURCE = RACINE / 'web'
SORTIE = RACINE / 'web-servi'


def alleger_css(texte: str) -> str:
    """Retire les commentaires d'une feuille de style. Rien d'autre.

    POURQUOI SI PEU. Un premier essai compactait aussi les espaces et la
    ponctuation. Vérification faite, il cassait : accolades déséquilibrées,
    URL de données SVG détruite, `@media` et `@supports` disparus. Un
    minificateur maison manipule une grammaire dont il ne connaît qu'une
    partie ; le gain ne vaut pas ce risque sur une application qui manipule de
    l'argent.

    L'APOSTROPHE FRANÇAISE A CASSÉ LA SECONDE VERSION. Le motif de protection
    des chaînes traitait `'` comme un délimiteur — et ce CSS est commenté en
    français : « d'abord », « l'effet », « d'une banque ». Chaque apostrophe
    ouvrait une fausse chaîne qui avalait le code jusqu'à la suivante, faisant
    disparaître des blocs entiers. Le fichier produit paraissait normal à la
    lecture ; seul un comptage l'a révélé.

    On ne protège donc que les `url(...)`, seul endroit d'une feuille de style
    où un `/*` peut apparaître sans ouvrir un commentaire. Les guillemets
    simples ne sont pas traités comme des délimiteurs.
    """
    protege: list[str] = []

    def garder(m: re.Match) -> str:
        protege.append(m.group(0))
        return f'\x00{len(protege) - 1}\x00'

    # Les url(...) d'abord : elles peuvent contenir n'importe quoi, y compris
    # un SVG encodé avec des slashes et des astérisques.
    texte = re.sub(r'url\([^)]*\)', garder, texte)

    texte = re.sub(r'/\*.*?\*/', '', texte, flags=re.S)

    lignes = [l.rstrip() for l in texte.split('\n')]
    lignes = [l for l in lignes if l.strip()]
    texte = '\n'.join(lignes)

    for i, valeur in enumerate(protege):
        texte = texte.replace(f'\x00{i}\x00', valeur)

    return texte.strip() + '\n'


def alleger_js(texte: str) -> str:
    """Retire les commentaires d'un script, sans toucher au code.

    ON NE MINIFIE PAS LE JAVASCRIPT AU-DELÀ DE ÇA. Renommer les variables
    gagnerait quelques kilo-octets, mais rendrait illisible toute trace d'erreur
    remontée depuis le navigateur d'un utilisateur — et c'est précisément dans
    ce cas qu'on en a besoin.
    """
    resultat: list[str] = []
    i = 0
    n = len(texte)

    while i < n:
        c = texte[i]

        # Chaînes et gabarits : recopiés tels quels, échappements compris.
        if c in '"\'`':
            delim = c
            j = i + 1
            while j < n:
                if texte[j] == '\\':
                    j += 2
                    continue
                if texte[j] == delim:
                    break
                j += 1
            resultat.append(texte[i:j + 1])
            i = j + 1
            continue

        # Commentaire de bloc.
        if c == '/' and i + 1 < n and texte[i + 1] == '*':
            fin = texte.find('*/', i + 2)
            i = n if fin == -1 else fin + 2
            continue

        # Commentaire de ligne. On vérifie que le `/` n'ouvre pas une expression
        # régulière : celles-ci sont précédées d'un opérateur ou d'une
        # parenthèse ouvrante, jamais d'un identifiant ou d'une parenthèse
        # fermante.
        if c == '/' and i + 1 < n and texte[i + 1] == '/':
            precedent = ''
            for k in range(len(resultat) - 1, -1, -1):
                morceau = resultat[k].rstrip()
                if morceau:
                    precedent = morceau[-1]
                    break
            if precedent not in ')]}' and not (precedent.isalnum() or precedent == '_'):
                # Ambigu : on garde, plutôt que de risquer de couper une regex.
                pass
            fin = texte.find('\n', i)
            i = n if fin == -1 else fin
            continue

        resultat.append(c)
        i += 1

    code = ''.join(resultat)

    # Lignes devenues vides, et indentation.
    lignes = [l.rstrip() for l in code.split('\n')]
    lignes = [l for l in lignes if l.strip()]
    return '\n'.join(lignes)


def alleger_html(texte: str) -> str:
    """Retire les commentaires HTML, préserve tout le reste."""
    return re.sub(r'<!--(?!\[if).*?-->', '', texte, flags=re.S)


def main() -> int:
    if not SOURCE.is_dir():
        print('web/ introuvable', file=sys.stderr)
        return 1

    SORTIE.mkdir(exist_ok=True)

    traitements = {
        '.css':  alleger_css,
        '.js':   alleger_js,
        '.html': alleger_html,
    }

    avant_total = apres_total = 0

    for fichier in sorted(SOURCE.iterdir()):
        if not fichier.is_file():
            continue

        source = fichier.read_text(encoding='utf-8')
        traiter = traitements.get(fichier.suffix)
        resultat = traiter(source) if traiter else source

        (SORTIE / fichier.name).write_text(resultat, encoding='utf-8')

        avant = len(source.encode('utf-8'))
        apres = len(resultat.encode('utf-8'))
        avant_total += avant
        apres_total += apres

        gain = 100 * (avant - apres) / avant if avant else 0
        print(f'  {fichier.name:16} {avant / 1024:6.1f} ko → '
              f'{apres / 1024:6.1f} ko  ({gain:4.1f} % de moins)')

    print(f'\n  {"TOTAL":16} {avant_total / 1024:6.1f} ko → '
          f'{apres_total / 1024:6.1f} ko')

    marge = 100 - apres_total / 1024
    print(f'  marge sous les 100 ko de N-USG-02 : {marge:.1f} ko')

    if marge < 0:
        print('\n  N-USG-02 VIOLÉ — il faut retirer du contenu, pas seulement '
              'alléger.', file=sys.stderr)
        return 1

    return 0


if __name__ == '__main__':
    sys.exit(main())
