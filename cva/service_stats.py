"""Statistiques de service V1 : migration additive et journalisation SQLite."""
import sqlite3
import datetime as dt
import statistics
import re
from collections import Counter, defaultdict
from flask import request, jsonify

SCHEMA = """
CREATE TABLE IF NOT EXISTS service_stats_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS service_stays(
 id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
 admission TEXT, discharge TEXT, mode TEXT, motif TEXT, code TEXT, ordonnance TEXT,
 origin TEXT NOT NULL DEFAULT 'prospectif', planned INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS service_one_open ON service_stays(patient_id) WHERE discharge IS NULL;
CREATE TABLE IF NOT EXISTS service_treatment_history(
 id INTEGER PRIMARY KEY, entry_id INTEGER, patient_id INTEGER, title TEXT, content TEXT,
 done INTEGER, event TEXT, observed_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS service_patient_insert AFTER INSERT ON patients BEGIN
 INSERT INTO service_stays(patient_id,admission,motif,code) VALUES(NEW.id,NEW.date_entree,NEW.motif,NEW.motif_code);
END;
CREATE TRIGGER IF NOT EXISTS service_patient_close AFTER UPDATE ON patients
 WHEN NEW.status='sorti' AND OLD.status='hospitalise' BEGIN
 UPDATE service_stays SET admission=NEW.date_entree,discharge=NEW.sortie_date,mode=NEW.sortie_mode,
 motif=NEW.motif,code=NEW.motif_code,ordonnance=NEW.sortie_ordonnance
 WHERE patient_id=NEW.id AND discharge IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS service_patient_reopen AFTER UPDATE ON patients
 WHEN NEW.status='hospitalise' AND OLD.status='sorti' BEGIN
 INSERT INTO service_stays(patient_id,admission,motif,code) VALUES(NEW.id,NEW.date_entree,NEW.motif,NEW.motif_code);
END;
CREATE TRIGGER IF NOT EXISTS service_patient_edit AFTER UPDATE ON patients
 WHEN NEW.status=OLD.status BEGIN
 UPDATE service_stays SET admission=NEW.date_entree,motif=NEW.motif,code=NEW.motif_code,
 discharge=CASE WHEN NEW.status='sorti' THEN NEW.sortie_date ELSE NULL END,
 mode=CASE WHEN NEW.status='sorti' THEN NEW.sortie_mode ELSE NULL END,
 ordonnance=CASE WHEN NEW.status='sorti' THEN NEW.sortie_ordonnance ELSE NULL END
 WHERE id=(SELECT MAX(id) FROM service_stays WHERE patient_id=NEW.id);
END;
"""

def install(conn, stamp):
    conn.executescript(SCHEMA)
    if not conn.execute("SELECT 1 FROM service_stats_meta WHERE key='started'").fetchone():
        conn.execute("INSERT INTO service_stats_meta VALUES('started',?)", (stamp,))
        conn.execute("""INSERT INTO service_stays(patient_id,admission,discharge,mode,motif,code,ordonnance,origin)
 SELECT id,date_entree,CASE WHEN status='sorti' THEN NULLIF(sortie_date,'') ELSE NULL END,
 sortie_mode,motif,motif_code,sortie_ordonnance,'repris_partiel' FROM patients""")
        conn.execute("""INSERT INTO service_treatment_history(entry_id,patient_id,title,content,done,event,observed_at)
 SELECT id,patient_id,title,content,done,'reprise',? FROM entries WHERE kind='traitement'""",(stamp,))
    for event, timing, prefix in [('creation','INSERT','NEW'),('modification','UPDATE','NEW'),('suppression','DELETE','OLD')]:
        conn.executescript(f"""CREATE TRIGGER IF NOT EXISTS service_ttt_{event} AFTER {timing} ON entries
 WHEN {prefix}.kind='traitement' BEGIN
 INSERT INTO service_treatment_history(entry_id,patient_id,title,content,done,event,observed_at)
 VALUES({prefix}.id,{prefix}.patient_id,{prefix}.title,{prefix}.content,{prefix}.done,'{event}',datetime('now'));
 END;""")
    conn.commit()

def date(value):
    try: return dt.date.fromisoformat(str(value or '')[:10])
    except ValueError: return None

def dead(mode):
    return str(mode or '').strip().casefold() in ('décès','deces')

def register_service_stats(app, db, staff_required, now, db_path):
    conn=sqlite3.connect(db_path)
    try: install(conn, now())
    finally: conn.close()

    @app.get('/api/service-stats')
    @staff_required
    def service_stats():
        today=date(now())
        try:
            start=dt.date.fromisoformat(request.args.get('from') or today.replace(day=1).isoformat())
            end=dt.date.fromisoformat(request.args.get('to') or today.isoformat())
            if start>end or (end-start).days>3660 or end>today: raise ValueError()
        except ValueError:
            return jsonify(error='Période invalide : fin non future, 10 ans maximum.'),400
        stays=[dict(r) for r in db().execute('SELECT * FROM service_stays ORDER BY patient_id,admission,id')]
        grouped=defaultdict(list)
        for s in stays: grouped[s['patient_id']].append(s)
        def in_period(d,a,b): return d is not None and a<=d<=b
        def summary(a,b):
            admitted=[s for s in stays if in_period(date(s['admission']),a,b)]
            closed=[s for s in stays if in_period(date(s['discharge']),a,b)]
            deaths=sum(dead(s['mode']) for s in closed)
            lengths=[(date(s['discharge'])-date(s['admission'])).days for s in closed if date(s['admission']) and date(s['discharge'])>=date(s['admission'])]
            readmissions=[]
            for ss in grouped.values():
                for i,s in enumerate(ss):
                    if i and in_period(date(s['admission']),a,b): readmissions.append(s)
            result=dict(admissions=len(admitted),sorties=len(closed),deces=deaths,
                mortalite=round(deaths/len(closed)*100,2) if closed else None,
                dms=round(statistics.mean(lengths),2) if lengths else None,
                mediane=statistics.median(lengths) if lengths else None,durees_valides=len(lengths),
                readmissions=len(readmissions),patients_readmis=len({s['patient_id'] for s in readmissions}),
                sejours_repris=sum(s['origin']!='prospectif' for s in admitted+closed))
            for days in (7,30):
                eligible=0; numerator=0;pending=0
                for s in closed:
                    if dead(s['mode']): continue
                    out=date(s['discharge'])
                    if out+dt.timedelta(days=days)>today: pending+=1;continue
                    eligible+=1
                    ss=grouped[s['patient_id']];i=ss.index(s)
                    nxt=ss[i+1] if i+1<len(ss) else None
                    if nxt and date(nxt['admission']) and 0<=(date(nxt['admission'])-out).days<=days: numerator+=1
                result['j'+str(days)]=dict(n=numerator,denominateur=eligible,suivi_incomplet=pending,taux=round(numerator/eligible*100,2) if eligible else None)
            return result
        monthly=[]; cursor=start.replace(day=1)
        while cursor<=end:
            nxt=(cursor.replace(day=28)+dt.timedelta(days=4)).replace(day=1)
            monthly.append(dict(periode=cursor.strftime('%Y-%m'),**summary(max(start,cursor),min(end,nxt-dt.timedelta(days=1)))))
            cursor=nxt
        annual=[dict(periode=str(y),**summary(max(start,dt.date(y,1,1)),min(end,dt.date(y,12,31)))) for y in range(start.year,end.year+1)]
        current=[dict(r) for r in db().execute("SELECT * FROM patients WHERE status='hospitalise'")]
        # Identité conservatrice : titre exact normalisé en espaces, jamais la fréquence ni les triangles.
        treatments=defaultdict(set)
        for r in db().execute("SELECT e.patient_id,e.title FROM entries e JOIN patients p ON p.id=e.patient_id WHERE p.status='hospitalise' AND e.kind='traitement' AND COALESCE(e.done,0)=0"):
            treatments[' '.join((r['title'] or 'Sans intitulé').split())].add(r['patient_id'])
        ordos=defaultdict(set)
        for s in stays:
            if not in_period(date(s['discharge']),start,end): continue
            for line in str(s['ordonnance'] or '').splitlines():
                match=re.fullmatch(r'(.+?)\s*[—–-]\s*Posologie\s*:.*',line.strip())
                if match: ordos[match.group(1).strip()].add(s['id'])
        def counts(items): return [dict(libelle=k,n=len(v)) for k,v in sorted(items.items(),key=lambda kv:(-len(kv[1]),kv[0]))]
        operations=[dict(r) for r in db().execute("SELECT r.*,t.name AS type_name FROM cro_reports r LEFT JOIN cro_types t ON t.id=r.type_id WHERE r.date>=? AND r.date<=?",(start.isoformat(),end.isoformat()))]
        opcounts=Counter(r['type_name'] or 'Sans type' for r in operations)
        delays=[];ambiguous=0
        for op in operations:
            d=date(op['date']);matches=[s for s in grouped[op['patient_id']] if date(s['admission']) and date(s['admission'])<=d and (not date(s['discharge']) or d<=date(s['discharge']))]
            if len(matches)==1: delays.append((d-date(matches[0]['admission'])).days)
            else: ambiguous+=1
        closed=[s for s in stays if in_period(date(s['discharge']),start,end)]
        span=dt.timedelta(days=(end-start).days+1)
        return jsonify(debut=start.isoformat(),fin=end.isoformat(),started=db().execute("SELECT value FROM service_stats_meta WHERE key='started'").fetchone()[0],
            total=summary(start,end),precedente=summary(start-span,end-span),mensuel=monthly,annuel=annual,
            presents=len(current),hors_service=sum(bool(p['hors_service']) for p in current),traitements=counts(treatments),ordonnances=counts(ordos),
            modes=dict(Counter(s['mode'] or 'Non renseigné' for s in closed)),
            motifs=dict(Counter((s['code'] or 'Sans CIM-10')+' — '+(s['motif'] or 'Non renseigné') for s in stays if in_period(date(s['admission']),start,end))),
            operations=dict(opcounts),delai_operatoire_moyen=round(statistics.mean(delays),2) if delays else None,delais_valides=len(delays),cro_non_relies=ambiguous,
            completude=dict(presents=len(current),sans_motif=sum(not p['motif'] for p in current),sans_cim10=sum(not p['motif_code'] for p in current),sans_date_entree=sum(not date(p['date_entree']) for p in current)),
            limites=['Historique antérieur à la migration partiel : séjours écrasés non récupérables.',
            'Réadmissions observées uniquement dans ce service et pour le même dossier patient ; programmées/non programmées non renseignées.',
            'Traitements : photographie actuelle indépendante du filtre ; changements conservés à partir de la migration, historique mensuel non affiché.',
            'Ordonnances : nombre de séjours avec médicament ; seules les lignes structurées « médicament — Posologie : … » sont comptées.',
            'Occupation historique indisponible : capacité disponible et mouvements de lits non historisés.',
            'Durées calculées en jours calendaires ; taux bruts descriptifs non ajustés au risque.'])
