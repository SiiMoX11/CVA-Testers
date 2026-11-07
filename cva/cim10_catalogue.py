"""Catalogue CIM-10 V5.2 : imports OMS/PMSI/GM/CM avec provenance explicite."""
import hashlib
import re
import xml.etree.ElementTree as ET

FAMILIES={
 'OMS':{'OMS','WHO'},
 'PMSI':{'PMSI','FM','FR','CIM10FR','CIM-10-FR'},
 'GM':{'GM','ICD10GM','ICD-10-GM','DE','CH'},
 'CM':{'CM','ICD10CM','ICD-10-CM','US'},
}


def validate_code(value):
    code=str(value or '').strip().upper()
    if code and not re.fullmatch(r'[A-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?',code):
        raise ValueError('Format CIM-10 invalide (ex. K35.9).')
    return code


def in_scope(code):
    if code in _INFECTIONS_CHIRURGIE_CIBLEES_V55:
        return True
    if code in _CATALOGUE_CHIRURGIE_GENERALE_CODES_V54:
        return True
    if not re.fullmatch(r'[KS][0-9]{2}(?:\.[0-9A-Z]{1,4})?',code):
        return False
    n=int(code[1:3])
    return (code[0]=='K' and n<=93) or (code[0]=='S' and 30<=n<=39)


def migrate_catalogue(conn,defaults):
    conn.execute('CREATE TABLE IF NOT EXISTS app_migrations(name TEXT PRIMARY KEY)')
    exists=conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hospit_motifs'").fetchone()
    if exists:
        columns={r[1] for r in conn.execute('PRAGMA table_info(hospit_motifs)')}
        if 'code' not in columns:
            conn.execute("CREATE TABLE hospit_motifs_v5(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,position INTEGER NOT NULL DEFAULT 0,code TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'local')")
            conn.execute('INSERT INTO hospit_motifs_v5(id,name,position) SELECT id,name,position FROM hospit_motifs')
            conn.execute('DROP TABLE hospit_motifs')
            conn.execute('ALTER TABLE hospit_motifs_v5 RENAME TO hospit_motifs')
    else:
        conn.execute("CREATE TABLE hospit_motifs(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,position INTEGER NOT NULL DEFAULT 0,code TEXT NOT NULL DEFAULT '',source TEXT NOT NULL DEFAULT 'local')")
        conn.executemany('INSERT INTO hospit_motifs(name,position) VALUES (?,?)',[(n,i) for i,n in enumerate(defaults)])
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_motifs_code ON hospit_motifs(code) WHERE code<>''")
    conn.execute('CREATE TABLE IF NOT EXISTS cim10_imports(sha256 TEXT PRIMARY KEY,source TEXT NOT NULL,imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,rows_count INTEGER NOT NULL)')


def _local(node):
    return node.tag.rsplit('}',1)[-1]


def _tokens(node):
    return set(re.split(r'[\s,;]+',(node.get('variants') or node.get('variant') or '').strip().upper()))-{''}


def _family(token):
    return next((name for name,aliases in FAMILIES.items() if token in aliases),None)


def _xml(data):
    if b'<!ENTITY' in data.upper() or re.search(br'<!DOCTYPE[^>]*\[',data,re.I):
        raise ValueError('Entités XML et DTD internes refusées pour sécurité.')
    data=re.sub(br'<!DOCTYPE[^>]*>',b'',data,flags=re.I)
    try:return ET.fromstring(data)
    except ET.ParseError as exc:raise ValueError('XML illisible : '+str(exc))


def parse_catalogue(data,terminology='AUTO',variant=''):
    root=_xml(data);kind=_local(root).lower()
    terminology=str(terminology or 'AUTO').strip().upper()
    if terminology not in {'AUTO','OMS','PMSI','GM','CM'}:
        raise ValueError('Référentiel inconnu.')
    chosen_tokens=set(re.split(r'[\s,;]+',str(variant).strip().upper()))-{''}
    if len(chosen_tokens)>10:raise ValueError('Trop d’identifiants de variante.')
    metadata=' '.join(' '.join(str(v) for v in el.attrib.values())+' '+str(el.text or '') for el in root.iter() if _local(el) in {'Title','Meta','Variant','Version','version'}).upper()
    detected=set()
    for el in root.iter():
        for token in _tokens(el):
            f=_family(token)
            if f:detected.add(f)
    for name,marks in {'PMSI':['PMSI','ATIH','CIM-10-FR','CIM10FR'],'GM':['ICD-10-GM','ICD10GM'],'CM':['ICD10CM','ICD-10-CM']}.items():
        if any(mark in metadata for mark in marks):detected.add(name)
    if kind in {'icd10cm.tabular','icd10cm'}:detected.add('CM')
    if terminology=='AUTO':
        national=detected-{'OMS'}
        if len(national)>1:raise ValueError('Plusieurs référentiels nationaux détectés : choisissez explicitement PMSI, GM ou CM.')
        selected=next(iter(national)) if national else ('OMS' if detected=={'OMS'} else 'NON_PRECISE')
    else:selected=terminology
    if selected=='OMS' and detected-{'OMS'}:
        raise ValueError('Fichier national détecté : choisissez son référentiel (PMSI/GM/CM), pas OMS.')
    if selected in {'PMSI','GM','CM'} and detected-{'OMS'} and selected not in detected-{'OMS'} and not chosen_tokens:
        raise ValueError('Le référentiel choisi ne correspond pas à celui détecté dans le fichier.')
    accepted=FAMILIES.get(selected,set())|chosen_tokens
    rows={};languages=set()

    def save(code,name,lang):
        code=str(code or '').strip().upper();name=' '.join(str(name or '').split())
        if not in_scope(code):return
        if not name:raise ValueError('Libellé vide pour '+code)
        if len(name)>500:raise ValueError('Libellé trop long pour '+code)
        if code in rows and rows[code]['name']!=name:raise ValueError('Libellés contradictoires pour '+code+' : préciser la variante.')
        rows[code]={'code':code,'name':name,'language':lang or 'non précisée'}
        languages.add(lang or 'non précisée')

    if kind=='claml':
        for cls in root.iter():
            if _local(cls)!='Class' or not in_scope(cls.get('code','')):continue
            ct=_tokens(cls);known={_family(t) for t in ct}-{None}
            if ct and known and selected in FAMILIES and selected not in known and 'OMS' not in known and not (ct&chosen_tokens):continue
            candidates=[]
            for rubric in cls:
                if _local(rubric)!='Rubric' or rubric.get('kind','').lower()!='preferred':continue
                for label in rubric:
                    if _local(label)!='Label':continue
                    tokens=_tokens(label) or _tokens(rubric) or ct
                    families={_family(t) for t in tokens}-{None}
                    if tokens&chosen_tokens:rank=0
                    elif tokens&accepted:rank=1
                    elif not tokens:rank=2
                    elif families=={'OMS'}:rank=3
                    elif selected=='NON_PRECISE':rank=4
                    else:continue
                    lang=label.get('{http://www.w3.org/XML/1998/namespace}lang',label.get('lang','')).lower()
                    langrank=0 if lang=='fr' or lang.startswith('fr-') else 1
                    candidates.append((rank,langrank,' '.join(''.join(label.itertext()).split()),lang))
            if not candidates:
                if ct and known and selected not in known:continue
                raise ValueError('Aucun libellé preferred compatible pour '+cls.get('code','')+'. Vérifier la variante choisie (ex. FM).')
            best=min((r,l) for r,l,_,_ in candidates)
            labels={(name,lang) for rank,lrank,name,lang in candidates if (rank,lrank)==best}
            names={name for name,_ in labels}
            if len(names)!=1:raise ValueError('Plusieurs libellés préférés pour '+cls.get('code','')+' ; préciser la variante.')
            name,lang=sorted(labels)[0];save(cls.get('code'),name,lang)
    elif kind in {'icd10cm.tabular','icd10cm'}:
        if selected not in {'CM','NON_PRECISE'}:raise ValueError('XML tabulaire ICD-10-CM : choisir CM.')
        selected='CM'
        for diag in root.iter():
            if _local(diag).lower()!='diag':continue
            code=next((x.text for x in diag if _local(x).lower()=='name'),'')
            name=next((''.join(x.itertext()) for x in diag if _local(x).lower()=='desc'),'')
            save(code,name,'en')
    else:raise ValueError('Format non reconnu : fournir un XML ClaML ou un XML tabulaire ICD-10-CM, pas un PDF/ZIP.')
    if not rows:raise ValueError('Aucun code trouvé dans les plages K00–K93 et S30–S39.')
    source='CIM10-'+selected+(' variante '+','.join(sorted(chosen_tokens)) if chosen_tokens else '')
    if 'WIKIPEDIA_CHIRURGIE_GENERALE' in metadata:
        source='Wikipedia-fr-selection-chirurgie-generale'
    return {'rows':[rows[c] for c in sorted(rows)],'source':source,'terminology':selected,'detected':sorted(detected),'languages':sorted(languages),'variant':','.join(sorted(chosen_tokens))}


def parse_oms_claml(data):
    """Compatibilité avec les appels V5 ; le mode OMS strict reste explicite."""
    result=parse_catalogue(data,'OMS')
    if any(not (l=='fr' or l.startswith('fr-')) for l in result['languages']):
        raise ValueError('Libellés OMS français requis.')
    return result['rows']


def import_catalogue(conn,data,terminology='AUTO',variant='',replace_existing=False):
    parsed=parse_catalogue(data,terminology,variant)
    file_digest=hashlib.sha256(data).hexdigest()
    fingerprint=hashlib.sha256((file_digest+'|'+parsed['source']+'|replace='+str(bool(replace_existing))).encode()).hexdigest()
    base={k:parsed[k] for k in ('source','terminology','detected','languages','variant')}
    base.update({'sha256':file_digest,'import_key':fingerprint,'total_source':len(parsed['rows'])})
    if conn.execute('SELECT 1 FROM cim10_imports WHERE sha256=?',(fingerprint,)).fetchone():
        return dict(base,added=0,matched=0,updated=0,conflicts=[],already_imported=True)
    added=matched=updated=0;conflicts=[]
    for row in parsed['rows']:
        code,name=row['code'],row['name']
        existing=conn.execute('SELECT id,name,source FROM hospit_motifs WHERE code=?',(code,)).fetchone()
        if existing:
            matched+=1
            if existing[1]!=name or existing[2]!=parsed['source']:
                conflicts.append({'code':code,'local':existing[1],'imported':name,'imported_source':parsed['source']})
                if replace_existing:
                    conn.execute('UPDATE hospit_motifs SET name=?,source=? WHERE id=?',(name,parsed['source'],existing[0]));updated+=1
            continue
        same=conn.execute("SELECT id FROM hospit_motifs WHERE name=? COLLATE NOCASE AND code='' ORDER BY id LIMIT 1",(name,)).fetchone()
        if same:conn.execute('UPDATE hospit_motifs SET code=?,source=? WHERE id=?',(code,parsed['source'],same[0]))
        else:conn.execute('INSERT INTO hospit_motifs(name,code,source,position) VALUES (?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM hospit_motifs))',(name,code,parsed['source']))
        added+=1
    conn.execute('INSERT INTO cim10_imports(sha256,source,rows_count) VALUES (?,?,?)',(fingerprint,parsed['source'],len(parsed['rows'])))
    return dict(base,added=added,matched=matched,updated=updated,conflicts=conflicts,already_imported=False)

# Catalogue cible : seuls les codes tumoraux sélectionnés sont ajoutés au périmètre.
_CATALOGUE_CHIRURGIE_GENERALE_CODES_V54 = frozenset(['C15', 'C15.0', 'C15.1', 'C15.2', 'C15.3', 'C15.4', 'C15.5', 'C15.8', 'C15.9', 'C16', 'C16.0', 'C16.1', 'C16.2', 'C16.3', 'C16.4', 'C16.5', 'C16.6', 'C16.8', 'C16.9', 'C17', 'C17.0', 'C17.1', 'C17.2', 'C17.3', 'C17.8', 'C17.9', 'C18', 'C18.0', 'C18.1', 'C18.2', 'C18.3', 'C18.4', 'C18.5', 'C18.6', 'C18.7', 'C18.8', 'C18.9', 'C19', 'C20', 'C21', 'C21.0', 'C21.1', 'C21.2', 'C21.8', 'C22', 'C22.0', 'C22.1', 'C22.2', 'C22.3', 'C22.4', 'C22.7', 'C22.9', 'C23', 'C24', 'C24.0', 'C24.1', 'C24.8', 'C24.9', 'C25', 'C25.0', 'C25.1', 'C25.2', 'C25.3', 'C25.4', 'C25.7', 'C25.8', 'C25.9', 'C26', 'C26.0', 'C26.1', 'C26.8', 'C26.9', 'C43', 'C43.5', 'C43.6', 'C43.7', 'C43.8', 'C43.9', 'C44', 'C44.5', 'C44.6', 'C44.7', 'C44.8', 'C44.9', 'C45.1', 'C48', 'C48.0', 'C48.1', 'C48.2', 'C48.8', 'C49', 'C49.4', 'C49.40', 'C49.48', 'C49.5', 'C49.50', 'C49.6', 'C49.8', 'C49.9', 'C50', 'C50.0', 'C50.1', 'C50.2', 'C50.3', 'C50.4', 'C50.5', 'C50.6', 'C50.8', 'C50.9', 'C73', 'C74', 'C74.0', 'C74.1', 'C74.9', 'C75.0', 'C76.2', 'C76.3', 'C77.2', 'C77.3', 'C77.4', 'C77.5', 'C78.4', 'C78.5', 'C78.6', 'C78.7', 'C78.8', 'C79.2', 'C79.7', 'C80', 'D00.1', 'D00.2', 'D01', 'D01.0', 'D01.1', 'D01.2', 'D01.3', 'D01.4', 'D01.5', 'D01.7', 'D01.9', 'D03', 'D03.5', 'D03.6', 'D03.7', 'D03.8', 'D03.9', 'D04', 'D04.5', 'D04.6', 'D04.7', 'D04.8', 'D04.9', 'D05', 'D05.0', 'D05.1', 'D05.7', 'D05.9', 'D09.3', 'D12', 'D12.0', 'D12.1', 'D12.2', 'D12.3', 'D12.4', 'D12.5', 'D12.6', 'D12.7', 'D12.8', 'D12.9', 'D13', 'D13.0', 'D13.1', 'D13.2', 'D13.3', 'D13.4', 'D13.5', 'D13.6', 'D13.7', 'D13.9', 'D13.90', 'D17', 'D18', 'D20', 'D21', 'D22', 'D23', 'D24', 'D34', 'D35', 'D36', 'D37', 'D44', 'D48'])

# Complément infectieux ciblé : principal + optionnel, sans élargissement à tout A00–B99.
_INFECTIONS_CHIRURGIE_CIBLEES_V55 = frozenset(['A01.0', 'A04.7', 'A06.0', 'A06.3', 'A06.4', 'A18.2', 'A18.3', 'A18.4', 'A42.1', 'A48.0', 'A63.0', 'A63.00', 'B47', 'B67', 'B77'])
