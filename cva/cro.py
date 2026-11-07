# -*- coding: utf-8 -*-
"""CRO — comptes rendus opératoires, types d'intervention, résidents et statistiques."""
import os
import json
import secrets
import sqlite3
import datetime as dt

from io import BytesIO

from flask import request, jsonify, g

from .documents_obsrv import validate_upload, docx_preview

MAX_SIZE = 25 * 1024 * 1024
DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
DEFAULT_TYPES = [
    'Cholécystectomie cœlioscopique', 'Appendicectomie', 'Cure de hernie inguinale',
    'Cure d’éventration', 'Laparotomie exploratrice', 'Colectomie', 'Gastrectomie',
    'Kyste hydatique du foie', 'Chirurgie proctologique', 'Autre',
]

SCHEMA = '''
CREATE TABLE IF NOT EXISTS cro_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cro_residents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS cro_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  intitule TEXT NOT NULL,
  type_id INTEGER REFERENCES cro_types(id),
  doc_storage TEXT,
  doc_name TEXT,
  doc_size INTEGER,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cro_report_residents (
  report_id INTEGER NOT NULL REFERENCES cro_reports(id) ON DELETE CASCADE,
  resident_id INTEGER NOT NULL REFERENCES cro_residents(id),
  PRIMARY KEY (report_id, resident_id)
);
CREATE INDEX IF NOT EXISTS idx_cro_patient ON cro_reports(patient_id);
CREATE INDEX IF NOT EXISTS idx_cro_resident ON cro_report_residents(resident_id);
'''


def register_cro(app, db, login_required, admin_required, now, log, db_path, storage, staff_required=None):
    """`storage` : instance FileStorage (clés ``cro/<nom>``) — Cloudflare R2 ou disque local."""
    staff_required = staff_required or admin_required
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(SCHEMA)
        if conn.execute('SELECT COUNT(*) FROM cro_types').fetchone()[0] == 0:
            conn.executemany('INSERT INTO cro_types(name, position) VALUES (?,?)',
                             [(n, i) for i, n in enumerate(DEFAULT_TYPES)])
        conn.commit()
    finally:
        conn.close()

    # ------------------------------------------------------------ helpers
    def clean_name(value, label):
        name = ' '.join(str(value or '').split())[:160]
        if not name:
            raise ValueError(label + ' obligatoire.')
        return name

    def valid_date(value):
        value = str(value or '').strip()
        try:
            dt.date.fromisoformat(value)
        except ValueError:
            raise ValueError('Date invalide.')
        return value

    def parse_ids(raw):
        try:
            ids = json.loads(raw or '[]')
        except ValueError:
            raise ValueError('Liste des résidents invalide.')
        if not isinstance(ids, list):
            raise ValueError('Liste des résidents invalide.')
        out = []
        for i in ids:
            try:
                i = int(i)
            except (TypeError, ValueError):
                raise ValueError('Liste des résidents invalide.')
            if i not in out:
                out.append(i)
        return out

    def read_docx():
        file = request.files.get('file')
        if not file or not file.filename:
            return None
        original = os.path.basename(file.filename.replace('\\', '/'))[:240]
        if os.path.splitext(original)[1].lower() != '.docx':
            raise ValueError('Le CRO doit être un document Word .docx (convertir les anciens .doc).')
        data = file.stream.read(MAX_SIZE + 1)
        if not data or len(data) > MAX_SIZE:
            raise ValueError('Document vide ou supérieur à 25 Mo.')
        validate_upload(data, '.docx')
        return original, data

    def save_docx(data):
        name = secrets.token_hex(24) + '.docx'
        storage.save('cro/' + name, data, DOCX_MIME)
        return name

    def remove_file(name):
        if name and os.path.basename(name) == name:
            storage.delete('cro/' + name)

    def report_payload(form, report_id=None):
        date = valid_date(form.get('date'))
        intitule = clean_name(form.get('intitule'), 'Intitulé de l’intervention')
        try:
            type_id = int(form.get('type_id') or 0)
        except ValueError:
            type_id = 0
        row = db().execute('SELECT id, active FROM cro_types WHERE id=?', (type_id,)).fetchone()
        current = db().execute('SELECT type_id FROM cro_reports WHERE id=?', (report_id,)).fetchone() if report_id else None
        if not row or (not row['active'] and not (current and current['type_id'] == type_id)):
            raise ValueError('Choisissez un type d’intervention.')
        ids = parse_ids(form.get('resident_ids'))
        if ids:
            marks = ','.join('?' * len(ids))
            found = db().execute(f'SELECT id, active FROM cro_residents WHERE id IN ({marks})', ids).fetchall()
            old = set()
            if report_id:
                old = {r[0] for r in db().execute('SELECT resident_id FROM cro_report_residents WHERE report_id=?', (report_id,))}
            ok = {r['id'] for r in found if r['active'] or r['id'] in old}
            if len(ok) != len(ids):
                raise ValueError('Résident inconnu ou désactivé.')
        return date, intitule, type_id, ids

    def report_list(where, args):
        rows = db().execute(f'''
            SELECT r.*, t.name AS type_name, p.nom, p.prenom, p.ip
            FROM cro_reports r LEFT JOIN cro_types t ON t.id=r.type_id JOIN patients p ON p.id=r.patient_id
            WHERE {where} ORDER BY r.date DESC, r.id DESC''', args).fetchall()
        result = []
        for r in rows:
            residents = db().execute('''SELECT s.id, s.name FROM cro_report_residents l JOIN cro_residents s ON s.id=l.resident_id
                                       WHERE l.report_id=? ORDER BY s.name''', (r['id'],)).fetchall()
            item = {k: r[k] for k in ('id', 'patient_id', 'date', 'intitule', 'type_id', 'type_name', 'doc_name', 'doc_size', 'author', 'updated_at', 'nom', 'prenom', 'ip')}
            item['has_document'] = bool(r['doc_storage'])
            item['residents'] = [dict(x) for x in residents]
            result.append(item)
        return result

    def get_report(pid, rid):
        return db().execute('SELECT * FROM cro_reports WHERE id=? AND patient_id=?', (rid, pid)).fetchone()

    def error(exc):
        return jsonify(error=str(exc)), 400

    # ------------------------------------------------------------ configuration
    @app.get('/api/cro/config')
    @login_required
    def api_cro_config():
        everything = request.args.get('all') == '1' and g.user['role'] == 'admin'
        flt = '' if everything else ' WHERE active=1'
        types = db().execute('SELECT id, name, active, position FROM cro_types' + flt + ' ORDER BY position, name').fetchall()
        residents = db().execute('''SELECT r.id, r.name, r.active, r.user_id, u.full_name AS user_name, u.username
                                   FROM cro_residents r LEFT JOIN users u ON u.id=r.user_id''' +
                                 (' WHERE r.active=1' if not everything else '') + ' ORDER BY r.name').fetchall()
        out = dict(types=[dict(t) for t in types], residents=[dict(r) for r in residents])
        if everything:
            out['types'] = [dict(t, uses=db().execute('SELECT COUNT(*) FROM cro_reports WHERE type_id=?', (t['id'],)).fetchone()[0]) for t in types]
            out['residents'] = [dict(r, uses=db().execute('SELECT COUNT(*) FROM cro_report_residents WHERE resident_id=?', (r['id'],)).fetchone()[0]) for r in residents]
            out['users'] = [dict(u) for u in db().execute("SELECT id, username, full_name FROM users ORDER BY full_name")]
        return jsonify(out)

    @app.post('/api/cro/types')
    @admin_required
    def api_cro_add_type():
        d = request.get_json(silent=True) or {}
        try:
            name = clean_name(d.get('name'), 'Nom du type')
        except ValueError as exc:
            return error(exc)
        pos = db().execute('SELECT COALESCE(MAX(position),0)+1 FROM cro_types').fetchone()[0]
        try:
            cur = db().execute('INSERT INTO cro_types(name, position) VALUES (?,?)', (name, pos))
        except sqlite3.IntegrityError:
            return jsonify(error='Ce type existe déjà.'), 409
        log(None, 'CRO : type ajouté', name)
        db().commit()
        return jsonify(id=cur.lastrowid), 201

    @app.put('/api/cro/types/<int:tid>')
    @admin_required
    def api_cro_update_type(tid):
        row = db().execute('SELECT * FROM cro_types WHERE id=?', (tid,)).fetchone()
        if not row:
            return jsonify(error='Type introuvable.'), 404
        d = request.get_json(silent=True) or {}
        try:
            name = clean_name(d.get('name', row['name']), 'Nom du type')
        except ValueError as exc:
            return error(exc)
        active = 1 if d.get('active', row['active']) else 0
        try:
            db().execute('UPDATE cro_types SET name=?, active=? WHERE id=?', (name, active, tid))
        except sqlite3.IntegrityError:
            return jsonify(error='Ce type existe déjà.'), 409
        log(None, 'CRO : type modifié', f"{row['name']} → {name}{'' if active else ' (désactivé)'}")
        db().commit()
        return jsonify(ok=True)

    @app.delete('/api/cro/types/<int:tid>')
    @admin_required
    def api_cro_delete_type(tid):
        row = db().execute('SELECT * FROM cro_types WHERE id=?', (tid,)).fetchone()
        if not row:
            return jsonify(error='Type introuvable.'), 404
        if db().execute('SELECT 1 FROM cro_reports WHERE type_id=?', (tid,)).fetchone():
            return jsonify(error='Type déjà utilisé dans des CRO : désactivez-le plutôt (les statistiques sont conservées).'), 409
        db().execute('DELETE FROM cro_types WHERE id=?', (tid,))
        log(None, 'CRO : type supprimé', row['name'])
        db().commit()
        return jsonify(ok=True)

    def resident_user(d):
        uid = d.get('user_id')
        if uid in (None, '', 0, '0'):
            return None
        try:
            uid = int(uid)
        except (TypeError, ValueError):
            raise ValueError('Compte invalide.')
        if not db().execute("SELECT 1 FROM users WHERE id=?", (uid,)).fetchone():
            raise ValueError('Compte introuvable.')
        return uid

    @app.post('/api/cro/residents')
    @admin_required
    def api_cro_add_resident():
        d = request.get_json(silent=True) or {}
        try:
            name = clean_name(d.get('name'), 'Nom du résident')
            uid = resident_user(d)
            cur = db().execute('INSERT INTO cro_residents(name, user_id) VALUES (?,?)', (name, uid))
        except ValueError as exc:
            return error(exc)
        except sqlite3.IntegrityError:
            return jsonify(error='Ce résident ou ce compte est déjà enregistré.'), 409
        log(None, 'CRO : résident ajouté', name)
        db().commit()
        return jsonify(id=cur.lastrowid), 201

    @app.put('/api/cro/residents/<int:rid>')
    @admin_required
    def api_cro_update_resident(rid):
        row = db().execute('SELECT * FROM cro_residents WHERE id=?', (rid,)).fetchone()
        if not row:
            return jsonify(error='Résident introuvable.'), 404
        d = request.get_json(silent=True) or {}
        try:
            name = clean_name(d.get('name', row['name']), 'Nom du résident')
            uid = resident_user(d) if 'user_id' in d else row['user_id']
            active = 1 if d.get('active', row['active']) else 0
            db().execute('UPDATE cro_residents SET name=?, user_id=?, active=? WHERE id=?', (name, uid, active, rid))
        except ValueError as exc:
            return error(exc)
        except sqlite3.IntegrityError:
            return jsonify(error='Ce nom ou ce compte est déjà associé à un autre résident.'), 409
        log(None, 'CRO : résident modifié', f"{row['name']} → {name}{'' if active else ' (désactivé)'}")
        db().commit()
        return jsonify(ok=True)

    @app.delete('/api/cro/residents/<int:rid>')
    @admin_required
    def api_cro_delete_resident(rid):
        row = db().execute('SELECT * FROM cro_residents WHERE id=?', (rid,)).fetchone()
        if not row:
            return jsonify(error='Résident introuvable.'), 404
        if db().execute('SELECT 1 FROM cro_report_residents WHERE resident_id=?', (rid,)).fetchone():
            return jsonify(error='Résident déjà présent dans des CRO : désactivez-le plutôt (les statistiques sont conservées).'), 409
        db().execute('DELETE FROM cro_residents WHERE id=?', (rid,))
        log(None, 'CRO : résident supprimé', row['name'])
        db().commit()
        return jsonify(ok=True)

    # ------------------------------------------------------------ CRO du patient
    @app.get('/api/patients/<int:pid>/cro')
    @login_required
    def api_cro_list(pid):
        if not db().execute('SELECT 1 FROM patients WHERE id=?', (pid,)).fetchone():
            return jsonify(error='Patient introuvable.'), 404
        return jsonify(reports=report_list('r.patient_id=?', (pid,)))

    @app.post('/api/patients/<int:pid>/cro')
    @login_required
    def api_cro_add(pid):
        if not db().execute('SELECT 1 FROM patients WHERE id=?', (pid,)).fetchone():
            return jsonify(error='Patient introuvable.'), 404
        stored = None
        try:
            date, intitule, type_id, ids = report_payload(request.form)
            doc = read_docx()
            t = now()
            if doc:
                stored = save_docx(doc[1])
            cur = db().execute('''INSERT INTO cro_reports(patient_id, date, intitule, type_id, doc_storage, doc_name, doc_size, author, created_at, updated_at)
                                  VALUES (?,?,?,?,?,?,?,?,?,?)''',
                               (pid, date, intitule, type_id, stored, doc[0] if doc else None, len(doc[1]) if doc else None, g.user['full_name'], t, t))
            db().executemany('INSERT INTO cro_report_residents(report_id, resident_id) VALUES (?,?)', [(cur.lastrowid, i) for i in ids])
            log(pid, 'CRO ajouté', f'{date} - {intitule}')
            db().commit()
        except ValueError as exc:
            db().rollback(); remove_file(stored)
            return error(exc)
        except Exception:
            db().rollback(); remove_file(stored)
            raise
        return jsonify(id=cur.lastrowid), 201

    @app.put('/api/patients/<int:pid>/cro/<int:rid>')
    @login_required
    def api_cro_update(pid, rid):
        old = get_report(pid, rid)
        if not old:
            return jsonify(error='CRO introuvable pour ce patient.'), 404
        stored = None
        try:
            date, intitule, type_id, ids = report_payload(request.form, rid)
            doc = read_docx()
            remove_doc = request.form.get('remove_document') == '1'
            sets = dict(date=date, intitule=intitule, type_id=type_id, updated_at=now())
            if doc:
                stored = save_docx(doc[1])
                sets.update(doc_storage=stored, doc_name=doc[0], doc_size=len(doc[1]))
            elif remove_doc:
                sets.update(doc_storage=None, doc_name=None, doc_size=None)
            db().execute(f"UPDATE cro_reports SET {', '.join(k + '=?' for k in sets)} WHERE id=?", [*sets.values(), rid])
            db().execute('DELETE FROM cro_report_residents WHERE report_id=?', (rid,))
            db().executemany('INSERT INTO cro_report_residents(report_id, resident_id) VALUES (?,?)', [(rid, i) for i in ids])
            log(pid, 'CRO modifié', f'{date} - {intitule}')
            db().commit()
        except ValueError as exc:
            db().rollback(); remove_file(stored)
            return error(exc)
        except Exception:
            db().rollback(); remove_file(stored)
            raise
        if (doc or remove_doc) and old['doc_storage']:
            remove_file(old['doc_storage'])
        return jsonify(ok=True)

    @app.delete('/api/patients/<int:pid>/cro/<int:rid>')
    @login_required
    def api_cro_delete(pid, rid):
        old = get_report(pid, rid)
        if not old:
            return jsonify(error='CRO introuvable pour ce patient.'), 404
        db().execute('DELETE FROM cro_reports WHERE id=?', (rid,))
        log(pid, 'CRO supprimé', f"{old['date']} - {old['intitule']}")
        db().commit()
        remove_file(old['doc_storage'])
        return jsonify(ok=True)

    def document_response(pid, rid, download):
        row = get_report(pid, rid)
        if not row or not row['doc_storage']:
            return jsonify(error='Aucun document Word pour ce CRO.'), 404
        key = 'cro/' + row['doc_storage']
        if os.path.basename(row['doc_storage']) != row['doc_storage'] or not storage.exists(key):
            return jsonify(error='Fichier absent du stockage.'), 404
        if download:
            response = storage.response(key, DOCX_MIME, as_attachment=True, download_name=row['doc_name'] or 'CRO.docx')
        else:
            try:
                html = docx_preview(BytesIO(storage.read(key)))
            except Exception:
                return jsonify(error='Impossible de lire ce document Word.'), 422
            response = app.response_class(html, mimetype='text/html')
            response.headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'"
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @app.get('/api/patients/<int:pid>/cro/<int:rid>/preview')
    @login_required
    def api_cro_preview(pid, rid):
        return document_response(pid, rid, False)

    @app.get('/api/patients/<int:pid>/cro/<int:rid>/download')
    @login_required
    def api_cro_download(pid, rid):
        return document_response(pid, rid, True)

    # ------------------------------------------------------------ statistiques
    def period():
        where, args = [], []
        for key, op in (('from', '>='), ('to', '<=')):
            value = request.args.get(key)
            if value:
                where.append(f'r.date {op} ?'); args.append(valid_date(value))
        return where, args

    @app.get('/api/cro/stats')
    @staff_required
    def api_cro_stats():
        try:
            where, args = period()
        except ValueError as exc:
            return error(exc)
        type_id = request.args.get('type_id') or ''
        if type_id:
            try:
                type_id = int(type_id)
            except ValueError:
                return jsonify(error='Type invalide.'), 400
            where.append('r.type_id = ?'); args.append(type_id)
        clause = (' AND ' + ' AND '.join(where)) if where else ''
        rows = db().execute(f'''SELECT s.id AS resident_id, s.name AS resident, s.active, r.type_id, COALESCE(t.name,'Sans type') AS type_name, COUNT(*) AS n
            FROM cro_report_residents l JOIN cro_reports r ON r.id=l.report_id JOIN cro_residents s ON s.id=l.resident_id
            LEFT JOIN cro_types t ON t.id=r.type_id WHERE 1=1{clause}
            GROUP BY s.id, r.type_id ORDER BY s.name''', args).fetchall()
        total = db().execute(f'SELECT COUNT(*) FROM cro_reports r WHERE 1=1{clause}', args).fetchone()[0]
        types = db().execute('SELECT id, name, active FROM cro_types ORDER BY active DESC, position, name').fetchall()
        residents = db().execute('SELECT id, name, active FROM cro_residents WHERE active=1 ORDER BY name').fetchall()
        return jsonify(rows=[dict(r) for r in rows], total_reports=total, types=[dict(t) for t in types],
                       residents=[dict(r) for r in residents], type_id=type_id or None)

    @app.get('/api/cro/my-stats')
    @login_required
    def api_cro_my_stats():
        resident = db().execute('SELECT * FROM cro_residents WHERE user_id=?', (g.user['id'],)).fetchone()
        if not resident:
            return jsonify(resident=None, by_type=[], reports=[])
        try:
            where, args = period()
        except ValueError as exc:
            return error(exc)
        clause = (' AND ' + ' AND '.join(where)) if where else ''
        by_type = db().execute(f'''SELECT COALESCE(t.name,'Sans type') AS type_name, COUNT(*) AS n
            FROM cro_report_residents l JOIN cro_reports r ON r.id=l.report_id LEFT JOIN cro_types t ON t.id=r.type_id
            WHERE l.resident_id=?{clause} GROUP BY r.type_id ORDER BY n DESC, type_name''', [resident['id'], *args]).fetchall()
        reports = report_list(f'r.id IN (SELECT report_id FROM cro_report_residents WHERE resident_id=?){clause}', [resident['id'], *args])
        return jsonify(resident=dict(id=resident['id'], name=resident['name']), by_type=[dict(r) for r in by_type], reports=reports)
