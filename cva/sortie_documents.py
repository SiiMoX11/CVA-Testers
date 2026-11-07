# CRH ORDONNANCE V4.3
"""Documents de sortie Word uniquement, sans conversion externe.

SORTIE V3 : Times New Roman, aucun espacement avant/après les paragraphes, titres en gras soulignés,
en-tête du CRH dans un tableau (comme le modèle du service), téléchargement possible avant la validation.
"""
import io
import re
import unicodedata
import datetime as dt
from pathlib import Path
from docx import Document
from docx.enum.text import WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt

from .config import DATA_DIR
from .word_style import FONT, apply_times_new_roman

TITLE_LINES = ('COMPTE RENDU D’HOSPITALISATION', "COMPTE RENDU D'HOSPITALISATION")


def _no_spacing(para):
    fmt = para.paragraph_format
    fmt.space_before = Pt(0)
    fmt.space_after = Pt(0)
    fmt.line_spacing = 1.0
    return para


def _table_borders(table):
    tbl_pr = table._tbl.tblPr
    borders = OxmlElement('w:tblBorders')
    for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        el = OxmlElement('w:' + edge)
        el.set(qn('w:val'), 'single')
        el.set(qn('w:sz'), '4')
        el.set(qn('w:space'), '0')
        el.set(qn('w:color'), '000000')
        borders.append(el)
    tbl_pr.append(borders)


def _is_title(line):
    stripped = line.strip()
    return (bool(stripped) and stripped.endswith(':') and len(stripped) <= 120) or bool(re.match(r'^.{1,200} du \d{2}/\d{2}/\d{4}(?:\s.*)?$', stripped))


def build_sortie_word(patient, kind, template=None, medecin_defaut=''):
    if kind not in ('crh', 'ordonnance'):
        raise ValueError('Type de document invalide.')
    template = Path(template) if template else Path(DATA_DIR) / 'sortie_modele.docx'
    doc = Document(str(template))
    for child in list(doc._element.body):
        if not child.tag.endswith('}sectPr'):
            doc._element.body.remove(child)
    normal = doc.styles['Normal']
    normal.font.name = FONT
    normal.font.size = Pt(12)
    _no_spacing(normal)
    p = patient

    def date(value):
        value = str(value or '')
        return '/'.join(value.split('-')[::-1]) if re.fullmatch(r'\d{4}-\d{2}-\d{2}', value) else value or 'À préciser'

    def add(text='', bold=False, center=False, underline=False, container=None):
        para = (container or doc).add_paragraph()
        _no_spacing(para)
        if center:
            para.alignment = 1
        run = para.add_run(str(text or ''))
        run.bold = bold
        run.underline = underline
        return para

    name = ' '.join(str(p.get(k) or '') for k in ('nom', 'prenom')).strip()
    if kind == 'crh':
        summary = str(p.get('sortie_resume') or '').strip()
        if not summary:
            raise ValueError('Renseignez et enregistrez le résumé avant le téléchargement du CRH.')
        age = (str(p['age']) + ' ans') if p.get('age') not in (None, '') else 'Non renseigné'
        medecin = str(p.get('sortie_medecin') or '').strip() or str(medecin_defaut or '').strip() or 'À préciser'
        # En-tête dans un tableau : titre, puis identité (même ordre que le modèle du service).
        table = doc.add_table(rows=2, cols=1)
        _table_borders(table)
        title_cell, info_cell = table.cell(0, 0), table.cell(1, 0)
        title = title_cell.paragraphs[0]
        _no_spacing(title)
        title.alignment = 1
        title.add_run('Compte Rendu d’Hospitalisation').bold = True
        lines = [
            [('Nom et prénom : ', name or 'Non renseigné'), ('IP : ', str(p.get('ip') or 'Non renseigné')), ('AGE : ', age)],
            [('Date d’entrée : ', date(p.get('date_entree'))), ('Date de sortie : ', date(p.get('sortie_date')))],
            [('Médecin responsable : ', medecin)],
        ]
        for i, parts in enumerate(lines):
            para = info_cell.paragraphs[0] if i == 0 else info_cell.add_paragraph()
            _no_spacing(para)
            para.paragraph_format.tab_stops.add_tab_stop(Cm(8.4), WD_TAB_ALIGNMENT.LEFT)
            para.paragraph_format.tab_stops.add_tab_stop(Cm(11.9), WD_TAB_ALIGNMENT.LEFT)
            for j, (label, value) in enumerate(parts):
                if j:
                    para.add_run('\t')
                para.add_run(label + value).bold = True
        add()
        # Le traitement est rendu depuis sa source structurée, jamais depuis un doublon du résumé.
        for line in summary.splitlines():
            stripped = line.strip().strip('*').strip()
            normalized = ''.join(c for c in unicodedata.normalize('NFD', stripped.lower()) if not unicodedata.combining(c))
            if re.match(r"^patient(?:e|\(e\))? declare", normalized):
                break
            if stripped.upper() in TITLE_LINES:
                continue
            if stripped.startswith('Nom et prénom :') or (stripped.startswith('Date d’entrée :') and 'Date de sortie :' in stripped):
                continue
            if normalized in ('prise en charge :', 'signature et cachet'):
                continue
            if normalized in ('sortie :', 'projet de sortie :', 'traitement de sortie :', 'ordonnance de sortie renseignee :'):
                raise ValueError('Ancien résumé CRH : cliquez sur Préremplir depuis MAJ + observations puis enregistrez le brouillon.')
            subheading = bool(re.fullmatch(r'examen (?:general[e]?|abdominal)\s*:', normalized))
            title_line = _is_title(stripped)
            # La phrase de sortie est du texte courant, pas un titre.
            intervention = bool(re.match(r'^intervention le\s+', normalized))
            if intervention:
                match = re.match(r'^intervention le\s+(\d{2}/\d{2}/\d{4})\s*:', normalized)
                try:
                    op_date = dt.datetime.strptime(match[1], '%d/%m/%Y').date() if match else None
                    start = dt.date.fromisoformat(str(p.get('date_entree') or ''))
                    today_date = dt.date.fromisoformat(str(p.get('_crh_today') or dt.datetime.now(dt.timezone.utc).date().isoformat()))
                    end = min(dt.date.fromisoformat(str(p.get('sortie_date') or today_date.isoformat())), today_date)
                except (ValueError, TypeError):
                    continue
                if op_date is None or not (start <= op_date <= end):
                    continue
            add(stripped, title_line or subheading or intervention, underline=(title_line and not subheading) or intervention)
        add()
        sex = str(p.get('sexe') or '').upper()
        who = 'Patiente déclarée sortante' if sex == 'F' else 'Patient déclaré sortant' if sex == 'M' else 'Patient(e) déclaré(e) sortant(e)'
        add(who + ' le ' + date(p.get('sortie_date')) + ' sous :', bold=True, underline=True)
        add()
        for line in str(p.get('sortie_ordonnance') or '').splitlines():
            if not line.strip():
                continue
            match = re.match(r'^• (.*?) — Posologie : (.*?) — Durée : (.*)$', line)
            if match:
                add(match[1], bold=False, underline=True)
                instructions = ' '.join(value.strip() for value in (match[2], match[3]) if value.strip())
                if instructions:
                    add(instructions, bold=False, underline=False)
                add()
            else:
                # Ancienne ordonnance libre : conserver le texte sans inventer sa structure.
                add(line)
    else:
        prescription = str(p.get('sortie_ordonnance') or '').strip()
        if not prescription:
            raise ValueError('Aucun médicament enregistré dans l’ordonnance de sortie.')
        location_date = add('Oujda, le ' + date(p.get('sortie_date')))
        location_date.alignment = 2
        add()
        patient_name = add(name, True)
        patient_name.alignment = 0
        add('ORDONNANCE', True, True, underline=True)
        number = 0
        for line in prescription.splitlines():
            if not line.strip():
                continue
            match = re.match(r'^• (.*?) — Posologie : (.*?) — Durée : (.*)$', line)
            if match:
                number += 1
                add(str(number) + '. ' + match[1], True)
                add(match[2] + (' — ' + match[3] if match[3] else ''))
                add()
            else:
                add(line)
    add()
    if kind == 'ordonnance':
        signature = add('Signature et cachet', True, underline=True)
        signature.alignment = 2
    apply_times_new_roman(doc)
    # STYLE ATCD CRH CORRIGE
    if kind == 'crh':
        for para in doc.paragraphs:
            match = re.match(r'^(\s*ATCDs?\s*:)\s*(.*)$', para.text, re.IGNORECASE)
            if not match:
                continue
            # Conserver la mise en forme du paragraphe et séparer libellé/contenu.
            for child in list(para._p):
                if not child.tag.endswith('}pPr'):
                    para._p.remove(child)
            label = para.add_run(match[1])
            label.bold = True
            label.underline = True
            label.font.name = FONT
            label.font.size = Pt(12)
            if match[2]:
                content = para.add_run(' ' + match[2])
                content.bold = False
                content.underline = False
                content.font.name = FONT
                content.font.size = Pt(12)
    # Appliquer après le style global pour garantir la taille de toute cette ligne.
    if kind == 'crh':
        for table in doc.tables:
            for row in table.rows:
                for cell in row.cells:
                    for para in cell.paragraphs:
                        if para.text.strip().startswith('Médecin responsable :'):
                            for run in para.runs:
                                run.font.size = Pt(11)
    data = io.BytesIO()
    doc.save(data)
    data.seek(0)
    return data


def register_sortie_documents(app, db, login_required):
    from flask import jsonify, send_file

    @app.get('/api/patients/<int:pid>/sortie-document/<kind>/<fmt>')
    @login_required
    def sortie_document(pid, kind, fmt):
        if kind not in ('crh', 'ordonnance') or fmt != 'docx':
            return jsonify(error='Seul le téléchargement Word DOCX est disponible.'), 400
        row = db().execute('SELECT * FROM patients WHERE id=?', (pid,)).fetchone()
        if not row:
            return jsonify(error='Patient introuvable.'), 404
        patient = dict(row)
        try:
            clock = db().execute('SELECT offset_minutes FROM clock_settings WHERE id=1').fetchone()
            offset = int(clock[0]) if clock else 0
        except Exception:
            offset = 0
        patient['_crh_today'] = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=offset)).date().isoformat()
        # SORTIE V3 : CRH et ordonnance téléchargeables sans valider la sortie (brouillon enregistré).
        try:
            setting = db().execute("SELECT value FROM app_settings WHERE key='crh_medecin_responsable'").fetchone()
        except Exception:
            setting = None
        try:
            data = build_sortie_word(patient, kind, medecin_defaut=setting[0] if setting else '')
        except ValueError as exc:
            return jsonify(error=str(exc)), 409
        except FileNotFoundError:
            return jsonify(error='Modèle sortie_modele.docx absent du serveur.'), 503
        label = re.sub(r'[^A-Za-z0-9_-]+', '_', str(patient.get('nom') or 'patient')).strip('_') or 'patient'
        response = send_file(data, mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document', as_attachment=True, download_name=kind + '_' + label + '_' + str(pid) + '.docx')
        response.headers['Cache-Control'] = 'no-store'
        return response
