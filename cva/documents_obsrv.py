import os
import datetime as dt
import secrets
import sqlite3
import zipfile
from io import BytesIO
from html import escape
from flask import request, jsonify, g
from .storage import StorageError
from PIL import Image
from docx import Document
from docx.text.paragraph import Paragraph
from docx.table import Table

MAX_SIZE=25*1024*1024
MIMES={'.doc':'application/msword','.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}


def validate_legacy_doc(data):
    """Validation structurelle OLE/Word ; ne lance ni Word ni les macros."""
    import struct
    if len(data) < 512 or data[:8] != b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1':
        raise ValueError('Ce fichier n’est pas un document Word DOC valide.')
    try:
        u16=lambda offset:struct.unpack_from('<H',data,offset)[0]
        u32=lambda offset:struct.unpack_from('<I',data,offset)[0]
        version=u16(26);shift=u16(30)
        if u16(28)!=0xfffe or (version,shift) not in ((3,9),(4,12)) or u16(32)!=6:
            raise ValueError('En-tête OLE invalide.')
        sector_size=1<<shift;limit=(len(data)//sector_size)-1
        if limit < 1:raise ValueError('Document tronqué.')
        end=0xfffffffe;free=0xffffffff
        def sector(number):
            if not 0 <= number < limit:raise ValueError('Secteur OLE invalide.')
            start=(number+1)*sector_size
            return data[start:start+sector_size]
        fat_count=u32(44);difat_count=u32(72)
        if fat_count>limit or difat_count>limit:raise ValueError('Table OLE invalide.')
        difat=[n for n in struct.unpack_from('<109I',data,76) if n!=free]
        current=u32(68);seen=set()
        for _ in range(difat_count):
            if current in seen:raise ValueError('Boucle OLE invalide.')
            seen.add(current);values=struct.unpack('<'+'I'*(sector_size//4),sector(current))
            difat.extend(n for n in values[:-1] if n!=free);current=values[-1]
        if len(difat)<fat_count:raise ValueError('Table OLE incomplète.')
        fat=[]
        for n in difat[:fat_count]:fat.extend(struct.unpack('<'+'I'*(sector_size//4),sector(n)))
        def chain(start,table,max_count):
            result=[];visited=set();current=start
            while current!=end:
                if current in visited or not 0<=current<len(table) or len(result)>=max_count:
                    raise ValueError('Chaîne OLE invalide.')
                visited.add(current);result.append(current);current=table[current]
            return result
        directory=b''.join(sector(n) for n in chain(u32(48),fat,limit))
        entries=[]
        for offset in range(0,len(directory)-127,128):
            name_len=struct.unpack_from('<H',directory,offset+64)[0];kind=directory[offset+66]
            if kind not in (1,2,5):continue
            if not 2<=name_len<=64 or name_len%2:raise ValueError('Répertoire OLE invalide.')
            name=directory[offset:offset+name_len-2].decode('utf-16le')
            start=struct.unpack_from('<I',directory,offset+116)[0]
            size=struct.unpack_from('<Q',directory,offset+120)[0]
            if version==3:size &= 0xffffffff
            if size>MAX_SIZE:raise ValueError('Flux Word trop volumineux.')
            entries.append((name,kind,start,size))
        if any(name.lower() in ('vba','macros','_vba_project','project','projectwm','objectpool','encryptioninfo','encryptedpackage') for name,_,_,_ in entries):
            raise ValueError('Documents Word avec macros, objets intégrés ou chiffrement non acceptés.')
        streams={name:(start,size) for name,kind,start,size in entries if kind==2}
        if 'WordDocument' not in streams or not any(name in streams for name in ('0Table','1Table')):
            raise ValueError('Ce fichier OLE n’est pas un document Word DOC pris en charge.')
        def normal_stream(start,size):
            numbers=chain(start,fat,limit)
            if len(numbers)*sector_size<size:raise ValueError('Flux Word tronqué.')
            return b''.join(sector(n) for n in numbers)[:size]
        start,size=streams['WordDocument']
        if size>=u32(56):word=normal_stream(start,size)
        else:
            root=next((e for e in entries if e[1]==5),None)
            if root is None:raise ValueError('Racine OLE absente.')
            mini_root=normal_stream(root[2],root[3])
            mini_count=u32(64)
            if mini_count>limit:raise ValueError('Mini-table OLE invalide.')
            mini_bytes=b''.join(sector(n) for n in chain(u32(60),fat,limit))
            if len(mini_bytes)!=mini_count*sector_size:raise ValueError('Mini-table OLE tronquée.')
            mini_fat=struct.unpack('<'+'I'*(len(mini_bytes)//4),mini_bytes)
            numbers=chain(start,mini_fat,max(1,len(mini_root)//64))
            if any((n+1)*64>len(mini_root) for n in numbers) or len(numbers)*64<size:
                raise ValueError('Mini-flux Word invalide.')
            word=b''.join(mini_root[n*64:(n+1)*64] for n in numbers)[:size]
        if len(word)<32 or struct.unpack_from('<H',word,0)[0]!=0xa5ec:
            raise ValueError('Flux Word invalide.')
        flags=struct.unpack_from('<H',word,10)[0]
        if flags & (0x0100|0x8000):raise ValueError('Documents Word chiffrés non pris en charge.')
    except (IndexError,KeyError,struct.error,UnicodeError,StopIteration) as exc:
        raise ValueError('Document Word DOC invalide ou tronqué.') from exc

def validate_upload(data,extension):
    if extension=='.pdf':
        if not data.startswith(b'%PDF-'):raise ValueError('Le fichier ne ressemble pas à un PDF valide.')
    elif extension=='.doc':
        validate_legacy_doc(data)
    elif extension=='.docx':
        try:
            with zipfile.ZipFile(BytesIO(data)) as z:
                infos=z.infolist()
                if len(infos)>4000 or sum(i.file_size for i in infos)>100*1024*1024:
                    raise ValueError('Document Word trop volumineux après décompression.')
                if any(i.flag_bits&1 for i in infos):raise ValueError('Documents chiffrés non pris en charge.')
                if 'word/document.xml' not in z.namelist() or '[Content_Types].xml' not in z.namelist():
                    raise ValueError('Ce fichier n’est pas un document DOCX valide.')
                if any('vbaproject' in i.filename.lower() for i in infos):
                    raise ValueError('Les documents contenant des macros ne sont pas acceptés.')
            Document(BytesIO(data))
        except (zipfile.BadZipFile,KeyError) as exc:
            raise ValueError('Document Word invalide.') from exc
    else:
        try:
            with Image.open(BytesIO(data)) as image:
                expected={'.png':'PNG','.jpg':'JPEG','.jpeg':'JPEG','.gif':'GIF','.webp':'WEBP'}[extension]
                if image.format!=expected:raise ValueError('Le format réel de l’image ne correspond pas à son extension.')
                if image.width*image.height>40000000:raise ValueError('Image trop grande (40 mégapixels maximum).')
                image.verify()
        except (OSError,Image.DecompressionBombError) as exc:
            raise ValueError('Image invalide ou trop grande.') from exc

def docx_preview(path):
    document=Document(path);parts=[];chars=0;limited=False
    for child in document.element.body:
        if child.tag.endswith('}p'):
            text=Paragraph(child,document).text
            chars+=len(text)
            parts.append('<p>'+escape(text).replace('\n','<br>')+'</p>')
        elif child.tag.endswith('}tbl'):
            table=Table(child,document)
            if len(table.rows)>1000:limited=True;break
            rows=[]
            for row in table.rows:
                if len(row.cells)>100:limited=True;break
                cells=[]
                for cell in row.cells:
                    text=cell.text;chars+=len(text)
                    cells.append('<td>'+escape(text).replace('\n','<br>')+'</td>')
                rows.append('<tr>'+''.join(cells)+'</tr>')
            parts.append('<table>'+''.join(rows)+'</table>')
        if chars>1000000:limited=True;break
    note='Aperçu local du texte et des tableaux. Les images intégrées et la mise en page exacte de Word ne sont pas reproduites ; utiliser un PDF pour un aperçu fidèle.'
    if limited:note+=' Document volumineux : aperçu partiel.'
    return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>body{font:15px Arial,sans-serif;margin:24px;color:#1e293b}p{white-space:pre-wrap;line-height:1.5}table{border-collapse:collapse;width:100%;margin:14px 0}td{border:1px solid #cbd5e1;padding:8px;vertical-align:top;overflow-wrap:anywhere}.note{padding:12px;background:#f1f5f9;font-size:12px}</style></head><body><div class="note">'+escape(note)+'</div>'+''.join(parts)+'</body></html>'

def register_documents(app,db,login_required,now,log,db_path,storage):
    """`storage` : FileStorage (clés ``patient_documents/<nom>``) — Cloudflare R2 ou disque local."""
    conn=sqlite3.connect(db_path)
    try:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS patient_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          original_name TEXT NOT NULL,
          storage_name TEXT NOT NULL UNIQUE,
          extension TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          document_date TEXT NOT NULL,
          uploaded_at TEXT NOT NULL,
          author TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_patient_documents ON patient_documents(patient_id);
        ''')
        conn.commit()
    finally:conn.close()

    def patient_exists(pid):return db().execute('SELECT 1 FROM patients WHERE id=?',(pid,)).fetchone() is not None

    def can_delete_document(row):
        if g.user['role']=='admin':
            return True
        try:
            imported=dt.datetime.fromisoformat(row['uploaded_at'])
            current=dt.datetime.fromisoformat(now())
            elapsed=(current-imported).total_seconds()
            return 0 <= elapsed <= 86400
        except (ValueError,TypeError):
            return False

    @app.put('/api/patients/<int:pid>/documents/<int:did>')
    @login_required
    def api_rename_patient_document(pid,did):
        row=db().execute('SELECT * FROM patient_documents WHERE id=? AND patient_id=?',(did,pid)).fetchone()
        if not row:return jsonify(error='Document introuvable pour ce patient.'),404
        data=request.get_json(silent=True) or {}
        title=data.get('title')
        if not isinstance(title,str) or not title.strip() or len(title.strip())>240:
            return jsonify(error='Indiquez un titre de 1 à 240 caractères.'),400
        title=title.strip()
        db().execute('UPDATE patient_documents SET title=? WHERE id=? AND patient_id=?',(title,did,pid))
        log(pid,'Titre du document modifié',row['title']+' → '+title)
        db().commit()
        return jsonify(ok=True,title=title)

    @app.get('/api/patients/<int:pid>/documents')
    @login_required
    def api_patient_documents(pid):
        if not patient_exists(pid):return jsonify(error='Patient introuvable.'),404
        rows=db().execute('SELECT id,title,original_name,extension,size_bytes,document_date,uploaded_at FROM patient_documents WHERE patient_id=? ORDER BY document_date DESC,id DESC',(pid,)).fetchall()
        return jsonify(documents=[dict(r,can_delete=can_delete_document(r),can_edit_title=True) for r in rows],max_size=MAX_SIZE)

    @app.post('/api/patients/<int:pid>/documents')
    @login_required
    def api_upload_patient_document(pid):
        if not patient_exists(pid):return jsonify(error='Patient introuvable.'),404
        file=request.files.get('file')
        if not file or not file.filename:return jsonify(error='Choisissez un document.'),400
        original=os.path.basename(file.filename.replace('\\','/'))[:240]
        extension=os.path.splitext(original)[1].lower()
        if extension not in MIMES:return jsonify(error='Formats : PDF, JPG, PNG, GIF, WebP, Word DOC ou DOCX.'),400
        data=file.stream.read(MAX_SIZE+1)
        if not data or len(data)>MAX_SIZE:return jsonify(error='Document vide ou supérieur à 25 Mo.'),400
        try:validate_upload(data,extension)
        except Exception as exc:
            if isinstance(exc,ValueError):return jsonify(error=str(exc)),400
            return jsonify(error='Fichier invalide ou non lisible.'),400
        title=(request.form.get('title') or original).strip()[:240] or original
        date=(request.form.get('date') or now()[:10]).strip()
        try:
            import datetime
            datetime.date.fromisoformat(date)
        except ValueError:return jsonify(error='Date invalide.'),400
        name=secrets.token_hex(24)+extension
        key='patient_documents/'+name
        try:
            storage.save(key,data,MIMES.get(extension))
            cur=db().execute('INSERT INTO patient_documents(patient_id,title,original_name,storage_name,extension,size_bytes,document_date,uploaded_at,author) VALUES(?,?,?,?,?,?,?,?,?)',(pid,title,original,name,extension,len(data),date,now(),g.user['full_name']))
            log(pid,'Document ajouté',title+' — '+original)
            db().commit()
        except StorageError as exc:
            db().rollback()
            return jsonify(error=str(exc)),503
        except Exception:
            db().rollback()
            storage.delete(key)
            raise
        return jsonify(id=cur.lastrowid),201

    @app.delete('/api/patients/<int:pid>/documents/<int:did>')
    @login_required
    def api_delete_patient_document(pid,did):
        row=db().execute('SELECT * FROM patient_documents WHERE id=? AND patient_id=?',(did,pid)).fetchone()
        if not row:return jsonify(error='Document introuvable pour ce patient.'),404
        if not can_delete_document(row):
            return jsonify(error='Après 24 heures, seul l’administrateur peut supprimer ce document.'),403
        db().execute('DELETE FROM patient_documents WHERE id=?',(did,))
        log(pid,'Document supprimé',row['title']+' — '+row['original_name'])
        db().commit()
        if os.path.basename(row['storage_name'])==row['storage_name']:storage.delete('patient_documents/'+row['storage_name'])
        return jsonify(ok=True)

    @app.get('/api/patients/<int:pid>/documents/<int:did>/original')
    @login_required
    def api_patient_document_original(pid,did):
        row=db().execute('SELECT * FROM patient_documents WHERE id=? AND patient_id=?',(did,pid)).fetchone()
        if not row:return jsonify(error='Document introuvable pour ce patient.'),404
        name=row['storage_name']
        if os.path.basename(name)!=name:return jsonify(error='Fichier invalide.'),400
        key='patient_documents/'+name
        if not storage.exists(key):return jsonify(error='Fichier absent du stockage.'),404
        response=storage.response(key,MIMES.get(row['extension'],'application/octet-stream'),as_attachment=True,download_name=row['original_name'])
        response.headers['Cache-Control']='no-store'
        response.headers['X-Content-Type-Options']='nosniff'
        return response

    @app.get('/api/patients/<int:pid>/documents/<int:did>/preview')
    @login_required
    def api_preview_patient_document(pid,did):
        row=db().execute('SELECT * FROM patient_documents WHERE id=? AND patient_id=?',(did,pid)).fetchone()
        if not row:return jsonify(error='Document introuvable pour ce patient.'),404
        name=row['storage_name']
        if os.path.basename(name)!=name:return jsonify(error='Fichier invalide.'),400
        key='patient_documents/'+name
        if not storage.exists(key):return jsonify(error='Fichier absent du stockage.'),404
        if row['extension']=='.doc':
            response=storage.response(key,MIMES['.doc'],as_attachment=True,download_name=row['original_name'])
        elif row['extension']=='.docx':
            try:html=docx_preview(BytesIO(storage.read(key)))
            except Exception:return jsonify(error='Impossible de lire ce document Word.'),422
            response=app.response_class(html,mimetype='text/html')
            response.headers['Content-Security-Policy']="default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'"
        else:
            response=storage.response(key,MIMES[row['extension']],as_attachment=False,download_name=row['original_name'])
        response.headers['Cache-Control']='no-store'
        response.headers['X-Content-Type-Options']='nosniff'
        return response
