"""Extraction locale d'observations : aperçu obligatoire, aucune interprétation clinique."""
import re,json,unicodedata,datetime as dt,hashlib,os

def norm(s):
    return ''.join(c for c in unicodedata.normalize('NFKD',str(s)) if not unicodedata.combining(c)).lower().strip()

ALIASES={
'Alb':['alb','albumine','albuminemie'], 'GB':['gb','globules blancs','leucocytes','leucocytose','wbc'],
'Hb':['hb','hemoglobine','hgb'], 'Plq':['plq','plqt','plaquettes','thrombocytes','plt'],
'TP':['tp','taux de prothrombine'], 'CRP':['crp','proteine c reactive','proteine c-reactive'],
'Lipase':['lipase','lipasemie'], 'BT':['bt','bilirubine totale'], 'BD':['bd','bc','bilirubine directe','bilirubine conjuguee'],
'ASAT':['asat','asats','ast','tgo'], 'ALAT':['alat','alats','alt','tgp'], 'GGT':['ggt','gamma gt','gamma-gt','gamma glutamyl transferase'],
'PAL':['pal','phosphatases alcalines','phosphatase alcaline'], 'Uree':['uree','uremie'],
'Creat':['creat','creatinine','creatininemie'], 'Na':['na','sodium','natremie'], 'K':['k','potassium','kaliemie'],
'ECBU':['ecbu'], 'ACE':['ace','antigene carcino embryonnaire'], 'CA19-9':['ca19-9','ca 19-9','ca199'],
'CA125':['ca125','ca 125'], 'CA15-3':['ca15-3','ca 15-3']}
LOOKUP={norm(a).replace(' ',''):k for k,aliases in ALIASES.items() for a in aliases}

def analyte(s):return LOOKUP.get(norm(s).replace(' ',''))

def clean_lines(text):
    return [re.sub(r'^[\s*#_]+|[\s*_]+$','',line.replace('\xa0',' ')).strip() for line in str(text).splitlines()]

def header_type(line):
    n=norm(line).strip(' :-')
    if re.match(r'^(?:a[.\s]*t[.\s]*c[.\s]*d[.\s]*s?|antecedents?|antecedants?)(?:\b|\s*:)',n):return 'atcd'
    if re.match(r'^(bilan(?:s)?(?:\b)|biologie\b|nfs\b)',n) and not re.match(r'^bilan\s+(hepatique|renal)\s*:',n):return 'bilan'
    if re.match(r'^(tdm|scanner|irm|bili[- ]?irm|echographie|echo\b|radiographie|radio\b|coloscopie|fogd|endoscopie|anapath|cpre)\b',n):return 'examen'
    if re.match(r'^(hdm|histoire|examen clinique|examen general|examen abdominal|motif|identite|conclusion|conduite|traitement|evolution|prise en charge|diagnostic)\b',n):return 'stop'
    return None

def date_header(title):
    m=re.search(r'(?<!\d)(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})(?!\d)',title)
    if not m:return '', 'Date absente du titre.'
    short=len(m[3])==2
    year=2000+int(m[3]) if short else int(m[3])
    try:
        value=dt.date(year,int(m[2]),int(m[1]))
        if not 1900<=value.year<=dt.date.today().year+1:raise ValueError()
        note='Année abrégée '+m[3]+' développée en '+str(year)+' : à vérifier.' if short else ''
        return value.isoformat(),note
    except ValueError:return '', 'Date du titre à corriger : '+m[0]

def location(title):
    m=re.search(r'(?<!\d)\d{1,2}[/.\-]\d{1,2}[/.\-](?:\d{4}|\d{2})(?!\d)',title)
    if not m:return ''
    tail=title[m.end():].strip(' *:,-')
    tail=re.sub(r'^(?:au|a|à|chez)\s+','',tail,flags=re.I)
    return tail

def parse_observation(text):
    lines=clean_lines(text);sections=[];current=None
    for line in lines:
        kind=header_type(line)
        if kind:
            current=None if kind=='stop' else dict(kind=kind,title=line,lines=[])
            if current is not None:sections.append(current)
        elif current is not None and line:current['lines'].append(line)
    items=[];warnings=[]
    for section in sections:
        kind=section['kind'];title=section['title'];body=section['lines']
        if kind=='atcd':
            # Un antécédent par puce, conserver le texte et sa négation ; pas de diagnostic déduit.
            chunks=[]
            for line in body:
                if re.match(r'^[-•–]',line):chunks.append(re.sub(r'^[-•–]\s*','',line))
                elif chunks:chunks[-1]+=' '+line
                else:chunks.append(line)
            for content in chunks:
                if content:items.append(dict(kind='atcd',category='Médicaux' if not re.search(r'oper[eé]|chirurg|intervention',norm(content)) else 'Chirurgicaux',content=content,date='',title='Antécédent extrait',warnings=['Catégorie proposée à vérifier.']))
            continue
        date,warn=date_header(title);notes=[warn] if warn else []
        if kind=='examen':
            n=norm(title);category='TDM' if n.startswith(('tdm','scanner')) else 'Bili-IRM' if n.startswith(('bili-irm','bili irm')) else 'IRM' if n.startswith('irm') else 'Échographie' if n.startswith(('echo','echographie')) else 'FOGD' if n.startswith('fogd') else 'Coloscopie' if n.startswith('coloscopie') else 'CPRE' if n.startswith('cpre') else 'Anapath' if n.startswith('anapath') else 'Radiographie' if n.startswith(('radio','radiographie')) else 'Autre'
            items.append(dict(kind='examen',title=title.rstrip(' :'),category=category,date=date,place=location(title),content='\n'.join(body),warnings=notes))
            continue
        values={};unknown=[];units={}
        expanded=[]
        alias_pattern='|'.join(re.escape(a) for aliases in ALIASES.values() for a in sorted(aliases,key=len,reverse=True))
        for original_line in body:
            parts=re.split(r';\s*',original_line)
            for part in parts:
                # Ne jamais couper un groupe de paramètres au niveau d'un /.
                normalized=norm(part)
                label_group=r'(?:'+alias_pattern+r')(?:\s*/\s*(?:'+alias_pattern+r'))*'
                def separate_label(match):
                    prefix=normalized[:match.start()].rstrip()
                    return match.group(0) if prefix.endswith('/') else '\n'
                cut=re.sub(r'\s+(?='+label_group+r'\s*[:=])',separate_label,normalized,flags=re.I)
                expanded.extend(cut.splitlines())
        for line in expanded:
            m=re.match(r'^(.{1,90}?)\s*[:=]\s*(.+)$',line)
            if not m:
                m=re.match(r'^('+alias_pattern+r')\s+([<>≤≥]?\s*[-+]?\d.*)$',line,flags=re.I)
            if not m:unknown.append(line);continue
            labels=[x.strip() for x in m[1].split('/')];keys=[analyte(x) for x in labels]
            if not all(keys):unknown.append(line);continue
            # Les valeurs doubles sont séparées uniquement si les libellés sont doubles.
            rawparts=m[2].split('/') if len(keys)>1 else [m[2]]
            if len(rawparts)!=len(keys):unknown.append(line);continue
            for key,raw in zip(keys,rawparts):
                raw=raw.strip()
                result=re.match(r'^([<>≤≥]?\s*[-+]?\d+(?:[.,]\d+)?\s*[kK]?)(?:\s*(.*))?$',raw)
                if result:
                    value=result[1].replace(' ','').replace(',','.');unit=(result[2] or '').strip()
                    if unit:units[key]=unit
                elif key=='ECBU':value=raw
                else:unknown.append(line);continue
                if key in values and values[key]!=value:notes.append('Plusieurs valeurs pour '+key+' : vérifier le texte source.');continue
                values[key]=value
        if unknown:notes.append('Lignes non reconnues : '+' | '.join(unknown))
        if values:items.append(dict(kind='bilan',title=title,date=date,place=location(title),values=values,source_units=units,warnings=notes))
    atcd_items=[item for item in items if item['kind']=='atcd']
    if atcd_items:
        grouped=dict(kind='atcd',category='',content='\n'.join('- '+item['content'].lstrip('-•– ').strip() for item in atcd_items),date='',title='Antécédents',warnings=[])
        first=next(i for i,item in enumerate(items) if item['kind']=='atcd')
        others=[item for item in items if item['kind']!='atcd']
        others.insert(first,grouped)
        items=others
    return dict(items=items,warnings=warnings)

def current_stay(patient,source_date,now_date):
    start=patient.get('date_entree') or '';end=patient.get('sortie_date') or now_date
    try:
        s=dt.date.fromisoformat(start);e=dt.date.fromisoformat(end);v=dt.date.fromisoformat(source_date)
        return s<=v<=e
    except (ValueError,TypeError):return False

def register_observation_import(app,db,login_required,now,log,storage):
    from flask import request,jsonify,g
    from .bilans_tools import normalize_v2,summary_v2,reference_profile
    def patient(pid):
        row=db().execute('SELECT * FROM patients WHERE id=?',(pid,)).fetchone()
        return dict(row) if row else None
    def sources(pid,p):
        out=[]
        for r in db().execute("SELECT id,date,created_at,title FROM entries WHERE patient_id=? AND kind='observation' ORDER BY date DESC,id DESC",(pid,)):
            date=r['date'] or str(r['created_at'] or '')[:10]
            if current_stay(p,date,now()[:10]):out.append(dict(id='entry:'+str(r['id']),date=date,label='Observation — '+date+' — '+(r['title'] or str(r['id']))))
        try:
            for r in db().execute("SELECT id,document_date,title FROM patient_documents WHERE patient_id=? AND extension='.docx' ORDER BY document_date DESC,id DESC",(pid,)):
                if current_stay(p,r['document_date'],now()[:10]):out.append(dict(id='doc:'+str(r['id']),date=r['document_date'],label='Word — '+r['document_date']+' — '+r['title']))
        except Exception as exc:
            import sqlite3
            if not isinstance(exc,sqlite3.OperationalError):raise
        return out
    def read_source(pid,p,key):
        allowed={r['id']:r for r in sources(pid,p)}
        if key not in allowed:raise ValueError('Choisir une observation datée du séjour actuel. Vérifiez la date d’entrée du dossier.')
        ident=int(key.split(':')[1])
        if key.startswith('entry:'):
            row=db().execute("SELECT title,content FROM entries WHERE id=? AND patient_id=? AND kind='observation'",(ident,pid)).fetchone()
            text=(row['title'] or '')+'\n'+(row['content'] or '')
        else:
            row=db().execute('SELECT storage_name FROM patient_documents WHERE id=? AND patient_id=?',(ident,pid)).fetchone()
            from docx import Document
            from docx.table import Table
            from docx.text.paragraph import Paragraph
            from io import BytesIO
            name=row['storage_name']
            if os.path.basename(name)!=name:raise ValueError('Nom de document invalide.')
            key='patient_documents/'+name
            if not storage.exists(key):raise ValueError('Fichier Word absent du stockage.')
            doc=Document(BytesIO(storage.read(key)));parts=[]
            for child in doc.element.body:
                if child.tag.endswith('}p'):parts.append(Paragraph(child,doc).text)
                elif child.tag.endswith('}tbl'):parts.extend(' : '.join(c.text for c in row.cells) for row in Table(child,doc).rows)
            text='\n'.join(parts)
        if len(text)>250000:raise ValueError('Observation trop longue pour cet import.')
        ip=re.search(r'(?im)^\s*[*_]*\s*IP\s*:\s*([\w-]+)',text)
        if ip and str(ip[1]).strip()!=str(p.get('ip') or '').strip():raise ValueError('IP du texte différent de celui du patient. Import refusé.')
        return text
    @app.get('/api/patients/<int:pid>/observation-import/sources')
    @login_required
    def obs_import_sources(pid):
        p=patient(pid)
        if not p:return jsonify(error='Patient introuvable.'),404
        return jsonify(sources=sources(pid,p),note='Sources textuelles et Word DOCX datées du séjour actuel. PDF/images non extraits ; utiliser une observation textuelle.')
    @app.post('/api/patients/<int:pid>/observation-import/preview')
    @login_required
    def obs_import_preview(pid):
        p=patient(pid)
        if not p:return jsonify(error='Patient introuvable.'),404
        try:
            data=request.get_json(silent=True) or {};text=read_source(pid,p,data.get('source',''))
            result=parse_observation(text);cfg=reference_profile()
            return jsonify(**result,source_hash=hashlib.sha256(text.encode()).hexdigest(),units={k:v.get('unit','') for k,v in cfg['parameters'].items()})
        except (ValueError,OSError) as exc:return jsonify(error=str(exc)),400
    @app.post('/api/patients/<int:pid>/observation-import/apply')
    @login_required
    def obs_import_apply(pid):
        conn=db();p=patient(pid)
        if not p:return jsonify(error='Patient introuvable.'),404
        try:
            data=request.get_json(silent=True) or {};text=read_source(pid,p,data.get('source',''))
            if data.get('source_hash')!=hashlib.sha256(text.encode()).hexdigest():raise ValueError('La source a changé : relancer l’aperçu.')
            items=data.get('items')
            if not isinstance(items,list) or not 1<=len(items)<=150:raise ValueError('Choisissez de 1 à 150 éléments.')
            prepared=[]
            for item in items:
                if not isinstance(item,dict) or item.get('kind') not in ('atcd','examen','bilan'):raise ValueError('Élément invalide.')
                kind=item['kind'];date=str(item.get('date') or '');details='';content=str(item.get('content') or '').strip();title=str(item.get('title') or '')[:500];cat=str(item.get('category') or '')[:100]
                if kind!='atcd':
                    parsed=dt.date.fromisoformat(date)
                    if parsed.year<1900 or date>now()[:10]:raise ValueError('Corrigez les dates absentes, anciennes impossibles ou futures.')
                if kind=='bilan':
                    payload=normalize_v2({'schema':'bilan-simple-v2','values':item.get('values')},p)
                    details=json.dumps(payload,ensure_ascii=False);content=summary_v2(payload)
                elif kind=='examen':title=clean_import_exam_title(title,item.get('place')) or cat or 'Examen';details=json.dumps(dict(schema='exam-location-v1',place=str(item.get('place') or '')[:500],report=''),ensure_ascii=False)
                if not content or len(content)>50000:raise ValueError('Contenu absent ou trop long.')
                prepared.append(dict(kind=kind,date=date,details=details,content=content,title=title,category=cat))
            conn.execute('BEGIN IMMEDIATE');added=0;skipped=[]
            for item in prepared:
                existing=[dict(r) for r in conn.execute('SELECT * FROM entries WHERE patient_id=? AND kind=?',(pid,item['kind']))]
                if item['kind']=='bilan':
                    # Ne pas écraser un bilan ni fusionner aveuglément des valeurs de même date.
                    if any(e['date']==item['date'] for e in existing):skipped.append('Bilan '+item['date']+' : un bilan existe déjà, à compléter manuellement.');continue
                elif item['kind']=='atcd':
                    previous_lines={norm(line.lstrip('-•– ').strip()) for entry in existing for line in entry['content'].splitlines() if line.strip()}
                    pending=[line for line in item['content'].splitlines() if norm(line.lstrip('-•– ').strip()) not in previous_lines]
                    if not pending:
                        skipped.append('Antécédents déjà présents.');continue
                    item['content']='\n'.join(pending)
                elif any(norm(e['content'])==norm(item['content']) and (item['kind']=='atcd' or (e['date']==item['date'] and same_import_exam_title(e,item))) for e in existing):
                    skipped.append(item['kind']+' déjà présent.');continue
                stamp=now()
                conn.execute('INSERT INTO entries(patient_id,kind,category,date,title,content,details,done,author,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,?,?,?)',(pid,item['kind'],item['category'],item['date'],item['title'],item['content'],item['details'],g.user['full_name'],stamp,stamp));added+=1
            log(pid,'Préremplissage MAJ depuis observation',str(added)+' éléments ajoutés ; source '+str(data.get('source')))
            conn.commit();return jsonify(added=added,skipped=skipped)
        except (ValueError,TypeError,KeyError) as exc:
            conn.rollback();return jsonify(error=str(exc)),400
        except Exception:
            conn.rollback();raise

# UNITES SERVICE IMPORT V2

# OBSERVATION COMPACT ATCD V3

# OBSERVATION ORDRE DATES DETAILS V4


# EXAM TITLE UNIQUE V1
def clean_import_exam_title(title,place):
    value=re.sub(r'\s*(?:(?:le|du|en date du)\s+)?\b\d{1,2}[/.\-]\d{1,2}[/.\-](?:\d{4}|\d{2})(?!\d)',' ',str(title),flags=re.I)
    location=str(place or '').strip(' :;,')
    if location:value=re.sub(r'\s*(?:(?:au|à|a|chez)\s+)?'+re.escape(location)+r'[\s:;,]*$','',value,flags=re.I)
    value=re.sub(r'\s+(?:le|du|au|à|chez)$','',value.strip(' :;,'),flags=re.I)
    return re.sub(r'\s+',' ',value).strip(' :;,')

def same_import_exam_title(old,new):
    def place(entry):
        try:return json.loads(entry.get('details') or '{}').get('place','')
        except (ValueError,TypeError,AttributeError):return ''
    old_place,new_place=place(old),place(new)
    return norm(clean_import_exam_title(old.get('title') or old.get('category') or '',old_place))==norm(clean_import_exam_title(new.get('title') or new.get('category') or '',new_place)) and norm(old_place)==norm(new_place)


# ATCD HEADINGS VARIANTS V1
