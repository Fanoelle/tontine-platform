#!/usr/bin/env python3
"""
Assemble le dossier de conception complet en un seul PDF.

POURQUOI UN CONVERTISSEUR ÉCRIT À LA MAIN. Aucun convertisseur Markdown n'est
installé sur cette machine et le réseau y est intermittent. Les documents
n'utilisent qu'un sous-ensemble restreint — titres, tableaux, citations, listes,
gras, code, blocs Mermaid — ce qui rend la conversion sûre sans dépendance.

LES DIAGRAMMES MERMAID SONT RENDUS EN IMAGES quand `mmdc` est disponible, et
présentés en texte encadré sinon. Le dossier reste donc complet et lisible dans
les deux cas : un diagramme absent serait une perte d'information, un diagramme
en texte n'en est pas une.

Usage :  python3 scripts/dossier-pdf.py [destination.pdf]
"""

import html
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

RACINE = pathlib.Path(__file__).resolve().parent.parent

# L'ordre suit la lecture naturelle d'un dossier de conception : ce que le
# système doit faire, qui s'en sert, comment les données sont structurées,
# comment les opérations s'enchaînent, et ce qui se passe quand ça se gâte.
DOCUMENTS = [
    ('docs/cahier-des-charges.md',        'Cahier des charges'),
    ('docs/diagrammes/cas-utilisation.md', 'Cas d’utilisation'),
    ('docs/diagrammes/sequences.md',       'Diagrammes de séquence'),
    ('docs/diagrammes/etats.md',           'Diagrammes d’états-transitions'),
    ('docs/diagrammes/classes.md',         'Diagramme de classes'),
    ('docs/modele-de-donnees.md',          'Modèle de données'),
    ('docs/detection-anomalies.md',        'Détection d’anomalies'),
    ('docs/conception-interface.md',       'Conception de l’interface'),
]

DECISIONS = [
    ('docs/decisions/0001-stack-technique.md',                   'Décision 1 — Stack technique'),
    ('docs/decisions/0002-socle-commun-tables-specialisees.md',  'Décision 2 — Socle commun'),
    ('docs/decisions/0003-journal-partie-double.md',             'Décision 3 — Partie double'),
]


# Images UML rendues par PlantUML (scripts/generer-uml.sh).
#
# Associe chaque document au(x) diagramme(s) qui l'illustre(nt), dans l'ordre
# où ses blocs Mermaid apparaissent. Un document absent de cette table garde
# ses blocs en source — c'est le repli, pas une erreur.
DIAGRAMMES_UML = {
    'docs/diagrammes/cas-utilisation.md': ['cas-utilisation'],
    'docs/diagrammes/sequences.md': [
        'sequence-cotisation', 'sequence-cagnotte', 'sequence-anomalie'],
    'docs/diagrammes/etats.md': [
        'etats-cycle', 'etats-echeance', 'etats-pret', 'etats-anomalie'],
    'docs/diagrammes/classes.md': [
        'classes', 'classes-journal', 'enumerations'],
}

IMAGES_UML = RACINE / 'docs' / 'uml' / 'images'

PUCE = re.compile(r'^\s*[-*] ')
NUM = re.compile(r'^\s*\d+\. ')


def inline(t: str) -> str:
    t = html.escape(t)
    t = re.sub(r'`([^`]+)`', r'<code>\1</code>', t)
    t = re.sub(r'\*\*([^*]+)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)', r'<em>\1</em>', t)
    # Les liens internes deviennent du texte : un PDF n'a pas de destination
    # pour un chemin relatif de dépôt.
    t = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', t)
    return t


def recoller(source: str) -> list[str]:
    """Fusionne les lignes d'un même paragraphe.

    Le Markdown source coupe ses paragraphes à 80 colonnes. Un gras ouvert sur
    une ligne et fermé sur la suivante ne serait reconnu sur aucune des deux, et
    ses astérisques se retrouveraient tels quels dans le PDF.
    """
    brut = source.split('\n')
    lignes, i, dans_code = [], 0, False

    while i < len(brut):
        l = brut[i]

        if l.strip().startswith('```'):
            dans_code = not dans_code
            lignes.append(l)
            i += 1
            continue

        if dans_code:
            lignes.append(l)
            i += 1
            continue

        if (not l.strip() or l.startswith(('#', '|', '>', '---'))
                or PUCE.match(l) or NUM.match(l)):
            lignes.append(l)
            i += 1
            continue

        bloc = [l.rstrip()]
        i += 1
        while i < len(brut):
            s = brut[i]
            if (not s.strip() or s.startswith(('#', '|', '>', '---', '```'))
                    or PUCE.match(s) or NUM.match(s)):
                break
            bloc.append(s.strip())
            i += 1
        lignes.append(' '.join(bloc))

    return lignes


def rendre_mermaid(code: str, dossier: pathlib.Path, index: int,
                   mmdc: str | None,
                   images: list[str] | None = None,
                   rang: int = 0) -> str:
    """Rend un bloc de diagramme en image.

    Trois voies, dans l'ordre de préférence : une image UML PlantUML déjà
    rendue, un rendu Mermaid à la volée, ou la source en texte encadré.
    """
    # 1. Image PlantUML — la meilleure : notation UML standard, rendue hors
    #    ligne, et déjà vérifiée à l'œil.
    if images and rang < len(images):
        png = IMAGES_UML / (images[rang] + '.png')
        if png.exists():
            return f'<div class="diagramme"><img src="{png}"></div>'

    if mmdc:
        src = dossier / f'diagramme-{index}.mmd'
        png = dossier / f'diagramme-{index}.png'
        src.write_text(code, encoding='utf-8')
        try:
            subprocess.run(
                [mmdc, '-i', str(src), '-o', str(png),
                 '-b', 'white', '-w', '1400'],
                check=True, capture_output=True, timeout=120)
            if png.exists() and png.stat().st_size > 0:
                return f'<div class="diagramme"><img src="{png}"></div>'
        except Exception:
            # Un diagramme qui refuse de se rendre ne doit pas faire échouer
            # tout le dossier : on retombe sur le texte.
            pass

    return ('<div class="diagramme-texte"><p class="mention">'
            'Diagramme (source Mermaid)</p><pre>'
            + html.escape(code) + '</pre></div>')


def convertir(source: str, dossier: pathlib.Path, compteur: list[int],
              mmdc: str | None, decalage: int = 0,
              images: list[str] | None = None) -> str:
    """Convertit un document Markdown en HTML.

    `decalage` abaisse le niveau des titres : dans un dossier assemblé, le titre
    de chaque document devient un niveau 2 sous le titre général.
    """
    lignes = recoller(source)
    out: list[str] = []
    i = 0
    rang_diagramme = 0
    dans_liste = dans_cite = False

    def fermer_liste():
        nonlocal dans_liste
        if dans_liste:
            out.append('</ul>')
            dans_liste = False

    def fermer_cite():
        nonlocal dans_cite
        if dans_cite:
            out.append('</blockquote>')
            dans_cite = False

    while i < len(lignes):
        l = lignes[i]

        # Bloc de code ou diagramme
        if l.strip().startswith('```'):
            fermer_liste()
            fermer_cite()
            langage = l.strip()[3:].strip()
            i += 1
            bloc = []
            while i < len(lignes) and not lignes[i].strip().startswith('```'):
                bloc.append(lignes[i])
                i += 1
            i += 1
            code = '\n'.join(bloc)
            if langage == 'mermaid':
                compteur[0] += 1
                out.append(rendre_mermaid(code, dossier, compteur[0], mmdc,
                                          images, rang_diagramme))
                rang_diagramme += 1
            else:
                out.append('<pre>' + html.escape(code) + '</pre>')
            continue

        # Tableau
        if (l.startswith('|') and i + 1 < len(lignes)
                and re.match(r'^\|[\s:|-]+\|$', lignes[i + 1])):
            fermer_liste()
            fermer_cite()
            entetes = [c.strip() for c in l.strip('|').split('|')]
            out.append('<table><thead><tr>'
                       + ''.join('<th>' + inline(c) + '</th>' for c in entetes)
                       + '</tr></thead><tbody>')
            i += 2
            while i < len(lignes) and lignes[i].startswith('|'):
                cells = [c.strip() for c in lignes[i].strip('|').split('|')]
                out.append('<tr>'
                           + ''.join('<td>' + inline(c) + '</td>' for c in cells)
                           + '</tr>')
                i += 1
            out.append('</tbody></table>')
            continue

        if l.startswith('#'):
            fermer_liste()
            fermer_cite()
            n = min(len(l) - len(l.lstrip('#')) + decalage, 6)
            out.append('<h%d>%s</h%d>' % (n, inline(l.lstrip('#').strip()), n))
        elif l.startswith('> '):
            fermer_liste()
            if not dans_cite:
                out.append('<blockquote>')
                dans_cite = True
            out.append('<p>' + inline(l[2:]) + '</p>')
        elif PUCE.match(l) or NUM.match(l):
            fermer_cite()
            if not dans_liste:
                out.append('<ul>')
                dans_liste = True
            texte = PUCE.sub('', l) if PUCE.match(l) else NUM.sub('', l)
            out.append('<li>' + inline(texte) + '</li>')
        elif l.startswith('---') or not l.strip():
            fermer_liste()
            fermer_cite()
        else:
            fermer_liste()
            fermer_cite()
            out.append('<p>' + inline(l) + '</p>')
        i += 1

    fermer_liste()
    fermer_cite()
    return ''.join(out)


STYLE = """
@page { size: A4; margin: 18mm 16mm; }
body { font-family: "DejaVu Serif", Georgia, serif; font-size: 10pt;
       line-height: 1.5; color: #1a1a1a; }
h1 { font-size: 19pt; margin: 0 0 6pt; line-height: 1.25; color: #12233d; }
h2 { font-size: 15pt; margin: 0 0 10pt; padding-bottom: 4pt;
     border-bottom: 2px solid #1d5a8a; color: #12233d;
     page-break-before: always; page-break-after: avoid; }
h3 { font-size: 12pt; margin: 16pt 0 5pt; color: #12233d;
     page-break-after: avoid; }
h4 { font-size: 10.5pt; margin: 12pt 0 4pt; color: #1d5a8a;
     page-break-after: avoid; }
p { margin: 0 0 6pt; text-align: justify; }
table { width: 100%; border-collapse: collapse; margin: 8pt 0 12pt;
        font-size: 8.5pt; page-break-inside: avoid; }
th { background: #12233d; color: #fff; text-align: left;
     padding: 5pt 6pt; font-weight: 600; }
td { padding: 4pt 6pt; border-bottom: 0.5px solid #d8d8d8; vertical-align: top; }
tr:nth-child(even) td { background: #f6f7f9; }
blockquote { margin: 8pt 0; padding: 7pt 10pt; background: #f4f2ee;
             border-left: 3px solid #b07d2b; page-break-inside: avoid; }
blockquote p { margin: 0 0 4pt; }
blockquote p:last-child { margin: 0; }
code { font-family: "DejaVu Sans Mono", monospace; font-size: 8.5pt;
       background: #eef0f3; padding: 0.5pt 3pt; border-radius: 2px; }
pre { font-family: "DejaVu Sans Mono", monospace; font-size: 7.5pt;
      line-height: 1.35; background: #f6f7f9; border: 0.5px solid #d8d8d8;
      border-radius: 3px; padding: 7pt 9pt; overflow: hidden;
      white-space: pre-wrap; word-wrap: break-word; page-break-inside: avoid; }
ul { margin: 4pt 0 8pt; padding-left: 16pt; }
li { margin-bottom: 3pt; text-align: justify; }
strong { color: #12233d; }
.diagramme { margin: 10pt 0; text-align: center; page-break-inside: avoid; }
.diagramme img { max-width: 100%; max-height: 220mm; }
.diagramme-texte { margin: 10pt 0; page-break-inside: avoid; }
.mention { font-size: 8pt; color: #5a5a5a; font-style: italic;
           margin: 0 0 3pt; }
.garde { text-align: center; padding-top: 55mm; page-break-after: always; }
.garde h1 { font-size: 26pt; border: none; margin-bottom: 10pt; }
.garde .sous { font-size: 13pt; color: #5a5a5a; margin-bottom: 40pt; }
.garde .meta { font-size: 10pt; color: #5a5a5a; line-height: 2; }
.sommaire { page-break-after: always; }
.sommaire h2 { page-break-before: auto; }
.sommaire ol { font-size: 11pt; line-height: 2.1; padding-left: 20pt; }
"""


def main() -> int:
    destination = pathlib.Path(
        sys.argv[1] if len(sys.argv) > 1
        else '/home/fanounou/Documents/'
             'Dossier de conception — Plateforme de gestion des tontines.pdf')

    mmdc = shutil.which('mmdc')
    if not mmdc:
        local = RACINE / 'api' / 'node_modules' / '.bin' / 'mmdc'
        mmdc = str(local) if local.exists() else None

    print('Rendu des diagrammes :',
          'mmdc' if mmdc else 'texte (mmdc indisponible)')

    with tempfile.TemporaryDirectory() as tmp:
        dossier = pathlib.Path(tmp)
        compteur = [0]
        corps: list[str] = []

        tous = DOCUMENTS + DECISIONS
        corps.append(
            '<div class="garde">'
            '<h1>Plateforme de gestion<br>des tontines et associations</h1>'
            '<p class="sous">Dossier de conception</p>'
            '<p class="meta">Cahier des charges &middot; Cas d’utilisation<br>'
            'Diagrammes de séquence, d’états et de classes<br>'
            'Modèle de données &middot; Détection d’anomalies<br>'
            'Conception de l’interface &middot; Décisions d’architecture</p>'
            '</div>')

        corps.append('<div class="sommaire"><h2>Sommaire</h2><ol>'
                     + ''.join('<li>' + html.escape(titre) + '</li>'
                               for _, titre in tous)
                     + '</ol></div>')

        for chemin, titre in tous:
            fichier = RACINE / chemin
            if not fichier.exists():
                print('  absent :', chemin)
                continue
            texte = fichier.read_text(encoding='utf-8')
            # Le titre de niveau 1 du document est retiré : il est remplacé par
            # le titre de section, pour une numérotation homogène du dossier.
            texte = re.sub(r'^#\s+.*?\n', '', texte, count=1)
            corps.append('<h2>' + html.escape(titre) + '</h2>')
            corps.append(convertir(texte, dossier, compteur, mmdc,
                                   decalage=1,
                                   images=DIAGRAMMES_UML.get(chemin)))
            print('  intégré :', chemin)

        page = ('<!doctype html><html lang="fr"><head><meta charset="utf-8">'
                '<title>Dossier de conception</title>'
                '<style>' + STYLE + '</style></head><body>'
                + ''.join(corps) + '</body></html>')

        html_tmp = dossier / 'dossier.html'
        html_tmp.write_text(page, encoding='utf-8')

        print('Diagrammes traités :', compteur[0])
        print('Génération du PDF…')

        destination.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(
            ['wkhtmltopdf', '--quiet', '--encoding', 'utf-8',
             '--enable-local-file-access',
             str(html_tmp), str(destination)],
            capture_output=True, text=True)

        if r.returncode != 0:
            print('ÉCHEC wkhtmltopdf :', r.stderr[-400:])
            return 1

    taille = destination.stat().st_size
    print('PDF :', destination)
    print('Taille :', f'{taille / 1024:.0f} ko')
    return 0


if __name__ == '__main__':
    sys.exit(main())
