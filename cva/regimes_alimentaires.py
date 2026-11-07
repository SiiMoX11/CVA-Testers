"""Régime alimentaire individuel — aucune suggestion clinique automatique."""
import sqlite3
from flask import request,jsonify,g

REGIMES=[('RN','RN — Régime normal'),('RD','RD — Régime diabétique'),('RSR','RSR — Régime sans résidus'),('ET','E/T — Eau / tisane'),('SOUPE','Soupe'),('ET_SOUPE','E/T/Soupe — Eau / tisane / soupe'),('AUTRE','Autre — Texte libre')]

def initialize_regimes(path):
    conn=sqlite3.connect(path)
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("""CREATE TABLE IF NOT EXISTS patient_regimes(
            patient_id INTEGER PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
            code TEXT NOT NULL DEFAULT '',texte TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',updated_by TEXT NOT NULL DEFAULT '')""")
        conn.commit()
    finally:conn.close()

def clean_regime(data):
    if not isinstance(data,dict):raise ValueError('Données invalides.')
    code=data.get('code','');texte=data.get('texte','')
    if not isinstance(code,str) or code not in {'',*(k for k,_ in REGIMES)}:raise ValueError('Choisissez un régime de la liste.')
    if not isinstance(texte,str) or len(texte)>1000:raise ValueError('Texte limité à 1000 caractères.')
    texte=texte.strip() if code=='AUTRE' else ''
    if code=='AUTRE' and not texte:raise ValueError('Précisez le régime choisi dans Autre.')
    return code,texte

def register_regimes(app,db,login_required,now,log,db_path):
    initialize_regimes(db_path)
    @app.get('/api/patients/<int:pid>/regime')
    @login_required
    def api_patient_regime_get(pid):
        if not db().execute('SELECT 1 FROM patients WHERE id=?',(pid,)).fetchone():return jsonify(error='Patient introuvable.'),404
        row=db().execute('SELECT code,texte,updated_at FROM patient_regimes WHERE patient_id=?',(pid,)).fetchone()
        return jsonify(regime=dict(row) if row else dict(code='',texte='',updated_at=''),options=[dict(code=k,label=v) for k,v in REGIMES])
    @app.put('/api/patients/<int:pid>/regime')
    @login_required
    def api_patient_regime_put(pid):
        if not db().execute('SELECT 1 FROM patients WHERE id=?',(pid,)).fetchone():return jsonify(error='Patient introuvable.'),404
        try:code,texte=clean_regime(request.get_json(silent=True))
        except ValueError as e:return jsonify(error=str(e)),400
        old=db().execute('SELECT code,texte FROM patient_regimes WHERE patient_id=?',(pid,)).fetchone()
        if old and (old['code'],old['texte'])==(code,texte):return jsonify(ok=True)
        stamp=now()
        db().execute("""INSERT INTO patient_regimes(patient_id,code,texte,updated_at,updated_by) VALUES(?,?,?,?,?)
           ON CONFLICT(patient_id) DO UPDATE SET code=excluded.code,texte=excluded.texte,updated_at=excluded.updated_at,updated_by=excluded.updated_by""",(pid,code,texte,stamp,g.user['username']))
        labels=dict(REGIMES)
        def label(c,t):return t if c=='AUTRE' else labels.get(c,'Non renseigné')
        before=label(old['code'],old['texte']) if old else 'Non renseigné'
        log(pid,'Régime alimentaire modifié',before+' → '+label(code,texte))
        db().commit()
        return jsonify(ok=True,updated_at=stamp)
