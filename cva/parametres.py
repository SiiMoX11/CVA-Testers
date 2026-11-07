# -*- coding: utf-8 -*-
"""Paramètres du service (admin + modérateur) : motifs d'hospitalisation, catalogue des traitements,
médicaments de l'ordonnance de sortie, médecin responsable du CRH."""
import sqlite3

from flask import request, jsonify

DEFAULT_MOTIFS = [
    'Appendicite aiguë', 'Péritonite', 'Cholécystite aiguë', 'Lithiase vésiculaire', 'Angiocholite',
    'Pancréatite aiguë', 'Occlusion intestinale', 'Hernie inguinale étranglée', 'Hernie de la ligne blanche',
    'Éventration', 'Kyste hydatique du foie', 'Cancer gastrique', 'Cancer colorectal', 'Sigmoïdite',
    'Fistule anale', 'Traumatisme abdominal', 'Ischémie mésentérique',
]


def register_parametres(app, db, login_required, staff_required, log, db_path):
    from .cim10_wikipedia_total import register_wikipedia_motifs
    register_wikipedia_motifs(app, db, staff_required, log, db_path)
    from .cim10_catalogue import migrate_catalogue, validate_code, import_catalogue
    conn = sqlite3.connect(db_path)
    try:
        migrate_catalogue(conn, DEFAULT_MOTIFS)
        conn.commit()
    finally:
        conn.close()

    def payload(d):
        name = ' '.join(str(d.get('name') or '').split())
        if not name or len(name) > 500:
            raise ValueError('Libellé requis (500 caractères maximum).')
        if name.casefold() == 'autre':
            raise ValueError('« Autre » est déjà proposé automatiquement.')
        code = validate_code(d.get('code'))
        return name, code

    @app.get('/api/motifs')
    @login_required
    def api_motifs():
        rows = db().execute("""SELECT m.*, (SELECT COUNT(*) FROM patients p
            WHERE p.motif_id=m.id OR (p.motif_id IS NULL AND p.motif=m.name COLLATE NOCASE AND COALESCE(p.motif_code,'')=m.code)) AS uses
            FROM hospit_motifs m ORDER BY m.name COLLATE NOCASE,m.code""").fetchall()
        return jsonify(motifs=[dict(r) for r in rows])

    @app.post('/api/motifs')
    @staff_required
    def api_add_motif():
        try:
            name, code = payload(request.get_json(silent=True) or {})
            if db().execute('SELECT 1 FROM hospit_motifs WHERE name=? COLLATE NOCASE AND code=?', (name,code)).fetchone():
                return jsonify(error='Ce motif existe déjà.'),409
            cur = db().execute('INSERT INTO hospit_motifs(name,code,position,source) VALUES (?,?,(SELECT COALESCE(MAX(position),0)+1 FROM hospit_motifs),?)', (name,code,'local'))
        except ValueError as exc:
            return jsonify(error=str(exc)),400
        except sqlite3.IntegrityError:
            return jsonify(error='Ce code CIM-10 est déjà présent dans le catalogue.'),409
        log(None,'Paramètres : motif ajouté',name+' '+code)
        db().commit()
        return jsonify(id=cur.lastrowid),201

    @app.put('/api/motifs/<int:mid>')
    @staff_required
    def api_update_motif(mid):
        row = db().execute('SELECT * FROM hospit_motifs WHERE id=?',(mid,)).fetchone()
        if not row:
            return jsonify(error='Motif introuvable.'),404
        d = request.get_json(silent=True) or {}
        try:
            name,code = payload(d)
            duplicate = db().execute('SELECT 1 FROM hospit_motifs WHERE id<>? AND name=? COLLATE NOCASE AND code=?',(mid,name,code)).fetchone()
            if duplicate:
                return jsonify(error='Ce motif existe déjà.'),409
            db().execute('UPDATE hospit_motifs SET name=?,code=?,source=? WHERE id=?',(name,code,'local',mid))
            updated = 0
            if d.get('apply_to_patients'):
                updated = db().execute("""UPDATE patients SET motif=?,motif_code=?,motif_id=? WHERE status='hospitalise'
                    AND (motif_id=? OR (motif_id IS NULL AND motif=? COLLATE NOCASE AND COALESCE(motif_code,'')=?))""",
                    (name,code,mid,mid,row['name'],row['code'])).rowcount
        except ValueError as exc:
            return jsonify(error=str(exc)),400
        except sqlite3.IntegrityError:
            return jsonify(error='Ce code CIM-10 est déjà présent.'),409
        log(None,'Paramètres : motif modifié',row['name']+' → '+name+' '+code)
        db().commit()
        return jsonify(ok=True,patients_updated=updated)

    @app.delete('/api/motifs/<int:mid>')
    @staff_required
    def api_delete_motif(mid):
        row=db().execute('SELECT * FROM hospit_motifs WHERE id=?',(mid,)).fetchone()
        if not row:
            return jsonify(error='Motif introuvable.'),404
        # Conserver le libellé/code historiques ; supprimer seulement la relation catalogue.
        db().execute('UPDATE patients SET motif_id=NULL WHERE motif_id=?',(mid,))
        db().execute('DELETE FROM hospit_motifs WHERE id=?',(mid,))
        log(None,'Paramètres : motif supprimé',row['name'])
        db().commit()
        return jsonify(ok=True)

    @app.post('/api/motifs/import-oms')
    @staff_required
    def api_import_motifs_oms():
        upload=request.files.get('file')
        if not upload:
            return jsonify(error='Choisissez un fichier XML ClaML ou tabulaire ICD-10-CM.'),400
        data=upload.read(80000001)
        if len(data)>80000000:
            return jsonify(error='Fichier limité à 80 Mo.'),400
        try:
            result=import_catalogue(db(),data,terminology=request.form.get('terminology','AUTO'),variant=request.form.get('variant',''),replace_existing=request.form.get('replace_existing')=='1')
            log(None,'Import CIM-10 OMS',str(result))
            db().commit()
        except (ValueError,sqlite3.IntegrityError) as exc:
            db().rollback()
            return jsonify(error=str(exc)),400
        return jsonify(**result)


# ---------------------------------------------------------------- PARAMETRES V2
DEFAULT_MEDICAMENTS = [
    ('Parantal 1 g cp', '1 cp x 3/jour', 'Si douleur'), ('Coparantal 1 g cp', '1 cp x 3/jour', 'Si douleur'),
    ('Augmentin 1 g Sachet', '1 Sachet x 3/jour', '7 jours'), ('Aclav 1 g Sachet', '1 sachet x 3/jour', '8 jours'),
    ('Catex 500 mg cp', '1 cp x 2/jour', '7 jours'), ('Sepcen 500 mg cp', '1 cp x 2/jour', '7 jours'),
    ('Flagyl 500 mg cp', '1 cp x 3/jour', '7 jours'), ('Aulcer 20 mg gél', '1 gél/j le matin à jeun', '1 mois'),
    ('Ixor 20 mg cp', '1 cp/j le matin à jeun', '1 mois'), ('Spasfon 80 mg cp', '2 cp x 3/jour si douleur', '5 jours'),
    ('Dasen 10000 UI cp', '2 cp x 3/jour', '7 jours'), ('Tramal 50 mg gél', '1 gél x 2/jour si douleur', '5 jours'),
    ('Lovenox 4000 UI inj', '1 inj SC/jour', '7 jours'), ('Lovenox 4000 UI inj', '1 inj SC/jour', '14 jours'),
    ('Lovenox 4000 UI inj', '1 inj SC/jour', '21 jours'),
]
DEFAULT_SETTINGS = {'crh_medecin_responsable': 'Pr Bouziane, Pr Jabi, Pr Guellil'}
SETTING_LABELS = {'crh_medecin_responsable': 'Médecin responsable (CRH)'}


def register_parametres_v2(app, db, login_required, staff_required, log, db_path):
    from .traitements_ttt import json_catalogue, GROUPES
    conn = sqlite3.connect(db_path)
    try:
        conn.execute('''CREATE TABLE IF NOT EXISTS ttt_catalogue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nom TEXT NOT NULL UNIQUE COLLATE NOCASE,
            prises INTEGER NOT NULL DEFAULT 0,
            jours INTEGER NOT NULL DEFAULT 6,
            rang INTEGER NOT NULL DEFAULT 5,
            position INTEGER NOT NULL DEFAULT 0)''')
        conn.execute('''CREATE TABLE IF NOT EXISTS sortie_medicaments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nom TEXT NOT NULL,
            posologie TEXT NOT NULL DEFAULT '',
            duree TEXT NOT NULL DEFAULT '',
            position INTEGER NOT NULL DEFAULT 0)''')
        conn.execute('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT \'\')')
        conn.execute('CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY)')
        # Initialisation unique : une liste vidée volontairement n'est pas re-remplie.
        if not conn.execute("SELECT 1 FROM app_migrations WHERE name='parametres_v2_seed'").fetchone():
            if conn.execute('SELECT COUNT(*) FROM ttt_catalogue').fetchone()[0] == 0:
                conn.executemany('INSERT OR IGNORE INTO ttt_catalogue(nom, prises, jours, rang, position) VALUES (?,?,?,?,?)',
                                 [(r['nom'], r['prises'], r['jours'], r['rang'], i) for i, r in enumerate(json_catalogue())])
            if conn.execute('SELECT COUNT(*) FROM sortie_medicaments').fetchone()[0] == 0:
                conn.executemany('INSERT INTO sortie_medicaments(nom, posologie, duree, position) VALUES (?,?,?,?)',
                                 [(*m, i) for i, m in enumerate(DEFAULT_MEDICAMENTS)])
            for key, value in DEFAULT_SETTINGS.items():
                conn.execute('INSERT OR IGNORE INTO app_settings(key, value) VALUES (?,?)', (key, value))
            conn.execute("INSERT INTO app_migrations(name) VALUES ('parametres_v2_seed')")
        conn.commit()
    finally:
        conn.close()

    def text(value, label, limit, required=True):
        value = ' '.join(str(value or '').split())[:limit]
        if required and not value:
            raise ValueError(label + ' obligatoire.')
        return value

    def integer(value, label, low, high):
        try:
            number = int(value)
        except (TypeError, ValueError):
            raise ValueError(label + ' invalide.')
        if not low <= number <= high:
            raise ValueError(f'{label} : entre {low} et {high}.')
        return number

    # ---------- Catalogue des traitements (onglet TRAITEMENT)
    def ttt_payload(d):
        return (text(d.get('nom'), 'Nom du traitement', 160),
                integer(d.get('prises', 0), 'Prises par jour', 0, 24),
                integer(d.get('jours', 6), 'Jours sur la fiche', 1, 6),
                integer(d.get('rang', 5), 'Groupe', 0, len(GROUPES) - 1))

    @app.get('/api/parametres/traitements')
    @login_required
    def api_param_ttt():
        rows = db().execute('SELECT * FROM ttt_catalogue ORDER BY rang, position, id').fetchall()
        uses = {r[0]: r[1] for r in db().execute("SELECT title, COUNT(*) FROM entries WHERE kind='traitement' GROUP BY title").fetchall()}
        return jsonify(groupes=GROUPES, traitements=[dict(r, uses=uses.get(r['nom'], 0)) for r in rows])

    @app.post('/api/parametres/traitements')
    @staff_required
    def api_param_ttt_add():
        try:
            nom, prises, jours, rang = ttt_payload(request.get_json(silent=True) or {})
            cur = db().execute('INSERT INTO ttt_catalogue(nom, prises, jours, rang, position) VALUES (?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM ttt_catalogue))',
                               (nom, prises, jours, rang))
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
        except sqlite3.IntegrityError:
            return jsonify(error='Ce traitement existe déjà.'), 409
        log(None, 'Paramètres : traitement ajouté', nom)
        db().commit()
        return jsonify(id=cur.lastrowid), 201

    @app.put('/api/parametres/traitements/<int:tid>')
    @staff_required
    def api_param_ttt_update(tid):
        row = db().execute('SELECT * FROM ttt_catalogue WHERE id=?', (tid,)).fetchone()
        if not row:
            return jsonify(error='Traitement introuvable.'), 404
        try:
            nom, prises, jours, rang = ttt_payload(request.get_json(silent=True) or {})
            db().execute('UPDATE ttt_catalogue SET nom=?, prises=?, jours=?, rang=? WHERE id=?', (nom, prises, jours, rang, tid))
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
        except sqlite3.IntegrityError:
            return jsonify(error='Ce traitement existe déjà.'), 409
        log(None, 'Paramètres : traitement modifié', row['nom'] + (' → ' + nom if nom != row['nom'] else ''))
        db().commit()
        return jsonify(ok=True)

    @app.delete('/api/parametres/traitements/<int:tid>')
    @staff_required
    def api_param_ttt_delete(tid):
        row = db().execute('SELECT * FROM ttt_catalogue WHERE id=?', (tid,)).fetchone()
        if not row:
            return jsonify(error='Traitement introuvable.'), 404
        # Les traitements déjà prescrits aux patients sont conservés.
        db().execute('DELETE FROM ttt_catalogue WHERE id=?', (tid,))
        log(None, 'Paramètres : traitement supprimé', row['nom'])
        db().commit()
        return jsonify(ok=True)

    # ---------- Médicaments de l'ordonnance de sortie
    def med_payload(d):
        return (text(d.get('nom'), 'Nom du médicament', 160),
                text(d.get('posologie'), 'Posologie', 200, False),
                text(d.get('duree'), 'Durée', 100, False))

    @app.get('/api/parametres/medicaments')
    @login_required
    def api_param_meds():
        rows = db().execute('SELECT * FROM sortie_medicaments ORDER BY nom COLLATE NOCASE, position, id').fetchall()
        return jsonify(medicaments=[dict(r) for r in rows])

    @app.post('/api/parametres/medicaments')
    @staff_required
    def api_param_meds_add():
        try:
            nom, posologie, duree = med_payload(request.get_json(silent=True) or {})
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
        if db().execute('SELECT 1 FROM sortie_medicaments WHERE nom=? COLLATE NOCASE AND posologie=? COLLATE NOCASE AND duree=? COLLATE NOCASE', (nom, posologie, duree)).fetchone():
            return jsonify(error='Ce médicament (même posologie et durée) existe déjà.'), 409
        cur = db().execute('INSERT INTO sortie_medicaments(nom, posologie, duree, position) VALUES (?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM sortie_medicaments))', (nom, posologie, duree))
        log(None, 'Paramètres : médicament d’ordonnance ajouté', f'{nom} — {posologie} — {duree}')
        db().commit()
        return jsonify(id=cur.lastrowid), 201

    @app.put('/api/parametres/medicaments/<int:mid>')
    @staff_required
    def api_param_meds_update(mid):
        row = db().execute('SELECT * FROM sortie_medicaments WHERE id=?', (mid,)).fetchone()
        if not row:
            return jsonify(error='Médicament introuvable.'), 404
        try:
            nom, posologie, duree = med_payload(request.get_json(silent=True) or {})
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
        if db().execute('SELECT 1 FROM sortie_medicaments WHERE id<>? AND nom=? COLLATE NOCASE AND posologie=? COLLATE NOCASE AND duree=? COLLATE NOCASE', (mid, nom, posologie, duree)).fetchone():
            return jsonify(error='Ce médicament (même posologie et durée) existe déjà.'), 409
        db().execute('UPDATE sortie_medicaments SET nom=?, posologie=?, duree=? WHERE id=?', (nom, posologie, duree, mid))
        log(None, 'Paramètres : médicament d’ordonnance modifié', f'{row["nom"]} → {nom} — {posologie} — {duree}')
        db().commit()
        return jsonify(ok=True)

    @app.delete('/api/parametres/medicaments/<int:mid>')
    @staff_required
    def api_param_meds_delete(mid):
        row = db().execute('SELECT * FROM sortie_medicaments WHERE id=?', (mid,)).fetchone()
        if not row:
            return jsonify(error='Médicament introuvable.'), 404
        db().execute('DELETE FROM sortie_medicaments WHERE id=?', (mid,))
        log(None, 'Paramètres : médicament d’ordonnance supprimé', row['nom'])
        db().commit()
        return jsonify(ok=True)

    # ---------- Réglages simples (médecin responsable du CRH)
    @app.get('/api/parametres/reglages')
    @login_required
    def api_param_settings():
        rows = dict(db().execute('SELECT key, value FROM app_settings').fetchall())
        return jsonify(reglages={k: rows.get(k, v) for k, v in DEFAULT_SETTINGS.items()})

    @app.put('/api/parametres/reglages')
    @staff_required
    def api_param_settings_update():
        d = request.get_json(silent=True) or {}
        changed = []
        for key in DEFAULT_SETTINGS:
            if key in d:
                value = ' '.join(str(d.get(key) or '').split())[:300]
                db().execute('INSERT INTO app_settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, value))
                changed.append(f'{SETTING_LABELS[key]} : {value or "(vide)"}')
        if changed:
            log(None, 'Paramètres : réglage modifié', ' ; '.join(changed))
            db().commit()
        return jsonify(ok=True)
