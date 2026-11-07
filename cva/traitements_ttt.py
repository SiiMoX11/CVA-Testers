# STYLE FICHE TTT V2
import os
import json
import base64
from html import escape
import copy
import sqlite3
import datetime as dt
from io import BytesIO
from docx import Document
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

from .config import DATA_DIR  # catalogues JSON et modèle Word de la fiche

GROUPES=['Sérums','Antalgiques','Antibiotiques','Anticoagulation','Insuline','Autres']
DB_PATH=None  # CATALOGUE TTT PARAMETRES V1 : défini par register_treatments


def json_catalogue():
    """Catalogue d'origine (fichiers JSON), utilisé pour initialiser la liste des Paramètres."""
    with open(os.path.join(DATA_DIR,'catalogue_traitements.json'),encoding='utf-8') as f:
        rows=json.load(f)
    with open(os.path.join(DATA_DIR,'ordre_traitements.json'),encoding='utf-8') as f:
        order=json.load(f)
    result=[{**row,'rang':order['ordre'].get(row['nom'],5)} for row in rows]
    return sorted(result,key=lambda row:row['rang'])


def catalogue():
    """Catalogue modifiable depuis Paramètres (table ttt_catalogue), sinon fichiers JSON."""
    if DB_PATH:
        conn=sqlite3.connect(DB_PATH)
        try:
            rows=conn.execute('SELECT id,nom,prises,jours,rang FROM ttt_catalogue ORDER BY rang,position,id').fetchall()
            return [{'id':r[0],'nom':r[1],'prises':r[2],'jours':r[3],'rang':r[4]} for r in rows]
        except sqlite3.OperationalError:
            pass
        finally:
            conn.close()
    return json_catalogue()


def treatment_rank(entry):
    mapping={row['nom']:row['rang'] for row in catalogue()}
    if entry.get('title') in mapping:return mapping[entry['title']]
    categories={'solutés':0,'solutes':0,'sérums':0,'serums':0,'antalgique':1,'antibiotique':2,'anticoagulant':3,'anticoagulation':3,'insuline':4}
    return categories.get(str(entry.get('category') or '').strip().lower(),5)


def treatment_data(e):
    try:p=json.loads(e.get('details') or '')
    except (ValueError,TypeError):p=None
    if isinstance(p,dict) and p.get('schema')=='ttt-catalogue-v1':return p
    return None

def set_patient_header(doc,patient,diseases):
    values={'Nom et Prénom':(patient.get('nom') or '')+' '+(patient.get('prenom') or ''),'IP':patient.get('ip') or '', 'Diagnostic':patient.get('motif') or '', 'Maladies associées':diseases or ''}
    replaced=set()
    for part in doc.part.package.parts:
        if 'header' not in str(part.partname):continue
        for paragraph in part.element.iter(qn('w:p')):
            if len(list(paragraph.iter(qn('w:p'))))!=1:continue
            nodes=list(paragraph.iter(qn('w:t')))
            text=''.join(n.text or '' for n in nodes).replace('\u00a0',' ').strip()
            for label,value in values.items():
                if text.replace('\u00a0',' ').startswith(label) and ':' in text:
                    if nodes:
                        nodes[0].text=label+' : '+str(value).strip()
                        nodes[0].set(qn('xml:space'),'preserve')
                        for node in nodes[1:]:node.text=''
                        replaced.add(label)
                    break
    if set(values)-replaced:raise ValueError('Les champs du modèle Word attendu sont introuvables.')

def set_cell(cell,text,bold=False,center=False):
    # Preserve the model's paragraph properties and first-run formatting.
    paragraph=cell.paragraphs[0]
    properties=None
    if paragraph.runs and paragraph.runs[0]._r.rPr is not None:
        properties=copy.deepcopy(paragraph.runs[0]._r.rPr)
    elif paragraph._p.pPr is not None and paragraph._p.pPr.find(qn('w:rPr')) is not None:
        properties=copy.deepcopy(paragraph._p.pPr.find(qn('w:rPr')))
    for other in list(cell.paragraphs[1:]):
        cell._tc.remove(other._p)
    for child in list(paragraph._p):
        if child.tag!=qn('w:pPr'):
            paragraph._p.remove(child)
    run=paragraph.add_run(str(text or ''))
    if properties is not None:
        run._r.insert(0,properties)


def make_treatment_sheet(patient,diseases,treatments,stamp):
    start=dt.date.fromisoformat(stamp[:10])
    doc=Document(os.path.join(DATA_DIR,'modele_fiche_traitement.docx'))
    set_patient_header(doc,patient,diseases)
    if not doc.tables or len(doc.tables[0].columns)!=7:raise ValueError('Modèle de fiche de traitement incompatible.')
    table=doc.tables[0]
    repeat=OxmlElement('w:tblHeader');repeat.set(qn('w:val'),'true');table.rows[0]._tr.get_or_add_trPr().append(repeat)
    set_cell(table.cell(0,0),'Traitement prescrit',True,True)
    dates=[start+dt.timedelta(days=i) for i in range(6)]
    for i,day in enumerate(dates,1):set_cell(table.cell(0,i),day.strftime('%d/%m'),True,True)
    active=[e for e in treatments if not e.get('done')]
    active.sort(key=lambda e:(e.get('date') or '',e.get('id') or 0),reverse=True)
    active.sort(key=treatment_rank)
    while len(table.rows)<len(active)+1:
        table._tbl.append(copy.deepcopy(table.rows[-1]._tr))
    available={row['nom']:row for row in catalogue()}
    for row in table.rows[1:]:
        for cell in row.cells:set_cell(cell,'')
    for i,e in enumerate(active,1):
        stored=treatment_data(e);preset=available.get(e.get('title'))
        # No inference of dose, frequency or duration from arbitrary text.
        takes=int(stored['prises']) if stored else 0
        planned=int(stored['jours']) if stored else 0
        title=e.get('title') or ''
        complement=(e.get('content') or '').strip()
        notes=(stored.get('notes') or '') if stored else (e.get('details') or '')
        text=title+('\n'+complement if complement else '')+('\n'+notes if notes else '')
        set_cell(table.cell(i,0),text)
        try:entry_start=dt.date.fromisoformat(e.get('date') or start.isoformat())
        except ValueError:entry_start=start
        plan_start=max(start,entry_start)
        for j,day in enumerate(dates,1):
            allowed=0<planned<=6 and plan_start<=day<plan_start+dt.timedelta(days=planned)
            set_cell(table.cell(i,j),'Δ'*takes if allowed and takes else '',True,True)
    from .word_style import apply_times_new_roman
    apply_times_new_roman(doc)  # TIMES NEW ROMAN V1
    buffer=BytesIO();doc.save(buffer);buffer.seek(0);return buffer

def register_treatments(app,db,login_required,now,log,db_path):
    from flask import request,jsonify,send_file
    global DB_PATH
    DB_PATH=db_path
    conn=sqlite3.connect(db_path)
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS patient_treatment_info(patient_id INTEGER PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE, associated_diseases TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)")
        conn.commit()
    finally:conn.close()

    @app.get('/api/ttt/catalogue')
    @login_required
    def api_ttt_catalogue():return jsonify(traitements=catalogue())

    @app.get('/api/patients/<int:pid>/ttt-profile')
    @login_required
    def api_ttt_profile(pid):
        if not db().execute('SELECT 1 FROM patients WHERE id=?',(pid,)).fetchone():return jsonify(error='Patient introuvable.'),404
        row=db().execute('SELECT associated_diseases FROM patient_treatment_info WHERE patient_id=?',(pid,)).fetchone()
        return jsonify(associated_diseases=row['associated_diseases'] if row else '')

    @app.put('/api/patients/<int:pid>/ttt-profile')
    @login_required
    def api_ttt_update_profile(pid):
        if not db().execute('SELECT 1 FROM patients WHERE id=?',(pid,)).fetchone():return jsonify(error='Patient introuvable.'),404
        data=request.get_json(silent=True) or {};value=data.get('associated_diseases','')
        if not isinstance(value,str) or len(value)>1000:return jsonify(error='Maladies associées : 1000 caractères maximum.'),400
        value=value.strip()
        db().execute('INSERT INTO patient_treatment_info(patient_id,associated_diseases,updated_at) VALUES(?,?,?) ON CONFLICT(patient_id) DO UPDATE SET associated_diseases=excluded.associated_diseases,updated_at=excluded.updated_at',(pid,value,now()))
        log(pid,'Maladies associées (TTT) modifiées',value);db().commit()
        return jsonify(ok=True)

    @app.before_request
    def validate_ttt_request():
        if request.endpoint not in {'api_add_entry','api_update_entry'}:return None
        @login_required
        def check():
            data=request.get_json(silent=True) or {};kind=data.get('kind');existing=None
            if request.endpoint=='api_update_entry':
                existing=db().execute('SELECT * FROM entries WHERE id=?',(request.view_args['eid'],)).fetchone()
                kind=existing['kind'] if existing else None
            if kind!='traitement':return None
            try:p=json.loads(data.get('details') or '')
            except (ValueError,TypeError):return None
            if not isinstance(p,dict) or p.get('schema')!='ttt-catalogue-v1':return None
            title=(data.get('title') or '').strip()
            names={r['nom'] for r in catalogue()}
            if title not in names and not (existing and title==existing['title']):return jsonify(error='Choisissez un traitement du catalogue.'),400
            try:
                takes=p.get('prises');days=p.get('jours')
                if type(takes) is not int or type(days) is not int:raise ValueError()
                dt.date.fromisoformat(data.get('date') or '')
                if not 0<=takes<=24 or not 1<=days<=6:raise ValueError()
            except (ValueError,TypeError):return jsonify(error='Vérifiez prises/jour (0–24), jours de fiche (1–6) et date.'),400
            notes=p.get('notes') or ''
            if not isinstance(notes,str) or len(notes)>4000:return jsonify(error='Remarques invalides.'),400
            data['title']=title
            data['details']=json.dumps({'schema':'ttt-catalogue-v1','prises':takes,'jours':days,'notes':notes.strip()},ensure_ascii=False)
            return None
        return check()

    @app.get('/api/patients/<int:pid>/fiche-traitement')
    @login_required
    def api_ttt_word(pid):
        conn=db();conn.execute('BEGIN')
        try:
            patient=conn.execute('SELECT * FROM patients WHERE id=?',(pid,)).fetchone()
            if not patient:return jsonify(error='Patient introuvable.'),404
            row=conn.execute('SELECT associated_diseases FROM patient_treatment_info WHERE patient_id=?',(pid,)).fetchone()
            treatments=[dict(e) for e in conn.execute("SELECT * FROM entries WHERE patient_id=? AND kind='traitement'",(pid,)).fetchall()]
            stamp=now();buffer=make_treatment_sheet(dict(patient),row['associated_diseases'] if row else '',treatments,stamp)
        except (ValueError,OSError) as exc:return jsonify(error=str(exc)),422
        finally:conn.rollback()
        response=send_file(buffer,as_attachment=True,download_name='Fiche_TTT_patient_'+str(pid)+'_'+stamp[:10]+'.docx',mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        response.headers['Cache-Control']='no-store';return response


# ---- Aperçu HTML de la fiche de traitement (ex-ttt_preview.py) ----
def paragraph_html(element):
    ppr=element.find(qn('w:pPr'))
    inherited=ppr.find(qn('w:rPr')) if ppr is not None else None
    def property_value(properties,tag):
        node=properties.find(qn('w:'+tag)) if properties is not None else None
        return node
    jc=property_value(ppr,'jc')
    align=jc.get(qn('w:val')) if jc is not None else 'left'
    align=align if align in {'left','right','center','justify'} else 'left'
    chunks=[]
    for run in element:
        if run.tag!=qn('w:r'):continue
        rpr=run.find(qn('w:rPr'))
        size=property_value(rpr,'sz')
        if size is None:size=property_value(inherited,'sz')
        points=12
        if size is not None:
            try:points=float(size.get(qn('w:val')))/2
            except (ValueError,TypeError):pass
        points=max(6,min(72,points))
        bold=property_value(rpr,'b')
        if bold is None:bold=property_value(inherited,'b')
        weight='bold' if bold is not None and bold.get(qn('w:val'),'1') not in {'0','false','off'} else 'normal'
        text=[]
        for node in run.iter():
            if node.tag==qn('w:t'):text.append(escape(node.text or ''))
            elif node.tag==qn('w:br'):text.append('<br>')
        if text:chunks.append('<span style="font-size:'+str(points)+'pt;font-weight:'+weight+'">'+''.join(text)+'</span>')
    return '<p dir="auto" style="text-align:'+align+'">'+''.join(chunks)+'</p>'


def sheet_html(buffer):
    buffer.seek(0);doc=Document(buffer);header=[];seen=set();logos=[];seen_images=set()
    for part in doc.part.package.parts:
        if 'header' not in str(part.partname):continue
        for p in part.element.iter(qn('w:p')):
            if len(list(p.iter(qn('w:p'))))!=1:continue
            text=''.join(n.text or '' for n in p.iter(qn('w:t'))).strip()
            if text and text not in seen:
                seen.add(text);header.append(paragraph_html(p))
        for rel in part.rels.values():
            if rel.is_external or not rel.reltype.endswith('/image'):continue
            image=rel.target_part
            if image.partname in seen_images:continue
            seen_images.add(image.partname)
            if image.content_type not in {'image/png','image/jpeg','image/gif'}:continue
            logos.append('<img alt="Logo du modèle" src="data:'+image.content_type+';base64,'+base64.b64encode(image.blob).decode('ascii')+'">')
    tables=[]
    for table in doc.tables:
        rows=[]
        for row in table.rows:
            cells=['<td>'+''.join(paragraph_html(p._p) for p in cell.paragraphs)+'</td>' for cell in row.cells]
            rows.append('<tr>'+''.join(cells)+'</tr>')
        tables.append('<table>'+''.join(rows)+'</table>')
    foot=[];seen_footer=set()
    for part in doc.part.package.parts:
        if 'footer' not in str(part.partname):continue
        for p in part.element.iter(qn('w:p')):
            if len(list(p.iter(qn('w:p'))))!=1:continue
            text=''.join(n.text or '' for n in p.iter(qn('w:t'))).strip()
            if text and text not in seen_footer:
                seen_footer.add(text);foot.append(paragraph_html(p))
    return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>body{font-family:Cambria,"Times New Roman",serif;background:#e2e8f0;margin:0;color:#000}.sheet{background:white;max-width:820px;margin:12px auto;padding:24px;box-sizing:border-box}p{margin:5px 0;white-space:pre-wrap;line-height:1.3}.logos{display:flex;justify-content:space-between;gap:15px}.logos img{max-height:80px;max-width:150px;object-fit:contain}table{border-collapse:collapse;width:100%;margin-top:16px;table-layout:fixed}td{border:1px solid #000;padding:8px 4px;text-align:center;vertical-align:middle;overflow-wrap:anywhere}td:first-child{width:30%}footer{font-size:10pt;margin-top:16px}footer p span{font-size:10pt!important}@media(max-width:600px){.sheet{min-width:680px;margin:0;padding:15px}body{overflow:auto}}</style></head><body><div class="sheet"><header><div class="logos">'+''.join(logos)+'</div>'+''.join(header)+'</header>'+''.join(tables)+'<footer>'+''.join(foot)+'</footer></div></body></html>'


def register_ttt_preview(app,db,login_required,now):
    from flask import jsonify
    @app.get('/api/patients/<int:pid>/fiche-traitement/preview')
    @login_required
    def api_ttt_preview(pid):
        conn=db();conn.execute('BEGIN')
        try:
            patient=conn.execute('SELECT * FROM patients WHERE id=?',(pid,)).fetchone()
            if not patient:return jsonify(error='Patient introuvable.'),404
            row=conn.execute('SELECT associated_diseases FROM patient_treatment_info WHERE patient_id=?',(pid,)).fetchone()
            treatments=[dict(e) for e in conn.execute("SELECT * FROM entries WHERE patient_id=? AND kind='traitement'",(pid,)).fetchall()]
            stamp=now();buffer=make_treatment_sheet(dict(patient),row['associated_diseases'] if row else '',treatments,stamp)
            original=buffer.getvalue();html=sheet_html(buffer)
        except (ValueError,OSError) as exc:return jsonify(error=str(exc)),422
        finally:conn.rollback()
        response=jsonify(html=html,docx_base64=base64.b64encode(original).decode('ascii'),filename='Fiche_TTT_'+str(pid)+'_'+stamp[:10]+'.docx')
        response.headers['Cache-Control']='no-store';return response
