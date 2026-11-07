"""Préparation des 22 chapitres Wikipédia et opérations explicites sur le catalogue V5."""
import datetime as dt
import hashlib
from html import unescape
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from urllib.parse import urlencode, quote, unquote, urlparse, parse_qs
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
import uuid

INDEX='Liste_de_codes_CIM-10'
HOST='https://fr.wikipedia.org'
CONFIRM='SUPPRIMER TOUS LES MOTIFS'
CHAPTERS={1:('A00','B99'),2:('C00','D48'),3:('D50','D89'),4:('E00','E90'),5:('F00','F99'),6:('G00','G99'),7:('H00','H59'),8:('H60','H95'),9:('I00','I99'),10:('J00','J99'),11:('K00','K93'),12:('L00','L99'),13:('M00','M99'),14:('N00','N99'),15:('O00','O99'),16:('P00','P96'),17:('Q00','Q99'),18:('R00','R99'),19:('S00','T98'),20:('V01','Y98'),21:('Z00','Z99'),22:('U00','U99')}


def _json_write(path,data):
    temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    temp.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8');temp.replace(path)


def _clean(text):
    text=unescape(text).replace('\xa0',' ')
    text=re.sub(r'\[modifier[^\]]*\]|\[\s*\d+\s*\]','',text,flags=re.I)
    return ' '.join(text.split()).strip()


class PageParser(HTMLParser):
    """Texte propre à chaque puce (pas ses enfants), paragraphes/titres et cellules de tableau."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links=[];self.lines=[];self.stack=[];self.ignore=0
        self.capture=None;self.captag=None;self.cells=None;self.cell=None
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if self.ignore:
            if tag not in {'br','hr','img','meta','link','input','wbr','source','area','base','embed','param','track'}:self.ignore+=1
            return
        if tag in {'script','style','sup','nav'} or 'mw-editsection' in attrs.get('class',''):
            self.ignore=1;return
        if tag=='a' and attrs.get('href'):self.links.append(attrs['href'])
        if tag=='li':self.stack.append([])
        if tag in {'p','h2','h3','h4','h5','h6'}:
            self.capture=[];self.captag=tag
        if tag=='tr':self.cells=[]
        if tag in {'td','th'} and self.cells is not None:self.cell=[]
        if tag=='br':
            if self.stack:self.stack[-1].append('\n')
            if self.capture is not None:self.capture.append('\n')
            if self.cell is not None:self.cell.append(' ')
    def handle_data(self,text):
        if self.ignore:return
        if self.stack:self.stack[-1].append(text)
        if self.capture is not None:self.capture.append(text)
        if self.cell is not None:self.cell.append(text)
    def handle_endtag(self,tag):
        if self.ignore:self.ignore-=1;return
        if tag=='li' and self.stack:
            raw=''.join(self.stack.pop())
            self.lines.extend(raw.splitlines())
        if tag==self.captag and self.capture is not None:
            self.lines.extend(''.join(self.capture).splitlines());self.capture=None;self.captag=None
        if tag in {'td','th'} and self.cell is not None:
            self.cells.append(_clean(''.join(self.cell)));self.cell=None
        if tag=='tr' and self.cells is not None:
            self.lines.append(' '.join(self.cells));self.cells=None


def _roman(text):
    values={'I':1,'V':5,'X':10};total=prev=0
    for c in reversed(text):
        value=values.get(c,0);total+=-value if value<prev else value;prev=max(prev,value)
    return total


def discover_chapters(links):
    found={}
    for title in links:
        title=unquote(str(title)).replace('_',' ')
        m=re.match(r'^CIM-10 Chapitre\s+(\d+|[IVX]+)(?:\s|:)',title,re.I)
        if not m:continue
        number=int(m[1]) if m[1].isdigit() else _roman(m[1].upper())
        if number in CHAPTERS:
            found.setdefault(number,title)
    missing=sorted(set(CHAPTERS)-set(found))
    if missing:raise ValueError('Liens des chapitres absents du sommaire : '+', '.join(map(str,missing))+'. Aucune base modifiée.')
    return found


def _http(url):
    ua=os.environ.get('CVA_WIKIPEDIA_USER_AGENT','ChirVisceraleTools-CIM10Importer/5.3 (local catalogue extraction)')
    for attempt in range(3):
        try:
            request=Request(url,headers={'User-Agent':ua,'Accept':'application/json,text/html;q=0.9','Accept-Language':'fr'})
            with urlopen(request,timeout=40) as response:
                data=response.read(30000001)
                if len(data)>30000000:raise ValueError('Page trop volumineuse pour cet import.')
                return data
        except HTTPError as exc:
            if exc.code not in {429,500,502,503,504} or attempt==2:raise
        except URLError:
            if attempt==2:raise
        time.sleep(2*(attempt+1))


def download_page(title):
    url=HOST+'/wiki/'+quote(title.replace(' ','_'),safe=':_(),')
    api=HOST+'/w/api.php?'+urlencode({'action':'parse','page':title.replace('_',' '),'prop':'text|links|revid','format':'json','formatversion':2})
    try:
        result=json.loads(_http(api).decode('utf-8'))
        if 'error' in result:raise ValueError(str(result['error'].get('info','Erreur API Wikipédia')))
        parsed=result['parse'];html=parsed['text']
        if isinstance(html,dict):html=html['*']
        links=[x.get('title',x.get('*','')) for x in parsed.get('links',[])]
        revision=parsed.get('revid')
    except (HTTPError,URLError,ValueError,KeyError,TypeError,json.JSONDecodeError):
        html=_http(url).decode('utf-8');parser=PageParser();parser.feed(html)
        links=[]
        for href in parser.links:
            link=urlparse(href)
            if link.netloc and link.netloc!='fr.wikipedia.org':continue
            if link.path.startswith('/wiki/'):links.append(unquote(link.path[len('/wiki/'):]))
            elif link.path.endswith('/index.php'):
                title_value=parse_qs(link.query).get('title',[])
                if title_value:links.append(title_value[0])
        revision=None
    return {'html':html,'links':links,'url':url,'revision':revision,'html_sha256':hashlib.sha256(html.encode()).hexdigest()}


def extract_entries(html,chapter):
    parser=PageParser();parser.feed(html)
    low,high=CHAPTERS[chapter];found={};warnings=[]
    for raw in parser.lines:
        line=_clean(raw)
        # Code seul/catégorie suivi d'un intitulé ; les plages ne sont pas des motifs.
        m=re.match(r'^\(?\s*([A-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?)(?:\.\-)?\s*[\*†‡]?\s*\)?\s*(.*)$',line)
        if not m:continue
        code,tail=m.groups()
        if not low<=code[:3]<=high:continue
        if re.match(r'^\s*[-–—/]\s*[A-Z][0-9]{2}',tail):continue
        tail=re.sub(r'^[\s:;–—-]+','',tail).strip()
        if not tail or re.match(r'^(?:et|à|a)\s+[A-Z][0-9]{2}',tail,re.I):continue
        if len(tail)>500:raise ValueError('Intitulé trop long pour '+code+' : structure de page à vérifier.')
        if code in found:
            if found[code]['name']!=tail:
                warnings.append({'code':code,'retained':found[code]['name'],'other':tail,'note':'Première occurrence retenue ; vérifier la page.'})
            continue
        found[code]={'code':code,'name':tail,'source_name':tail,'chapter':chapter,'derivation':'extraction_html_wikipedia'}
    if chapter==11:
        modifiers={'0':'Aigu avec hémorragie','1':'Aigu avec perforation','2':'Aigu avec hémorragie et perforation','3':'Aigu sans hémorragie ni perforation','4':'Chronique ou non précisé, avec hémorragie','5':'Chronique ou non précisé, avec perforation','6':'Chronique ou non précisé, avec hémorragie et perforation','7':'Chronique sans hémorragie ni perforation','9':'Non précisé comme étant aigu ou chronique, sans hémorragie ni perforation'}
        plain=_clean(html).lower()
        # Développer uniquement si les catégories et la consigne des modificateurs figurent dans la source.
        if 'modificateur' in plain and all(c in found for c in ['K25','K26','K27','K28']):
            for parent in ['K25','K26','K27','K28']:
                for suffix,label in modifiers.items():
                    code=parent+'.'+suffix
                    if code not in found:found[code]={'code':code,'name':found[parent]['name']+' — '+label,'source_name':label,'chapter':chapter,'derivation':'developpement_modificateurs_K25_K28'}
        if 'K70.0' in found and 'cirrhose' in found['K70.0']['name'].lower() and 'graiss' in found['K70.0']['name'].lower():
            found['K70.0']['name']='Stéatose hépatique alcoolique';found['K70.0']['derivation']='correction_K70_0_documentee_OMS'
            warnings.append({'code':'K70.0','note':'Libellé source conservé dans source_name ; correction en stéatose hépatique alcoolique selon les règles OMS (volume 2, 2010).','url':'https://icd.who.int/browse10/Content/statichtml/ICD10Volume2_en_2010.pdf'})
    if not found:raise ValueError('Aucun code individuel extrait du chapitre '+str(chapter)+'. Page non détaillée ou structure différente : aucun import automatique.')
    return [found[c] for c in sorted(found)],warnings


def collect_catalogue(progress=lambda info:None):
    index=download_page(INDEX);chapters=discover_chapters(index['links'])
    all_rows={};sources=[];warnings=[];counts={}
    for number,title in sorted(chapters.items()):
        progress({'done':number-1,'total':22,'chapter':number,'title':title,'message':'Lecture du chapitre '+str(number)+'/22…'})
        page=download_page(title);rows,review=extract_entries(page['html'],number)
        for row in rows:
            if row['code'] in all_rows:raise ValueError('Code présent dans plusieurs chapitres : '+row['code'])
            row['source_url']=page['url'];all_rows[row['code']]=row
        counts[str(number)]=len(rows);warnings.extend(review)
        sources.append({'chapter':number,'title':title,'url':page['url'],'revision_id':page['revision'],'html_sha256':page['html_sha256'],'history_url':HOST+'/w/index.php?'+urlencode({'title':title,'action':'history'}),'codes':len(rows)})
        progress({'done':number,'total':22,'chapter':number,'count':len(all_rows),'message':'Chapitre '+str(number)+' extrait : '+str(len(rows))+' codes.'})
        time.sleep(1)
    return {'schema':'cim10-wikipedia-all-v1','metadata':{'source':'Wikipédia français — 22 chapitres','source_index':index['url'],'downloaded_at':dt.datetime.now(dt.timezone.utc).isoformat(),'chapters':sources,'counts':counts,'total_codes':len(all_rows),'warnings':warnings,'authors':'Contributeurs des pages sources ; historiques accessibles depuis chaque page.','license':'CC BY-SA 4.0','license_url':'https://creativecommons.org/licenses/by-sa/4.0/','notice':'Données de Wikipédia, pas un export officiel OMS ni une garantie d’exhaustivité d’une édition de CIM-10. Catégories/sous-catégories présentes sur les pages uniquement. Modificateurs K25–K28 développés si indiqués, correction K70.0 documentée.'},'entries':[all_rows[c] for c in sorted(all_rows)]}


def validate_dataset(data):
    if data.get('schema')!='cim10-wikipedia-all-v1':raise ValueError('Format du catalogue préparé incorrect.')
    rows=data.get('entries',[])
    if not rows or len({row.get('code') for row in rows})!=len(rows):raise ValueError('Catalogue vide ou codes dupliqués.')
    present=set()
    for row in rows:
        chapter=int(row.get('chapter',0));code=str(row.get('code',''));name=str(row.get('name',''))
        if chapter not in CHAPTERS or not re.fullmatch(r'[A-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?',code):raise ValueError('Code/chapitre invalide.')
        low,high=CHAPTERS[chapter]
        if not low<=code[:3]<=high or not name or len(name)>500:raise ValueError('Entrée hors périmètre ou libellé invalide : '+code)
        present.add(chapter)
    if present!=set(CHAPTERS):raise ValueError('Les 22 chapitres doivent être représentés. Aucun remplacement effectué.')
    return rows


def apply_dataset(conn,data,mode='add'):
    rows=validate_dataset(data)
    if mode not in {'add','replace'}:raise ValueError('Mode d’import invalide.')
    if mode=='replace':
        conn.execute('UPDATE patients SET motif_id=NULL WHERE motif_id IS NOT NULL')
        conn.execute('DELETE FROM hospit_motifs');conn.execute('DELETE FROM cim10_imports')
    added=linked=preserved=0
    for row in rows:
        if conn.execute('SELECT 1 FROM hospit_motifs WHERE code=?',(row['code'],)).fetchone():preserved+=1;continue
        same=conn.execute("SELECT id FROM hospit_motifs WHERE name=? COLLATE NOCASE AND code='' ORDER BY id LIMIT 1",(row['name'],)).fetchone()
        if same:
            conn.execute('UPDATE hospit_motifs SET code=?,source=? WHERE id=?',(row['code'],'Wikipedia-fr-chapitre-'+str(row['chapter']),same[0]));linked+=1
        else:
            conn.execute('INSERT INTO hospit_motifs(name,code,source,position) VALUES (?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM hospit_motifs))',(row['name'],row['code'],'Wikipedia-fr-chapitre-'+str(row['chapter'])));added+=1
    digest=hashlib.sha256(json.dumps(data,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
    conn.execute('INSERT OR IGNORE INTO cim10_imports(sha256,source,rows_count) VALUES (?,?,?)',(digest,'Wikipedia français — tous chapitres',len(rows)))
    return {'added':added,'linked':linked,'preserved':preserved,'total':len(rows),'mode':mode}


def register_wikipedia_motifs(app,db,staff_required,log,db_path):
    from flask import jsonify,request,send_file
    base=Path(db_path).resolve().parent
    jobs=base/'cim10_wikipedia_preparations';jobs.mkdir(exist_ok=True)
    lock=jobs/'preparation.lock'

    def paths(jid):
        if not re.fullmatch(r'[a-f0-9]{32}',jid):raise ValueError('Identifiant de préparation invalide.')
        return jobs/(jid+'.status.json'),jobs/(jid+'.data.json')

    def backup():
        folder=base/'sauvegardes_motifs';folder.mkdir(exist_ok=True)
        path=folder/('avant_operation_'+dt.datetime.now().strftime('%Y%m%d_%H%M%S_%f')+'.db')
        with sqlite3.connect(db_path) as src,sqlite3.connect(path) as dst:src.backup(dst)
        return str(path)

    def worker(jid):
        status_path,data_path=paths(jid)
        state={'state':'running','job_id':jid,'done':0,'total':22}
        def progress(info):state.update(info);_json_write(status_path,state)
        try:
            data=collect_catalogue(progress);validate_dataset(data);_json_write(data_path,data)
            state.update(state='ready',done=22,total=22,count=len(data['entries']),counts=data['metadata']['counts'],warnings=len(data['metadata']['warnings']),message='Catalogue préparé. Aucun motif supprimé ni importé pour l’instant.')
        except Exception as exc:state.update(state='error',message=str(exc))
        finally:
            _json_write(status_path,state)
            try:
                if lock.read_text().strip()==jid:lock.unlink()
            except FileNotFoundError:pass

    @app.post('/api/motifs/wikipedia/preparer')
    @staff_required
    def api_prepare_wikipedia():
        try:
            if lock.exists() and time.time()-lock.stat().st_mtime>7200:lock.unlink()
            fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY)
        except FileExistsError:
            return jsonify(error='Une préparation est déjà en cours ; utilisez Reprendre la préparation.'),409
        jid=uuid.uuid4().hex
        with os.fdopen(fd,'w') as stream:stream.write(jid)
        status_path,_=paths(jid);_json_write(status_path,{'state':'running','job_id':jid,'done':0,'total':22,'message':'Lecture du sommaire Wikipédia…'})
        threading.Thread(target=worker,args=(jid,),daemon=True).start()
        return jsonify(job_id=jid),202

    @app.get('/api/motifs/wikipedia/<jid>')
    @staff_required
    def api_wikipedia_status(jid):
        try:
            status_path,_=paths(jid)
            if not status_path.exists():return jsonify(error='Préparation introuvable.'),404
            state=json.loads(status_path.read_text(encoding='utf-8'))
            if state.get('state')=='running' and time.time()-status_path.stat().st_mtime>600:
                state.update(state='error',message='Préparation interrompue ou serveur redémarré. Relancez une préparation ; aucun catalogue modifié.')
                _json_write(status_path,state)
                try:
                    if lock.read_text().strip()==jid:lock.unlink()
                except FileNotFoundError:pass
            return jsonify(**state)
        except ValueError as exc:return jsonify(error=str(exc)),400

    @app.get('/api/motifs/wikipedia/<jid>/donnees')
    @staff_required
    def api_wikipedia_data(jid):
        try:
            _,data_path=paths(jid)
            if not data_path.exists():return jsonify(error='Catalogue pas encore disponible.'),409
            return send_file(data_path,mimetype='application/json',as_attachment=True,download_name='cim10_wikipedia_22_chapitres.json')
        except ValueError as exc:return jsonify(error=str(exc)),400

    @app.post('/api/motifs/supprimer-tout')
    @staff_required
    def api_purge_motifs():
        d=request.get_json(silent=True) or {}
        if d.get('confirmation')!=CONFIRM:return jsonify(error='Confirmation exacte requise : '+CONFIRM),400
        try:
            conn=db();count=conn.execute('SELECT COUNT(*) FROM hospit_motifs').fetchone()[0]
            saved=backup()
            conn.execute('UPDATE patients SET motif_id=NULL WHERE motif_id IS NOT NULL')
            conn.execute('DELETE FROM hospit_motifs');conn.execute('DELETE FROM cim10_imports')
            log(None,'Catalogue motifs : suppression totale',str(count)+' motifs ; sauvegarde '+saved)
            conn.commit()
            return jsonify(deleted=count,backup=saved)
        except Exception as exc:
            db().rollback();return jsonify(error='Suppression annulée : '+str(exc)),400

    @app.post('/api/motifs/wikipedia/<jid>/importer')
    @staff_required
    def api_import_all_wikipedia(jid):
        d=request.get_json(silent=True) or {};mode=d.get('mode','add')
        if mode=='replace' and d.get('confirmation')!=CONFIRM:return jsonify(error='Confirmation exacte requise : '+CONFIRM),400
        try:
            _,data_path=paths(jid)
            if not data_path.exists():return jsonify(error='Préparation non terminée.'),409
            data=json.loads(data_path.read_text(encoding='utf-8'));validate_dataset(data)
            saved=backup();result=apply_dataset(db(),data,mode)
            log(None,'Catalogue motifs : import Wikipédia 22 chapitres',str(result)+' ; sauvegarde '+saved)
            db().commit();result['backup']=saved
            return jsonify(**result)
        except Exception as exc:
            db().rollback();return jsonify(error='Import annulé : '+str(exc)),400
