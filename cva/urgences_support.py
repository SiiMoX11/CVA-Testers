"""Exports Word et rendu PDF authentifié pour les urgences."""
from io import BytesIO
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape
from flask import jsonify, send_file, current_app
from .storage import StorageError


def advice_docx(text):
    # Un vrai DOCX : seul le texte de l'avis figure dans le corps du document.
    text = str(text).replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(c for c in text if c in "\n\t" or 0x20 <= ord(c) <= 0xD7FF or 0xE000 <= ord(c) <= 0xFFFD or 0x10000 <= ord(c) <= 0x10FFFF)
    paragraphs = []
    for line in text.split("\n"):
        runs = []
        for i, part in enumerate(line.split("\t")):
            if i:
                runs.append("<w:tab/>")
            runs.append('<w:t xml:space="preserve">' + escape(part) + '</w:t>')
        paragraphs.append('<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r>' + ''.join(runs) + '</w:r></w:p>')
    document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + ''.join(paragraphs) + '</w:body></w:document>'
    output = BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        archive.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr('word/document.xml', document)
    output.seek(0)
    return output


def pdf_response(storage, key, page=None):
    try:
        import pypdfium2 as pdfium
    except ImportError:
        return jsonify(error="Installer pypdfium2 et Pillow sur le serveur pour lire les PDF."), 503
    document = pdf_page = bitmap = image = response = None
    try:
        response = storage.response(key, "application/pdf", as_attachment=False, download_name="document.pdf")
        if response.status_code != 200:
            return response
        response.direct_passthrough = False
        data = response.get_data()
        if len(data) > 25 * 1024 * 1024:
            return jsonify(error="PDF supérieur à 25 Mo."), 413
        document = pdfium.PdfDocument(data)
        pages = len(document)
        if not pages:
            return jsonify(error="Ce PDF ne contient aucune page."), 422
        if page is None:
            return jsonify(pages=pages)
        if not 1 <= page <= pages:
            return jsonify(error="Page introuvable."), 404
        pdf_page = document[page-1]
        width, height = pdf_page.get_size()
        if min(width, height) <= 0:
            return jsonify(error="Dimensions de page invalides."), 422
        bitmap = pdf_page.render(scale=min(1.5, 2200/max(width, height)))
        image = bitmap.to_pil()
        output = BytesIO()
        image.save(output, format="PNG")
        output.seek(0)
        result = send_file(output, mimetype="image/png", max_age=0)
        result.headers["Cache-Control"] = "private, no-store"
        result.headers["X-Content-Type-Options"] = "nosniff"
        return result
    except StorageError as exc:
        return jsonify(error=str(exc)), 503
    except Exception:
        current_app.logger.exception("Impossible de rendre le PDF des urgences")
        return jsonify(error="PDF illisible, endommagé ou protégé par mot de passe."), 422
    finally:
        for obj in (image, bitmap, pdf_page, document, response):
            if obj is not None:
                obj.close()
