"""Aperçu PDF des documents patient : le rendu (PyMuPDF) s'exécute dans un processus séparé
qui lance ce fichier comme script, pour ne jamais partager le moteur PDF entre les threads Flask."""
import os
import sys
import json
import subprocess
from io import BytesIO


def pdf_data(path,action,page_number=1):
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz
    with fitz.open(path) as doc:
        if not doc.is_pdf:raise ValueError('Le document ne peut pas être lu comme PDF.')
        if doc.needs_pass:raise ValueError('PDF protégé par mot de passe : aperçu indisponible.')
        if action=='info':return json.dumps({'pages':doc.page_count}).encode('utf-8')
        if not 1<=page_number<=doc.page_count:raise ValueError('Page PDF inexistante.')
        page=doc.load_page(page_number-1)
        width,height=page.rect.width,page.rect.height
        if width<=0 or height<=0:raise ValueError('Dimensions de page invalides.')
        scale=min(2.0,1600/width,2200/height)
        return page.get_pixmap(matrix=fitz.Matrix(scale,scale),colorspace=fitz.csRGB,alpha=False).tobytes('png')


def run_pdf(path,action,page_number=1):
    # Separate process: avoids concurrent use of the PDF engine in Flask threads.
    cmd=[sys.executable,os.path.abspath(__file__),'--render',action,path,str(page_number)]
    try:result=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=60)
    except subprocess.TimeoutExpired:raise ValueError('Aperçu trop long à générer. Utilisez le bouton Télécharger.')
    if result.returncode!=0:
        message=result.stderr.decode('utf-8',errors='replace').strip() or 'Impossible de lire le PDF.'
        raise ValueError(message[:500])
    return result.stdout


def register_document_pdf_routes(app,db,login_required,storage):
    """`storage` : FileStorage (clés ``patient_documents/<nom>``). Le moteur PDF travaille sur une copie locale (cache)."""
    from flask import jsonify,send_file
    from .storage import StorageError
    def locate(pid,did):
        row=db().execute('SELECT * FROM patient_documents WHERE id=? AND patient_id=?',(did,pid)).fetchone()
        if not row:return None,None
        name=row['storage_name']
        if os.path.basename(name)!=name:return None,None
        key='patient_documents/'+name
        return (row,key) if storage.exists(key) else (None,None)
    def private(response):
        response.headers['Cache-Control']='no-store'
        response.headers['X-Content-Type-Options']='nosniff'
        return response

    @app.get('/api/patients/<int:pid>/documents/<int:did>/pdf-info')
    @login_required
    def api_patient_pdf_info(pid,did):
        row,key=locate(pid,did)
        if not row or row['extension']!='.pdf':return jsonify(error='PDF introuvable pour ce patient.'),404
        try:
            with storage.local_path(key) as path:data=json.loads(run_pdf(path,'info'))
        except StorageError as exc:return jsonify(error=str(exc)),503
        except (ValueError,json.JSONDecodeError) as exc:return jsonify(error=str(exc)),422
        return private(jsonify(**data))

    @app.get('/api/patients/<int:pid>/documents/<int:did>/pdf-page/<int:page>')
    @login_required
    def api_patient_pdf_page(pid,did,page):
        row,key=locate(pid,did)
        if not row or row['extension']!='.pdf':return jsonify(error='PDF introuvable pour ce patient.'),404
        try:
            with storage.local_path(key) as path:data=run_pdf(path,'page',page)
        except StorageError as exc:return jsonify(error=str(exc)),503
        except ValueError as exc:return jsonify(error=str(exc)),422
        return private(send_file(BytesIO(data),mimetype='image/png',as_attachment=False,download_name='page.png'))

    @app.get('/api/patients/<int:pid>/documents/<int:did>/download')
    @login_required
    def api_download_patient_document(pid,did):
        row,key=locate(pid,did)
        if not row:return jsonify(error='Document introuvable pour ce patient.'),404
        import mimetypes
        mime=mimetypes.guess_type(row['original_name'])[0] or 'application/octet-stream'
        return private(storage.response(key,mime,as_attachment=True,download_name=row['original_name']))


if __name__=='__main__':
    if len(sys.argv)!=5 or sys.argv[1]!='--render':raise SystemExit('Module de la plateforme : ne pas lancer manuellement.')
    try:
        data=pdf_data(sys.argv[3],sys.argv[2],int(sys.argv[4]));sys.stdout.buffer.write(data)
    except Exception as exc:
        message=str(exc) if isinstance(exc,ValueError) else 'PDF invalide ou moteur PDF absent. Installer PyMuPDF.'
        sys.stderr.write(message);raise SystemExit(1)
