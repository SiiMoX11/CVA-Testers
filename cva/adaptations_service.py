"""Adaptations du service : phrase d'antécédent et drains structurés."""
import datetime as dt
import json
import secrets
import re
import sqlite3
from decimal import Decimal, InvalidOperation
from flask import request, jsonify, g


def previous_stay_sentence(previous, conn):
    motif = str(previous['motif'] or '').strip()
    sex = str(previous['sexe'] or '').upper() if 'sexe' in previous.keys() else ''
    prefix = 'Hospitalisée' if sex == 'F' else 'Hospitalisé'
    start = str(previous['date_entree'] or '')
    end = str(previous['sortie_date'] or '')
    try:
        admission = dt.date.fromisoformat(start)
        month = admission.strftime('%m/%Y')
    except ValueError:
        admission = None
        month = None
    text = prefix + ' dans notre service' + (' en ' + month if month else ' (mois non renseigné)') + ' pour ' + motif
    operations = []
    try:
        discharge = dt.date.fromisoformat(end)
    except ValueError:
        discharge = None
    if admission and discharge and discharge >= admission:
        rows = conn.execute("""SELECT r.intitule, t.name AS type_name FROM cro_reports r
            LEFT JOIN cro_types t ON t.id=r.type_id
            WHERE r.patient_id=? AND r.date>=? AND r.date<=? ORDER BY r.date,r.id""",
            (previous['id'], start, end)).fetchall()
        for row in rows:
            name = str(row['type_name'] or '').strip()
            if not name or name.casefold()=='autre':
                name = str(row['intitule'] or '').strip()
            if name and name.casefold() not in [n.casefold() for n in operations]:
                operations.append(name[0].lower()+name[1:])
    if len(operations)==1:
        name=operations[0]
        feminine = name.split()[0].casefold().endswith(('ectomie','tomie','stomie','plastie','pexie')) or name.casefold().startswith(('cure ', 'résection ', 'anastomose ', 'réparation '))
        text += ', bénéficiant d’une ' + name if feminine else ', bénéficiant de l’intervention suivante : ' + name
    elif operations:
        text += ', bénéficiant des interventions suivantes : ' + ' ; '.join(operations)
    return text + '.'


def drain_decode(row):
    try:
        payload=json.loads(row['details'] or '')
        return payload if isinstance(payload,dict) and payload.get('schema')=='drain-series-v1' else None
    except (TypeError,ValueError):
        return None


def drain_reading(data, author, stamp, ident=None):
    date=str(data.get('date') or '').strip()
    dt.date.fromisoformat(date)
    raw=str(data.get('quantity') if data.get('quantity') is not None else '').strip().replace(',','.')
    if len(raw)>32 or not re.fullmatch(r'(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)',raw):
        raise ValueError('Quantité du drain invalide.')
    try:
        number=Decimal(raw)
    except InvalidOperation:
        raise ValueError('Quantité du drain invalide.')
    if not number.is_finite() or number<0 or number>100000:
        raise ValueError('Quantité invalide : saisir un nombre positif ou nul, au plus 100000 cc.')
    aspect=str(data.get('aspect') or '').strip()
    if len(aspect)>120:
        raise ValueError('Aspect trop long (120 caractères maximum).')
    return dict(id=ident or secrets.token_hex(12),date=date,quantity=format(number,'f'),aspect=aspect,author=author,updated_at=stamp)


def drain_content(payload):
    readings=sorted(payload['readings'],key=lambda r:r['date'])
    return 'Drain '+payload['location']+' : '+' → '.join(r['quantity']+' cc'+(' '+r['aspect'] if r['aspect'] else '') for r in readings)


def register_drains(app,db,login_required,now,log):
    @app.post('/api/patients/<int:pid>/drains')
    @login_required
    def api_create_drain(pid):
        if not db().execute('SELECT 1 FROM patients WHERE id=?',(pid,)).fetchone():
            return jsonify(error='Patient introuvable.'),404
        data=request.get_json(silent=True) or {}
        location=str(data.get('location') or '').strip()
        if not location or len(location)>160:
            return jsonify(error='Précisez l’emplacement du drain (160 caractères maximum).'),400
        stamp=now()
        try:
            reading=drain_reading(data,g.user['full_name'],stamp)
        except (TypeError,ValueError) as exc:
            return jsonify(error=str(exc)),400
        payload=dict(schema='drain-series-v1',location=location,readings=[reading])
        content=drain_content(payload)
        cur=db().execute("""INSERT INTO entries(patient_id,kind,category,date,title,content,details,done,author,created_at,updated_at)
            VALUES (?,'clinique','Drains',?,'',?,?,0,?,?,?)""",
            (pid,reading['date'],content,json.dumps(payload,ensure_ascii=False),g.user['full_name'],stamp,stamp))
        log(pid,'Drain ajouté',content)
        db().commit()
        return jsonify(id=cur.lastrowid),201

    @app.post('/api/drains/<int:eid>/releves')
    @login_required
    def api_add_drain_reading(eid):
        return update(eid,True)

    @app.put('/api/drains/<int:eid>/releves/<rid>')
    @login_required
    def api_edit_drain_reading(eid,rid):
        return update(eid,False,rid)

    def update(eid,append,rid=None):
        conn=db()
        conn.execute('BEGIN IMMEDIATE')
        try:
            row=conn.execute("SELECT * FROM entries WHERE id=? AND kind='clinique' AND category='Drains'",(eid,)).fetchone()
            payload=drain_decode(row) if row else None
            if not payload:
                conn.rollback()
                return jsonify(error='Drain structuré introuvable.'),404
            data=request.get_json(silent=True) or {}
            stamp=now()
            reading=drain_reading(data,g.user['full_name'],stamp,None if append else rid)
            if append:
                payload['readings'].append(reading)
            else:
                old=next((r for r in payload['readings'] if r['id']==rid),None)
                if old is None:
                    conn.rollback()
                    return jsonify(error='Relevé introuvable.'),404
                reading['created_at']=old.get('created_at',old.get('updated_at',''))
                payload['readings']=[reading if r['id']==rid else r for r in payload['readings']]
                if 'location' in data:
                    location=str(data['location'] or '').strip()
                    if not location or len(location)>160:
                        raise ValueError('Emplacement invalide.')
                    payload['location']=location
            payload['readings'].sort(key=lambda r:r['date'])
            content=drain_content(payload)
            conn.execute('UPDATE entries SET date=?,content=?,details=?,updated_at=? WHERE id=?',
                (payload['readings'][0]['date'],content,json.dumps(payload,ensure_ascii=False),stamp,eid))
            log(row['patient_id'],'Relevé de drain ajouté' if append else 'Relevé de drain modifié',content)
            conn.commit()
            return jsonify(ok=True)
        except (ValueError,TypeError) as exc:
            conn.rollback()
            return jsonify(error=str(exc)),400
        except Exception:
            conn.rollback()
            raise
