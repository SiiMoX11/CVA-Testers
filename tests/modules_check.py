"""Tests isolés des modules (SQLite + substituts Flask). Lancer seul depuis la racine : python -B tests/modules_check.py"""
import ast,datetime,importlib.util,json,pathlib,sqlite3,sys,tempfile,types
root=pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0,str(root))
class Request:
    payload={};endpoint='';view_args={}
    def get_json(self,silent=True):return self.payload
request=Request();g=types.SimpleNamespace(user={'role':'medecin','full_name':'Alice','username':'alice'})
flask=types.ModuleType('flask');flask.request=request;flask.g=g;flask.jsonify=lambda **kw:kw
sys.modules['flask']=flask
storage=types.ModuleType('cva.storage');storage.StorageError=type('StorageError',(Exception,),{});sys.modules['cva.storage']=storage
import cva.adaptations_service as svc
import cva.documents_obsrv as docs
import cva.bilans_tools as labs
class App:
    def __init__(self):self.routes={};self.before=[]
    def route(self,path,method):
        def add(fn):self.routes[method,path]=fn;return fn
        return add
    def get(self,p):return self.route(p,'GET')
    def post(self,p):return self.route(p,'POST')
    def put(self,p):return self.route(p,'PUT')
    def delete(self,p):return self.route(p,'DELETE')
    def before_request(self,fn):self.before.append(fn);return fn
class Store:
    def __init__(self):self.deleted=[]
    def delete(self,key):self.deleted.append(key)
checks=[]
with tempfile.TemporaryDirectory() as tmp:
    path=str(pathlib.Path(tmp)/'test.sqlite');conn=sqlite3.connect(path);conn.row_factory=sqlite3.Row
    tree=ast.parse((root/'cva'/'core.py').read_text(encoding='utf-8'));schema=next(ast.literal_eval(n.value) for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='SCHEMA' for t in n.targets))
    conn.executescript(schema)
    conn.execute("ALTER TABLE patients ADD COLUMN sexe TEXT DEFAULT ''")
    conn.executescript("CREATE TABLE cro_types(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE cro_reports(id INTEGER PRIMARY KEY,patient_id INTEGER,date TEXT,intitule TEXT,type_id INTEGER);")
    conn.execute("INSERT INTO patients(id,nom,ip,motif,date_entree,sortie_date,sexe,created_at) VALUES (1,'TEST','1','appendicite','2026-10-01','2026-10-12','F','t')")
    conn.executemany('INSERT INTO cro_types VALUES (?,?)',[(1,'Appendicectomie'),(2,'Colectomie')])
    conn.executemany('INSERT INTO cro_reports VALUES (?,?,?,?,?)',[(1,1,'2026-09-01','Ancienne colectomie',2),(2,1,'2026-10-03','Appendicectomie',1),(3,1,'2026-11-01','Future colectomie',2)])
    conn.commit();p=conn.execute('SELECT * FROM patients WHERE id=1').fetchone()
    assert svc.previous_stay_sentence(p,conn)=='Hospitalisée dans notre service en 10/2026 pour appendicite, bénéficiant d’une appendicectomie.'
    conn.execute("UPDATE patients SET sexe='M' WHERE id=1");assert svc.previous_stay_sentence(conn.execute('SELECT * FROM patients WHERE id=1').fetchone(),conn).startswith('Hospitalisé ')
    missing=dict(p);missing['date_entree']='';assert 'bénéficiant' not in svc.previous_stay_sentence(missing,conn)
    checks.append('Antécédent : sexe, mois, motif, type CRO ; opérations hors séjour exclues, date absente sans attribution CRO')
    app=App();store=Store();stamp='2026-11-07 12:00:00'
    now=lambda:stamp;db=lambda:conn;login=lambda f:f;log=lambda *a:None
    svc.register_drains(app,db,login,now,log)
    create=app.routes['POST','/api/patients/<int:pid>/drains'];add=app.routes['POST','/api/drains/<int:eid>/releves'];edit=app.routes['PUT','/api/drains/<int:eid>/releves/<rid>']
    request.payload={'location':'Douglas','date':'2026-11-06','quantity':'100','aspect':'SH'};result,status=create(1);assert status==201;eid=result['id']
    request.payload={'date':'2026-11-07','quantity':'50','aspect':'SH'};assert add(eid)['ok']
    row=conn.execute('SELECT * FROM entries WHERE id=?',(eid,)).fetchone();assert row['content']=='Drain Douglas : 100 cc SH → 50 cc SH'
    payload=svc.drain_decode(row);rid=payload['readings'][1]['id']
    request.payload={'date':'2026-11-07','quantity':'0','aspect':'Séreux','location':'Douglas'};assert edit(eid,rid)['ok']
    assert '0 cc Séreux' in conn.execute('SELECT content FROM entries WHERE id=?',(eid,)).fetchone()[0]
    request.payload={'date':'2026-11-05','quantity':'75,5','aspect':'SH'};assert add(eid)['ok'];assert conn.execute('SELECT content FROM entries WHERE id=?',(eid,)).fetchone()[0].startswith('Drain Douglas : 75.5 cc')
    for bad in ['-1','NaN','1e100000000','', '100001']:
        request.payload={'date':'2026-11-07','quantity':bad,'aspect':''};assert add(eid)[1]==400
    request.payload={'date':'2026-11-07','quantity':'1'};assert add(9999)[1]==404
    checks.append('Drains : création, ajouts, cinétique, ordre des dates, zéro, décimales, modification ciblée, rejets invalides')
    docs.register_documents(app,db,login,now,log,path,store)
    def document(at):
        c=conn.execute("INSERT INTO patient_documents(patient_id,title,original_name,storage_name,extension,size_bytes,document_date,uploaded_at,author) VALUES (1,'Titre','a.pdf',?,'.pdf',100,'2020-01-01',?,'Bob')",(str(conn.execute('SELECT COUNT(*) FROM patient_documents').fetchone()[0])+'.pdf',at));conn.commit();return c.lastrowid
    delete=app.routes['DELETE','/api/patients/<int:pid>/documents/<int:did>'];rename=app.routes['PUT','/api/patients/<int:pid>/documents/<int:did>'];listing=app.routes['GET','/api/patients/<int:pid>/documents']
    fresh=document('2026-11-06 12:00:01');assert delete(1,fresh)['ok']
    boundary=document('2026-11-06 12:00:00');assert delete(1,boundary)['ok']
    old=document('2026-11-06 11:59:59');assert delete(1,old)[1]==403
    g.user['role']='moderateur';assert delete(1,old)[1]==403
    request.payload={'title':'Nouveau titre'};assert rename(1,old)['ok'];assert conn.execute('SELECT uploaded_at FROM patient_documents WHERE id=?',(old,)).fetchone()[0]=='2026-11-06 11:59:59'
    assert next(d for d in listing(1)['documents'] if d['id']==old)['can_delete'] is False
    assert delete(2,old)[1]==404
    g.user['role']='admin';assert delete(1,old)['ok'];g.user['role']='medecin'
    checks.append('Documents : 24 h incluses, refus après 24 h même modérateur, admin autorisé, titre sans renouveler le délai, patient contrôlé')
    cfg={'enabled':True,'minimum_age':19,'version':'test','parameters':{'Hb':{'unit':'g/dL','min':1,'max':99}}}
    labs.reference_profile=lambda:cfg
    new=['Lymphocytes','Cholesterol','HDL','LDL','Triglycerides','Ph','Ca','PusProfondPrelevement','PusProfondResultat','PusSuperficielPrelevement','PusSuperficielResultat']
    values={k:'Exemple' for k in new};values['Hb']='13'
    p=labs.normalize_v2({'values':values},{'age':30});assert set(values)<=set(labs.KEYS)
    assert p['references']['Hb']['active'] and all(not p['references'][k]['active'] for k in new)
    assert 'Pus profond' in labs.summary_v2(p) and 'Bilan lipidique' in labs.summary_v2(p)
    assert labs.validate({'schema':'bilan-v1','values':{k:{'value':'exemple'} for k in new}})
    try:labs.normalize_v2({'values':{'invented':'1'}},{'age':30});raise AssertionError('Unknown accepted')
    except ValueError:pass
    checks.append('Bilans : nouveaux champs acceptés V1/V2 et résumés, normes nouvelles non inventées, paramètres inconnus rejetés')
    labs.register_bilans(app,db,login,now,log)
    first={'schema':'bilan-simple-v2','values':{'Hb':'13'},'references':{'Hb':{'unit':'g/dL'}},'reference_version':'test'}
    conn.execute("INSERT INTO entries(patient_id,kind,date,content,details,created_at,updated_at) VALUES (1,'bilan','2026-11-07','Hb',?,'t','t')",(json.dumps(first),));conn.commit()
    request.endpoint='api_add_entry';request.view_args={'pid':1};request.payload={'kind':'bilan','date':'2026-11-07','details':json.dumps({'schema':'bilan-simple-v2','values':{'PusProfondResultat':'Résultat du laboratoire'}})}
    merged=app.before[-1]();assert merged[0]['merged']
    final=json.loads(conn.execute("SELECT details FROM entries WHERE kind='bilan'").fetchone()[0]);assert final['values']['Hb']=='13' and final['values']['PusProfondResultat']=='Résultat du laboratoire'
    checks.append('Bilans : complément même date conserve Hb et ajoute le résultat de pus')
print(json.dumps({'result':'PASS','checks':checks,'limitations':'Substituts Flask, pas de test HTTP/navigateur/stockage réel'},ensure_ascii=False,indent=2))
