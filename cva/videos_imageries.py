import os
import json
import secrets
import hashlib
import sqlite3
import time
import datetime as dt
from flask import request,jsonify
from werkzeug.utils import secure_filename
from .storage import StorageError

TYPES={'TDM','IRM','Autre'}
PLANES={'Axiale','Sagittale','Coronale','Autre'}
PHASES={'Sans injection','Artériel','Veineux','Portal','Tardif','Autre'}
MIMES={'.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.m4v':'video/mp4','.ogg':'video/ogg','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png'}

def normalize_imaging(p):
    if not isinstance(p,dict) or p.get('schema')!='imaging-v1':raise ValueError('Métadonnées d’imagerie invalides.')
    kind=p.get('type')
    if kind not in TYPES:raise ValueError('Type d’imagerie invalide.')
    result={'schema':'imaging-v1','type':kind}
    for field,choices in [('plane',PLANES),('phase',PHASES)]:
        value=p.get(field) or ''
        if kind!='Autre' and value not in choices:raise ValueError('Coupe et temps requis pour TDM et IRM.')
        if value and value not in choices:raise ValueError('Coupe ou temps invalide.')
        result[field]=value
    for field in ['custom_title','custom_plane','custom_phase','notes']:
        value=p.get(field) or ''
        if not isinstance(value,str) or len(value)>(4000 if field=='notes' else 200):raise ValueError('Texte invalide : '+field)
        result[field]=value.strip()
    if kind=='Autre' and not result['custom_title']:raise ValueError('Précisez le titre du type Autre.')
    return result


def imaging_title(p):return p['custom_title'] if p['type']=='Autre' else p['type']

def stream_size(file):
    """Taille d'un fichier envoyé (flux Werkzeug), sans le charger en mémoire."""
    stream=file.stream
    try:
        stream.seek(0,2);size=stream.tell();stream.seek(0);return size
    except (AttributeError,OSError,ValueError):
        return None

def register_imaging(app,db,login_required,db_path,storage,now=None,log=None):
    """`storage` : FileStorage (clés ``imaging/<nom>``) — Cloudflare R2 ou disque local."""
    conn=sqlite3.connect(db_path)
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS imaging_media_tickets(ticket_hash TEXT PRIMARY KEY,entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,session_token TEXT NOT NULL REFERENCES tokens(token) ON DELETE CASCADE,expires_at REAL NOT NULL)")
        conn.commit()
    finally:conn.close()

    @app.post('/api/patients/<int:pid>/imaging/<int:eid>/replace')
    @login_required
    def api_replace_imaging_file(pid,eid):
        if not db().execute("SELECT 1 FROM entries WHERE id=? AND patient_id=? AND kind='video'",(eid,pid)).fetchone():
            return jsonify(error='Imagerie introuvable pour ce patient.'),404
        file=request.files.get('file')
        if not file or not file.filename:return jsonify(error='Choisissez le nouveau fichier.'),400
        extension=os.path.splitext(file.filename)[1].lower()
        if extension not in MIMES:return jsonify(error='Format de vidéo/image non pris en charge.'),400
        try:
            meta=normalize_imaging(json.loads(request.form.get('details') or ''))
            date=request.form.get('date') or '';dt.date.fromisoformat(date)
        except (ValueError,TypeError) as exc:return jsonify(error=str(exc)),400
        filename=str(pid)+'_'+secrets.token_hex(16)+extension
        key='imaging/'+filename
        old_name=None
        if not stream_size(file):return jsonify(error='Le fichier est vide.'),400
        try:storage.save(key,file.stream,MIMES[extension])
        except StorageError as exc:return jsonify(error=str(exc)),503
        try:
            db().execute('BEGIN IMMEDIATE')
            existing=db().execute("SELECT * FROM entries WHERE id=? AND patient_id=? AND kind='video'",(eid,pid)).fetchone()
            if not existing:
                db().rollback();storage.delete(key);return jsonify(error='Imagerie introuvable.'),404
            old_name=existing['content'] if existing['category']=='fichier' else None
            stamp=now() if now else dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
            db().execute("UPDATE entries SET category='fichier',content=?,title=?,date=?,details=?,updated_at=? WHERE id=?",(filename,imaging_title(meta),date,json.dumps(meta,ensure_ascii=False),stamp,eid))
            db().execute('DELETE FROM imaging_media_tickets WHERE entry_id=?',(eid,))
            if log:log(pid,'Fichier imagerie remplacé','Entrée '+str(eid)+' — '+imaging_title(meta))
            db().commit()
        except Exception:
            db().rollback()
            storage.delete(key)
            raise
        if old_name and old_name!=filename and secure_filename(old_name)==old_name:
            used=db().execute("SELECT 1 FROM entries WHERE category='fichier' AND content=? LIMIT 1",(old_name,)).fetchone()
            if not used:storage.delete('imaging/'+old_name)
        return jsonify(id=eid,replaced=True)

    @app.before_request
    def validate_imaging_request():
        if request.endpoint not in {'api_upload','api_add_entry','api_update_entry'}:return None
        @login_required
        def check():
            if request.endpoint=='api_upload':
                if not db().execute('SELECT 1 FROM patients WHERE id=?',(request.view_args['pid'],)).fetchone():return jsonify(error='Patient introuvable.'),404
                raw=request.form.get('details') or ''
                try:meta=json.loads(raw)
                except (ValueError,TypeError):return None
                if not isinstance(meta,dict) or meta.get('schema')!='imaging-v1':return None
                try:normalize_imaging(meta);dt.date.fromisoformat(request.form.get('date') or '')
                except (ValueError,TypeError) as exc:return jsonify(error=str(exc)),400
                return None
            data=request.get_json(silent=True) or {};kind=data.get('kind');existing=None
            if request.endpoint=='api_update_entry':
                existing=db().execute('SELECT * FROM entries WHERE id=?',(request.view_args['eid'],)).fetchone()
                kind=existing['kind'] if existing else None
            if kind!='video':return None
            try:meta=json.loads(data.get('details') or '')
            except (ValueError,TypeError):return None
            if not isinstance(meta,dict) or meta.get('schema')!='imaging-v1':return None
            try:meta=normalize_imaging(meta);dt.date.fromisoformat(data.get('date') or '')
            except (ValueError,TypeError) as exc:return jsonify(error=str(exc)),400
            if not existing or existing['category']!='fichier':
                from urllib.parse import urlsplit
                url=data.get('content') or ''
                if not isinstance(url,str):return jsonify(error='Lien invalide.'),400
                try:parsed=urlsplit(url)
                except ValueError:return jsonify(error='Lien invalide.'),400
                if parsed.scheme not in {'http','https'} or not parsed.netloc:return jsonify(error='Le lien doit être une URL HTTP ou HTTPS valide.'),400
            data['title']=imaging_title(meta)
            data['details']=json.dumps(meta,ensure_ascii=False)
            return None
        return check()

    @app.post('/api/patients/<int:pid>/imaging/<int:eid>/ticket')
    @login_required
    def api_imaging_ticket(pid,eid):
        row=db().execute("SELECT * FROM entries WHERE id=? AND patient_id=? AND kind='video' AND category='fichier'",(eid,pid)).fetchone()
        if not row:return jsonify(error='Fichier introuvable pour ce patient.'),404
        filename=secure_filename(row['content'] or '')
        extension=os.path.splitext(filename)[1].lower()
        if extension not in MIMES or not filename or not storage.exists('imaging/'+filename):return jsonify(error='Fichier absent ou format non supporté.'),404
        token=request.headers.get('Authorization','')[7:]
        ticket=secrets.token_urlsafe(32);digest=hashlib.sha256(ticket.encode()).hexdigest()
        db().execute('DELETE FROM imaging_media_tickets WHERE expires_at<?',(time.time(),))
        db().execute('INSERT INTO imaging_media_tickets VALUES(?,?,?,?)',(digest,eid,token,time.time()+3600))
        db().commit()
        return jsonify(ticket=ticket,media_type='image' if MIMES[extension].startswith('image/') else 'video')

    @app.get('/api/patients/<int:pid>/imaging/<int:eid>/media')
    def api_imaging_media(pid,eid):
        supplied=request.args.get('ticket','')
        if not supplied:return jsonify(error='Accès non autorisé.'),401
        digest=hashlib.sha256(supplied.encode()).hexdigest()
        row=db().execute("SELECT e.* FROM imaging_media_tickets m JOIN tokens t ON t.token=m.session_token JOIN users u ON u.id=t.user_id JOIN entries e ON e.id=m.entry_id WHERE m.ticket_hash=? AND m.expires_at>? AND e.id=? AND e.patient_id=? AND e.kind='video' AND e.category='fichier' AND u.active=1",(digest,time.time(),eid,pid)).fetchone()
        if not row:return jsonify(error='Accès expiré. Rouvrez le lecteur.'),401
        filename=secure_filename(row['content'] or '');extension=os.path.splitext(filename)[1].lower()
        if extension not in MIMES or not filename:return jsonify(error='Format non supporté.'),415
        try:
            response=storage.response('imaging/'+filename,MIMES[extension],as_attachment=request.args.get('download')=='1',download_name=secure_filename((row['title'] or 'imagerie')+('_'+str(row['date']) if row['date'] else '')+extension))
        except StorageError as exc:return jsonify(error=str(exc)),503
        # Cache privé : autorise le navigateur à conserver les segments vidéo (lecture fluide) sans cache partagé.
        response.headers['Cache-Control']='private, max-age=3600';response.headers['X-Content-Type-Options']='nosniff';response.headers['Referrer-Policy']='no-referrer'
        return response
