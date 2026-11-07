"""Urgences viscérales : suivi des patients aux urgences et passage vers le service.

Données stockées dans la base de la plateforme (tables urg_*). Un patient hospitalisé
dans le service reçoit automatiquement un dossier (ou une réadmission) avec
l'observation, les consignes non faites, les imageries et les documents des urgences.
"""
import os
import re
import json
import time
import hashlib
import secrets
import sqlite3
import datetime as dt

from flask import request, jsonify, g, send_file
from .urgences_support import pdf_response, advice_docx
from .storage import StorageError

from .documents_obsrv import validate_upload, MAX_SIZE as DOCUMENT_MAX_SIZE

ZONES = [
    ("triage", "Triage"), ("consultation", "Consultation"),
    ("box1", "Box 1"), ("box2", "Box 2"), ("box3", "Box 3"), ("box4", "Box 4"),
    ("dechocage", "Déchocage"), ("observation", "Observation"), ("bloc", "Bloc des urgences"),
]
ZONE_IDS = {z for z, _ in ZONES}
ZONE_LABEL = dict(ZONES)
EXIT_REASONS = {
    "avis": "Avis écrit déposé",
    "rdv": "RDV consultation à froid",
    "contre-avis": "Sortie contre avis médical",
    "evasion": "Évasion",
    "autre": "Autre",
}
IMAGING_MIMES = {".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4",
                 ".ogg": "video/ogg", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}
DOCUMENT_MIMES = {".doc": "application/msword", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                  ".gif": "image/gif", ".webp": "image/webp",
                  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
INLINE_TYPES = ("image/", "video/", "application/pdf")

SCHEMA = """
CREATE TABLE IF NOT EXISTS urg_patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    age INTEGER,
    motif TEXT NOT NULL DEFAULT '',
    zone TEXT NOT NULL DEFAULT 'triage',
    arrivee TEXT NOT NULL,
    observation TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'present',          -- present | hospitalise | sorti
    exit_type TEXT NOT NULL DEFAULT '',
    exit_note TEXT NOT NULL DEFAULT '',
    exit_appointment TEXT NOT NULL DEFAULT '',
    exit_service TEXT NOT NULL DEFAULT '',
    patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT NOT NULL DEFAULT '',
    closed_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_urg_patients_status ON urg_patients(status, zone);
CREATE TABLE IF NOT EXISTS urg_consignes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    urg_id INTEGER NOT NULL REFERENCES urg_patients(id) ON DELETE CASCADE,
    texte TEXT NOT NULL,
    fait INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    done_by TEXT NOT NULL DEFAULT '',
    done_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_urg_consignes ON urg_consignes(urg_id);
CREATE TABLE IF NOT EXISTS urg_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    urg_id INTEGER NOT NULL REFERENCES urg_patients(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                               -- imagerie | document
    title TEXT NOT NULL,
    original_name TEXT NOT NULL,
    storage_name TEXT NOT NULL UNIQUE,
    extension TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    uploaded_at TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_urg_files ON urg_files(urg_id);
CREATE TABLE IF NOT EXISTS urg_media_tickets (
    ticket_hash TEXT PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES urg_files(id) ON DELETE CASCADE,
    session_token TEXT NOT NULL REFERENCES tokens(token) ON DELETE CASCADE,
    expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS urg_shares (
    urg_id INTEGER NOT NULL REFERENCES urg_patients(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    shared_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (urg_id, username)
);
"""


def _text(value, limit):
    return str(value or "").strip()[:limit]


def _age(value):
    if value in (None, ""):
        return None
    try:
        age = int(str(value).strip())
    except ValueError:
        raise ValueError("L'âge doit être un nombre.")
    if not 0 <= age <= 130:
        raise ValueError("Âge invalide.")
    return age



def observation_text(value):
    return re.sub(r'^\s*Urgences viscérales\s*[—–-]\s*arrivée[^\r\n]*(?:\r?\n|$)', '', str(value or ''), count=1, flags=re.I).strip()

def observation_ips(value):
    found=[]
    for line in str(value or '').splitlines():
        clean=re.sub(r'[*_]','',line).strip()
        match=re.match(r'^I\s*\.?\s*P\s*\.?\s*(?:[:=：#-]\s*|\s+)([A-Za-z0-9][A-Za-z0-9-]{0,79})(?=\s|$|[;,])',clean,re.I)
        if match and any(c.isdigit() for c in match[1]) and match[1] not in found:found.append(match[1])
    return found

def imaging_metadata(data):
    typ = _text(data.get("imaging_type"), 80)
    plane = _text(data.get("plane"), 80)
    phase = _text(data.get("phase"), 80)
    if typ not in ("TDM", "IRM", "Bili-IRM", "Autre"):raise ValueError("Choisissez le type d’imagerie.")
    if plane not in ("Axiale", "Sagittale", "Coronale", "Autre"):raise ValueError("Choisissez la coupe.")
    if phase not in ("Sans injection", "Veineux", "Artériel", "Portal", "Tardif", "Autre"):raise ValueError("Choisissez le temps d’acquisition.")
    meta = {"schema":"imaging-v1", "type":typ, "plane":plane, "phase":phase, "notes":""}
    for key, choice in (("custom_title", typ), ("custom_plane", plane), ("custom_phase", phase)):
        meta[key] = _text(data.get(key), 200) if choice == "Autre" else ""
        if choice == "Autre" and not meta[key]:raise ValueError("Précisez les champs sélectionnés sur Autre.")
    return meta

def imaging_title(meta):
    return " — ".join((meta["custom_title"] if meta["type"] == "Autre" else meta["type"],
                       meta["custom_plane"] if meta["plane"] == "Autre" else meta["plane"],
                       meta["custom_phase"] if meta["phase"] == "Autre" else meta["phase"]))[:240]

def stream_size(file):
    """Taille d'un fichier envoyé (flux Werkzeug), sans le charger en mémoire."""
    stream = file.stream
    try:
        stream.seek(0, 2); size = stream.tell(); stream.seek(0); return size
    except (AttributeError, OSError, ValueError):
        return None

def urgences_linked_ids(conn, start_ids):
    """Tous les passages aux urgences reliés entre eux par les « retours aux urgences » (previous_urg_id),
    dans les deux sens : c'est l'historique complet du patient aux urgences."""
    seen, todo = set(), [int(i) for i in start_ids if i is not None]
    while todo:
        uid = todo.pop()
        if uid in seen:
            continue
        seen.add(uid)
        for (other,) in conn.execute("SELECT id FROM urg_patients WHERE previous_urg_id=? "
                                     "UNION SELECT previous_urg_id FROM urg_patients WHERE id=? AND previous_urg_id IS NOT NULL",
                                     (uid, uid)).fetchall():
            if other not in seen:
                todo.append(other)
    return sorted(seen)


def urgences_purge(conn, urg_ids):
    """Supprime définitivement des passages aux urgences (consignes, fichiers, partages et tickets en cascade).
    Retourne les clés de stockage des fichiers à effacer APRÈS validation de la transaction."""
    ids = [int(i) for i in urg_ids]
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    keys = ["urgences/" + r[0] for r in conn.execute(f"SELECT storage_name FROM urg_files WHERE urg_id IN ({marks})", ids)
            if r[0] and os.path.basename(r[0]) == r[0]]
    conn.execute(f"UPDATE urg_patients SET previous_urg_id=NULL WHERE previous_urg_id IN ({marks})", ids)
    conn.execute(f"DELETE FROM urg_patients WHERE id IN ({marks})", ids)
    return keys


def register_urgences(app, db, login_required, now, log, db_path, storage, clean_patient_payload,
                      platform_now, normalize_text, archive_previous_stay=None, admin_required=None):
    """`storage` : FileStorage (clés ``urgences/<nom>``) — Cloudflare R2 ou disque local.

    Visibilité : un patient des urgences n'est visible que par l'utilisateur qui l'a créé, sauf s'il est partagé
    avec des utilisateurs précis (table urg_shares) ou avec tout le monde (shared_all=1). Les administrateurs voient tout.
    """
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(SCHEMA)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(urg_files)")}
        if "details" not in columns:
            conn.execute("ALTER TABLE urg_files ADD COLUMN details TEXT NOT NULL DEFAULT ''")
        cols = {r[1] for r in conn.execute("PRAGMA table_info(urg_patients)").fetchall()}
        if "shared_all" not in cols:
            conn.execute("ALTER TABLE urg_patients ADD COLUMN shared_all INTEGER NOT NULL DEFAULT 0")
            # Dossiers antérieurs à la gestion de visibilité : restent visibles par tous (aucun créateur fiable).
            conn.execute("UPDATE urg_patients SET shared_all=1 WHERE COALESCE(created_by,'')=''")
        if "previous_urg_id" not in cols:
            conn.execute("ALTER TABLE urg_patients ADD COLUMN previous_urg_id INTEGER REFERENCES urg_patients(id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_urg_previous ON urg_patients(previous_urg_id,status)")
        conn.commit()
    finally:
        conn.close()

    def who():
        return g.user["username"]

    def is_admin():
        return g.user["role"] == "admin"

    def visible_sql(alias="p"):
        """Fragment SQL (et paramètres) limitant aux dossiers visibles par l'utilisateur courant."""
        if is_admin():
            return "1=1", []
        return ("(" + alias + ".created_by=? OR " + alias + ".shared_all=1 OR EXISTS (SELECT 1 FROM urg_shares s WHERE s.urg_id=" + alias + ".id AND s.username=?))",
                [g.user["username"], g.user["username"]])

    def can_see(p):
        if not p or is_admin():
            return bool(p)
        if p["created_by"] == g.user["username"] or p["shared_all"]:
            return True
        return bool(db().execute("SELECT 1 FROM urg_shares WHERE urg_id=? AND username=?", (p["id"], g.user["username"])).fetchone())

    def is_owner(p):
        return is_admin() or p["created_by"] == g.user["username"]

    def shares_of(uid):
        rows = db().execute("""SELECT s.username, COALESCE(u.full_name, s.username) AS full_name, COALESCE(u.role,'') AS role
                               FROM urg_shares s LEFT JOIN users u ON u.username=s.username WHERE s.urg_id=? ORDER BY full_name""", (uid,)).fetchall()
        return [dict(r) for r in rows]

    def get_patient(uid):
        """Dossier des urgences si visible par l'utilisateur courant, sinon None (comme s'il n'existait pas)."""
        p = db().execute("SELECT * FROM urg_patients WHERE id=?", (uid,)).fetchone()
        return p if can_see(p) else None

    def search_urgences(like):
        """Recherche globale (barre de recherche) : patients des urgences présents et visibles."""
        cond, params = visible_sql("p")
        rows = db().execute(
            """SELECT p.id, p.nom, p.age, p.zone, p.motif, p.status, p.arrivee, p.created_by, p.shared_all
               FROM urg_patients p WHERE p.status='present' AND """ + cond + """
               AND (norm(p.nom) LIKE ? OR norm(p.motif) LIKE ? OR norm(p.observation) LIKE ?)
               ORDER BY p.arrivee DESC LIMIT 20""", params + [like, like, like]).fetchall()
        return [dict(r, zone_label=ZONE_LABEL.get(r["zone"], r["zone"])) for r in rows]

    app.config["URGENCES_SEARCH"] = search_urgences

    def ulog(row, action, detail=""):
        name = row["nom"] if row else ""
        log(row["patient_id"] if row and row["patient_id"] else None, "Urgences : " + action,
            (name + (" — " + detail if detail else "")).strip())

    def summary(r):
        d = dict(r)
        d["zone_label"] = ZONE_LABEL.get(d["zone"], d["zone"])
        return d

    def detail(uid):
        p = get_patient(uid)
        if not p:
            return None
        consignes = db().execute("SELECT * FROM urg_consignes WHERE urg_id=? ORDER BY fait, id", (uid,)).fetchall()
        files = db().execute(
            "SELECT id,kind,title,original_name,extension,size_bytes,uploaded_at,author,details FROM urg_files WHERE urg_id=? ORDER BY id DESC",
            (uid,)).fetchall()
        out = summary(p)
        out["shares"] = shares_of(uid)
        out["is_owner"] = is_owner(p)
        out["consignes"] = [dict(c) for c in consignes]
        out["files"] = [dict(f, mime=(IMAGING_MIMES if f["kind"] == "imagerie" else DOCUMENT_MIMES).get(f["extension"], "application/octet-stream")) for f in files]
        return out

    def require_present(p):
        if not p:
            return jsonify(error="Patient des urgences introuvable."), 404
        if p["status"] != "present":
            return jsonify(error="Ce patient a déjà quitté les urgences."), 409
        return None

    # ------------------------------------------------------------- Lecture
    @app.get("/api/urgences")
    @login_required
    def api_urgences():
        cond, params = visible_sql("u")
        rows = db().execute(
            """SELECT u.*,
                 (SELECT COUNT(*) FROM urg_consignes c WHERE c.urg_id=u.id AND c.fait=0) AS pending_consignes,
                 (SELECT COUNT(*) FROM urg_files f WHERE f.urg_id=u.id) AS files_count,
                 (SELECT COUNT(*) FROM urg_shares s WHERE s.urg_id=u.id) AS shares_count
               FROM urg_patients u WHERE u.status='present' AND """ + cond + " ORDER BY u.arrivee, u.id", params).fetchall()
        patients = []
        for r in rows:
            d = summary(r)
            d["has_observation"] = bool((r["observation"] or "").strip())
            d["is_owner"] = is_owner(r)
            d.pop("observation", None)
            patients.append(d)
        return jsonify(zones=[{"id": z, "label": l} for z, l in ZONES], patients=patients,
                       exit_reasons=EXIT_REASONS, server_time=now(), me=g.user["username"], is_admin=is_admin())

    @app.get("/api/urgences/utilisateurs")
    @login_required
    def api_urgences_users():
        """Utilisateurs (médecins, modérateurs, administrateurs) avec qui partager un dossier des urgences."""
        rows = db().execute(
            "SELECT username, full_name, role FROM users WHERE active=1 AND username!=? ORDER BY full_name, username",
            (g.user["username"],)).fetchall()
        return jsonify(users=[dict(r) for r in rows])

    @app.put("/api/urgences/patients/<int:uid>/partage")
    @login_required
    def api_urgences_share(uid):
        """Partage d'un dossier : {"shared_all": bool} et/ou {"add": [usernames], "remove": [usernames]}."""
        p = get_patient(uid)
        if not p:
            return jsonify(error="Patient des urgences introuvable."), 404
        if not is_owner(p):
            return jsonify(error="Seul l’utilisateur qui a ajouté ce patient (ou un administrateur) peut gérer son partage."), 403
        data = request.get_json(silent=True) or {}
        changes = []
        t = now()
        if "shared_all" in data:
            flag = 1 if data.get("shared_all") else 0
            if flag != (p["shared_all"] or 0):
                db().execute("UPDATE urg_patients SET shared_all=?, updated_at=? WHERE id=?", (flag, t, uid))
                changes.append("visible par tous" if flag else "visibilité restreinte")
        def _names(key):
            vals = data.get(key) or []
            if isinstance(vals, str):
                vals = [vals]
            return [str(v).strip() for v in vals if str(v).strip()][:50]
        for username in _names("add"):
            if username == p["created_by"]:
                continue
            u = db().execute("SELECT username, full_name FROM users WHERE username=? AND active=1", (username,)).fetchone()
            if not u:
                return jsonify(error="Utilisateur introuvable ou désactivé : " + username), 400
            cur = db().execute("INSERT OR IGNORE INTO urg_shares(urg_id, username, shared_by, created_at) VALUES (?,?,?,?)",
                               (uid, username, who(), t))
            if cur.rowcount:
                changes.append("partagé avec " + (u["full_name"] or username))
        for username in _names("remove"):
            cur = db().execute("DELETE FROM urg_shares WHERE urg_id=? AND username=?", (uid, username))
            if cur.rowcount:
                changes.append("partage retiré : " + username)
        if changes:
            db().execute("UPDATE urg_patients SET updated_at=? WHERE id=?", (t, uid))
            ulog(p, "partage", ", ".join(changes))
            db().commit()
        return jsonify(ok=True, shared_all=bool(db().execute("SELECT shared_all FROM urg_patients WHERE id=?", (uid,)).fetchone()[0]),
                       shares=shares_of(uid))

    @app.get("/api/urgences/historique")
    @login_required
    def api_urgences_history():
        q = normalize_text((request.args.get("q") or "").strip())
        cond, args = visible_sql("urg_patients")
        sql = "SELECT * FROM urg_patients WHERE status!='present' AND " + cond
        if q:
            sql += " AND (norm(nom) LIKE ? OR norm(motif) LIKE ?)"
            args += ["%" + q + "%"] * 2
        try:
            offset = max(0, int(request.args.get("offset", 0)))
        except (TypeError, ValueError):
            return jsonify(error="Pagination invalide."), 400
        rows = db().execute(sql + " ORDER BY closed_at DESC, id DESC LIMIT 101 OFFSET ?", args + [offset]).fetchall()
        return jsonify(patients=[summary(r) for r in rows[:100]], has_more=len(rows)>100,
                       offset=offset, exit_reasons=EXIT_REASONS)

    @app.get("/api/urgences/patients/<int:uid>")
    @login_required
    def api_urgences_patient(uid):
        d = detail(uid)
        if not d:
            return jsonify(error="Patient des urgences introuvable."), 404
        return jsonify(patient=d)

    @app.get("/api/urgences/patients/<int:uid>/avis.docx")
    @login_required
    def api_urgences_advice_word(uid):
        p = get_patient(uid)
        if not p:
            return jsonify(error="Dossier introuvable."), 404
        if p["exit_type"] != "avis" or not p["exit_note"]:
            return jsonify(error="Aucun avis écrit pour ce passage."), 404
        response = send_file(advice_docx(p["exit_note"]),
            mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            as_attachment=True, download_name="avis-urgences-" + str(uid) + ".docx")
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.post("/api/urgences/patients/<int:uid>/revenir")
    @login_required
    def api_urgences_return(uid):
        zone = (request.get_json(silent=True) or {}).get("zone")
        if zone not in ZONE_IDS:
            return jsonify(error="Zone invalide."), 400
        copied = []
        db().execute("BEGIN IMMEDIATE")
        try:
            p = get_patient(uid)
            if not p:
                db().rollback()
                return jsonify(error="Dossier introuvable."), 404
            if p["status"] != "sorti":
                db().rollback()
                return jsonify(error="Le patient doit être sorti des urgences."), 409
            active = db().execute("""WITH RECURSIVE linked(id) AS (
                SELECT id FROM urg_patients WHERE id=? UNION ALL
                SELECT p.id FROM urg_patients p JOIN linked l ON p.previous_urg_id=l.id
                ) SELECT p.id FROM urg_patients p JOIN linked l ON l.id=p.id
                WHERE p.status='present' LIMIT 1""", (uid,)).fetchone()
            if active:
                db().rollback()
                return jsonify(error="Un retour actif existe déjà pour ce passage.", id=active["id"]), 409
            t = now()
            cur = db().execute("""INSERT INTO urg_patients
                (nom,age,motif,zone,arrivee,observation,created_by,created_at,updated_at,shared_all,previous_urg_id)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (p["nom"],p["age"],p["motif"],zone,t,p["observation"],who(),t,t,p["shared_all"],uid))
            nid = cur.lastrowid
            db().execute("""INSERT INTO urg_shares(urg_id,username,shared_by,created_at)
                SELECT ?,username,?,? FROM urg_shares WHERE urg_id=?""", (nid,who(),t,uid))
            if p["created_by"] and p["created_by"] != who():
                db().execute("INSERT OR IGNORE INTO urg_shares VALUES (?,?,?,?)", (nid,p["created_by"],who(),t))
            db().execute("""INSERT INTO urg_consignes
                (urg_id,texte,fait,created_by,created_at,done_by,done_at)
                SELECT ?,texte,fait,created_by,created_at,done_by,done_at FROM urg_consignes WHERE urg_id=?""",(nid,uid))
            for f in db().execute("SELECT * FROM urg_files WHERE urg_id=? ORDER BY id",(uid,)).fetchall():
                if os.path.basename(f["storage_name"]) != f["storage_name"]:
                    raise ValueError("Nom de stockage invalide dans le dossier source.")
                source = "urgences/" + f["storage_name"]
                if not storage.exists(source):
                    raise ValueError("Fichier source introuvable : " + f["original_name"])
                name = secrets.token_hex(24) + f["extension"]
                target = "urgences/" + name
                copied.append(target)
                storage.copy(source, target)
                db().execute("""INSERT INTO urg_files
                    (urg_id,kind,title,original_name,storage_name,extension,size_bytes,uploaded_at,author,details)
                    VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (nid,f["kind"],f["title"],f["original_name"],name,f["extension"],f["size_bytes"],
                     f["uploaded_at"],f["author"],f["details"]))
            ulog(get_patient(nid), "retour depuis l’historique", "Dossier repris intégralement depuis le passage #" + str(uid))
            db().commit()
            return jsonify(id=nid, previous_urg_id=uid), 201
        except Exception as exc:
            db().rollback()
            for key in copied:
                try:
                    storage.delete(key)
                except Exception:
                    app.logger.exception("Nettoyage d’une copie urgences impossible")
            if isinstance(exc, ValueError):
                return jsonify(error=str(exc)), 409
            if isinstance(exc, StorageError):
                return jsonify(error=str(exc)), 503
            raise

    # ------------------------------------------------------------- Patients
    @app.post("/api/urgences/patients")
    @login_required
    def api_urgences_add():
        data = request.get_json(silent=True) or {}
        nom = _text(data.get("nom"), 160).upper()
        motif = _text(data.get("motif"), 300)
        zone = data.get("zone") or "triage"
        if not nom:
            return jsonify(error="Le nom du patient est obligatoire."), 400
        if zone not in ZONE_IDS:
            return jsonify(error="Zone invalide."), 400
        try:
            age = _age(data.get("age"))
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
        t = now()
        cur = db().execute(
            "INSERT INTO urg_patients(nom,age,motif,zone,arrivee,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (nom, age, motif, zone, t, who(), t, t))
        row = get_patient(cur.lastrowid)
        ulog(row, "arrivée", ZONE_LABEL[zone] + (" — " + motif if motif else ""))
        db().commit()
        return jsonify(id=cur.lastrowid), 201

    @app.put("/api/urgences/patients/<int:uid>")
    @login_required
    def api_urgences_update(uid):
        p = get_patient(uid)
        err = require_present(p)
        if err:
            return err
        data = request.get_json(silent=True) or {}
        sets, changes = {}, []
        if "zone" in data:
            if data["zone"] not in ZONE_IDS:
                return jsonify(error="Zone invalide."), 400
            if data["zone"] != p["zone"]:
                sets["zone"] = data["zone"]
                changes.append("zone " + ZONE_LABEL.get(p["zone"], p["zone"]) + " → " + ZONE_LABEL[data["zone"]])
        if "observation" in data:
            obs = str(data.get("observation") or "").strip()[:20000]
            if obs != p["observation"]:
                sets["observation"] = obs
                changes.append("observation " + ("modifiée" if p["observation"] else "ajoutée"))
        if "nom" in data:
            nom = _text(data.get("nom"), 160).upper()
            if not nom:
                return jsonify(error="Le nom du patient est obligatoire."), 400
            if nom != p["nom"]:
                sets["nom"] = nom
                changes.append("nom")
        if "motif" in data:
            motif = _text(data.get("motif"), 300)
            if motif != p["motif"]:
                sets["motif"] = motif
                changes.append("motif")
        if "age" in data:
            try:
                age = _age(data.get("age"))
            except ValueError as exc:
                return jsonify(error=str(exc)), 400
            if age != p["age"]:
                sets["age"] = age
                changes.append("âge")
        if sets:
            sets["updated_at"] = now()
            db().execute("UPDATE urg_patients SET " + ", ".join(k + "=?" for k in sets) + " WHERE id=?", [*sets.values(), uid])
            ulog(p, "modification", ", ".join(changes))
            db().commit()
        return jsonify(patient=detail(uid))

    # ------------------------------------------------------------- Consignes
    @app.post("/api/urgences/patients/<int:uid>/consignes")
    @login_required
    def api_urgences_add_consigne(uid):
        p = get_patient(uid)
        err = require_present(p)
        if err:
            return err
        texte = _text((request.get_json(silent=True) or {}).get("texte"), 500)
        if not texte:
            return jsonify(error="La consigne est vide."), 400
        db().execute("INSERT INTO urg_consignes(urg_id,texte,created_by,created_at) VALUES (?,?,?,?)", (uid, texte, who(), now()))
        ulog(p, "consigne ajoutée", texte[:120])
        db().commit()
        return jsonify(patient=detail(uid)), 201

    def consigne_and_patient(cid):
        c = db().execute("SELECT * FROM urg_consignes WHERE id=?", (cid,)).fetchone()
        return c, (get_patient(c["urg_id"]) if c else None)

    @app.put("/api/urgences/consignes/<int:cid>")
    @login_required
    def api_urgences_toggle_consigne(cid):
        c, p = consigne_and_patient(cid)
        if not c:
            return jsonify(error="Consigne introuvable."), 404
        err = require_present(p)
        if err:
            return err
        fait = 1 if (request.get_json(silent=True) or {}).get("fait") else 0
        if fait != c["fait"]:
            db().execute("UPDATE urg_consignes SET fait=?, done_by=?, done_at=? WHERE id=?",
                         (fait, who() if fait else "", now() if fait else "", cid))
            ulog(p, "consigne " + ("faite" if fait else "remise à faire"), c["texte"][:120])
            db().commit()
        return jsonify(patient=detail(p["id"]))

    @app.delete("/api/urgences/consignes/<int:cid>")
    @login_required
    def api_urgences_delete_consigne(cid):
        c, p = consigne_and_patient(cid)
        if not c:
            return jsonify(error="Consigne introuvable."), 404
        err = require_present(p)
        if err:
            return err
        db().execute("DELETE FROM urg_consignes WHERE id=?", (cid,))
        ulog(p, "consigne supprimée", c["texte"][:120])
        db().commit()
        return jsonify(patient=detail(p["id"]))

    # ------------------------------------------------------------- Fichiers
    @app.post("/api/urgences/patients/<int:uid>/files")
    @login_required
    def api_urgences_upload(uid):
        p = get_patient(uid)
        err = require_present(p)
        if err:
            return err
        kind = request.form.get("kind")
        if kind not in ("imagerie", "document"):
            return jsonify(error="Type de fichier invalide."), 400
        details = ""
        if kind == "imagerie":
            try:meta = imaging_metadata(request.form)
            except ValueError as exc:return jsonify(error=str(exc)), 400
            title = imaging_title(meta)
            details = json.dumps(meta, ensure_ascii=False)
        else:
            title = _text(request.form.get("title"), 240)
            if not title:return jsonify(error="Indiquez le titre du document."), 400
        files = [f for f in request.files.getlist("file") if f and f.filename]
        if not files:
            return jsonify(error="Choisissez au moins un fichier."), 400
        if len(files) > 20:
            return jsonify(error="20 fichiers maximum par envoi."), 400
        allowed = IMAGING_MIMES if kind == "imagerie" else DOCUMENT_MIMES
        prepared = []
        for f in files:
            original = os.path.basename(f.filename.replace("\\", "/"))[:240]
            extension = os.path.splitext(original)[1].lower()
            if extension not in allowed:
                msg = ("Imagerie : vidéos MP4, WebM, MOV, M4V, OGG ou images JPG, PNG." if kind == "imagerie"
                       else "Documents : PDF, Word DOC/DOCX, JPG, PNG, GIF, WebP.")
                return jsonify(error="Format non pris en charge (" + original + "). " + msg), 400
            prepared.append((f, original, extension))
        saved = []
        try:
            for f, original, extension in prepared:
                name = secrets.token_hex(24) + extension
                key = "urgences/" + name
                mime = allowed.get(extension, "application/octet-stream")
                if kind == "document":
                    data = f.stream.read(DOCUMENT_MAX_SIZE + 1)
                    if not data or len(data) > DOCUMENT_MAX_SIZE:
                        raise ValueError("Document vide ou supérieur à 25 Mo : " + original)
                    try:
                        validate_upload(data, extension)
                    except ValueError as exc:
                        raise ValueError(original + " : " + str(exc))
                    except Exception:
                        raise ValueError(original + " : fichier invalide ou non lisible.")
                    size = len(data)
                    storage.save(key, data, mime)
                else:
                    size = stream_size(f)
                    if not size:
                        raise ValueError("Le fichier est vide : " + original)
                    storage.save(key, f.stream, mime)
                saved.append(key)
                db().execute(
                    "INSERT INTO urg_files(urg_id,kind,title,original_name,storage_name,extension,size_bytes,uploaded_at,author,details) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (uid, kind, title, original, name, extension, size, now(), who(), details))
            ulog(p, ("imagerie" if kind == "imagerie" else "document") + " ajouté(e)", title + " (" + str(len(prepared)) + " fichier(s))")
            db().commit()
        except ValueError as exc:
            db().rollback()
            for key in saved:
                storage.delete(key)
            return jsonify(error=str(exc)), 400
        except StorageError as exc:
            db().rollback()
            for key in saved:
                storage.delete(key)
            return jsonify(error=str(exc)), 503
        except Exception:
            db().rollback()
            for key in saved:
                storage.delete(key)
            raise
        return jsonify(patient=detail(uid)), 201

    def locate_file(fid):
        """Fichier des urgences (ligne, clé de stockage) si le dossier est visible par l'utilisateur."""
        row = db().execute("SELECT * FROM urg_files WHERE id=?", (fid,)).fetchone()
        if not row or os.path.basename(row["storage_name"]) != row["storage_name"]:
            return None, None
        if not get_patient(row["urg_id"]):
            return None, None
        key = "urgences/" + row["storage_name"]
        return (row, key) if storage.exists(key) else (None, None)

    @app.get("/api/urgences/files/<int:fid>")
    @login_required
    def api_urgences_file(fid):
        row, key = locate_file(fid)
        if not row:
            return jsonify(error="Fichier introuvable."), 404
        mime = (IMAGING_MIMES if row["kind"] == "imagerie" else DOCUMENT_MIMES).get(row["extension"], "application/octet-stream")
        inline = mime.startswith(INLINE_TYPES) and request.args.get("download") != "1"
        try:
            resp = storage.response(key, mime, as_attachment=not inline, download_name=row["original_name"])
        except StorageError as exc:
            return jsonify(error=str(exc)), 503
        resp.headers["Cache-Control"] = "private, max-age=3600"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

    @app.get("/api/urgences/files/<int:fid>/pdf-info")
    @login_required
    def api_urgences_pdf_info(fid):
        row, key = locate_file(fid)
        if not row:
            return jsonify(error="Fichier introuvable."), 404
        if row["extension"] != ".pdf":
            return jsonify(error="Ce fichier n’est pas un PDF."), 400
        return pdf_response(storage, key)

    @app.get("/api/urgences/files/<int:fid>/pdf-page/<int:page>")
    @login_required
    def api_urgences_pdf_page(fid, page):
        row, key = locate_file(fid)
        if not row:
            return jsonify(error="Fichier introuvable."), 404
        if row["extension"] != ".pdf":
            return jsonify(error="Ce fichier n’est pas un PDF."), 400
        return pdf_response(storage, key, page)

    @app.post("/api/urgences/files/<int:fid>/ticket")
    @login_required
    def api_urgences_file_ticket(fid):
        """Ticket temporaire (1 h, lié à la session) pour lire une vidéo/image dans un lecteur <video>/<img>."""
        row, key = locate_file(fid)
        if not row:
            return jsonify(error="Fichier introuvable."), 404
        mime = (IMAGING_MIMES if row["kind"] == "imagerie" else DOCUMENT_MIMES).get(row["extension"], "application/octet-stream")
        token = request.headers.get("Authorization", "")[7:]
        ticket = secrets.token_urlsafe(32)
        digest = hashlib.sha256(ticket.encode()).hexdigest()
        db().execute("DELETE FROM urg_media_tickets WHERE expires_at<?", (time.time(),))
        db().execute("INSERT INTO urg_media_tickets VALUES(?,?,?,?)", (digest, fid, token, time.time() + 3600))
        db().commit()
        return jsonify(ticket=ticket, mime=mime)

    @app.get("/api/urgences/files/<int:fid>/media")
    def api_urgences_file_media(fid):
        supplied = request.args.get("ticket", "")
        if not supplied:
            return jsonify(error="Accès non autorisé."), 401
        digest = hashlib.sha256(supplied.encode()).hexdigest()
        row = db().execute(
            """SELECT f.* FROM urg_media_tickets m JOIN tokens t ON t.token=m.session_token JOIN users u ON u.id=t.user_id
               JOIN urg_files f ON f.id=m.file_id WHERE m.ticket_hash=? AND m.expires_at>? AND f.id=? AND u.active=1""",
            (digest, time.time(), fid)).fetchone()
        if not row or os.path.basename(row["storage_name"]) != row["storage_name"]:
            return jsonify(error="Accès expiré. Rouvrez l’aperçu."), 401
        key = "urgences/" + row["storage_name"]
        mime = (IMAGING_MIMES if row["kind"] == "imagerie" else DOCUMENT_MIMES).get(row["extension"], "application/octet-stream")
        try:
            resp = storage.response(key, mime, as_attachment=False, download_name=row["original_name"])
        except StorageError as exc:
            return jsonify(error=str(exc)), 503
        resp.headers["Cache-Control"] = "private, max-age=3600"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        return resp

    @app.delete("/api/urgences/files/<int:fid>")
    @login_required
    def api_urgences_delete_file(fid):
        row = db().execute("SELECT * FROM urg_files WHERE id=?", (fid,)).fetchone()
        if not row:
            return jsonify(error="Fichier introuvable."), 404
        p = get_patient(row["urg_id"])
        err = require_present(p)
        if err:
            return err
        db().execute("DELETE FROM urg_files WHERE id=?", (fid,))
        ulog(p, "fichier supprimé", row["title"] + " (" + row["original_name"] + ")")
        db().commit()
        if os.path.basename(row["storage_name"]) == row["storage_name"]:
            storage.delete("urgences/" + row["storage_name"])
        return jsonify(patient=detail(p["id"]))

    # ------------------------------------------------------------- Suppression définitive (administrateur)
    @app.get("/api/urgences/patients/<int:uid>/suppression")
    @admin_required
    def api_urgences_purge_preview(uid):
        """Ce que supprimerait la suppression définitive : passages reliés, consignes, fichiers."""
        if not db().execute("SELECT 1 FROM urg_patients WHERE id=?", (uid,)).fetchone():
            return jsonify(error="Patient des urgences introuvable."), 404
        ids = urgences_linked_ids(db(), [uid])
        marks = ",".join("?" * len(ids))
        count = lambda sql: db().execute(sql.replace("@", marks), ids).fetchone()[0]
        linked = db().execute(f"SELECT DISTINCT patient_id FROM urg_patients WHERE id IN ({marks}) AND patient_id IS NOT NULL", ids).fetchall()
        return jsonify(passages=len(ids), consignes=count("SELECT COUNT(*) FROM urg_consignes WHERE urg_id IN (@)"),
                       fichiers=count("SELECT COUNT(*) FROM urg_files WHERE urg_id IN (@)"),
                       dossiers_service=[r[0] for r in linked])

    @app.delete("/api/urgences/patients/<int:uid>")
    @admin_required
    def api_urgences_purge(uid):
        """Suppression DÉFINITIVE d'un patient des urgences avec tout son historique aux urgences (passages
        précédents et retours, consignes, imageries, documents, partages). Le dossier d'hospitalisation éventuel
        dans le service n'est pas touché (il se supprime depuis la plateforme)."""
        conn = db()
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = conn.execute("SELECT * FROM urg_patients WHERE id=?", (uid,)).fetchone()
            if not row:
                conn.rollback()
                return jsonify(error="Patient des urgences introuvable."), 404
            ids = urgences_linked_ids(conn, [uid])
            keys = urgences_purge(conn, ids)
            log(None, "Urgences : suppression définitive",
                f"{row['nom']} — {len(ids)} passage(s), {len(keys)} fichier(s) supprimé(s) par {g.user['username']}")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        for key in keys:
            storage.delete(key)
        return jsonify(ok=True, removed_passages=len(ids), removed_files=len(keys))

    # ------------------------------------------------------------- Sorties
    def close(uid, status, **fields):
        sets = {"status": status, "closed_at": now(), "closed_by": who(), "updated_at": now(), **fields}
        db().execute("UPDATE urg_patients SET " + ", ".join(k + "=?" for k in sets) + " WHERE id=?", [*sets.values(), uid])

    @app.post("/api/urgences/patients/<int:uid>/sortie")
    @login_required
    def api_urgences_exit(uid):
        p = get_patient(uid)
        err = require_present(p)
        if err:
            return err
        data = request.get_json(silent=True) or {}
        reason = data.get("type")
        if reason not in EXIT_REASONS:
            return jsonify(error="Choisissez le motif de sortie."), 400
        note = str(data.get("note") or "").strip()[:4000]
        appointment = str(data.get("appointment") or "").strip()[:20]
        if reason in ("avis", "autre") and not note:
            return jsonify(error="Le texte est obligatoire pour ce motif de sortie."), 400
        if reason == "rdv":
            try:
                dt.datetime.fromisoformat(appointment)
            except ValueError:
                return jsonify(error="Indiquez la date et l’heure du rendez-vous."), 400
        else:
            appointment = ""
        close(uid, "sorti", exit_type=reason, exit_note=note, exit_appointment=appointment)
        ulog(p, "sortie", EXIT_REASONS[reason] + (" — RDV " + appointment.replace("T", " ") if appointment else ""))
        db().commit()
        return jsonify(ok=True)

    def transfer_to_service(u, pid, copied=None):
        """Copie observation, consignes non faites, imageries et documents vers le dossier du service."""
        t = now()
        day = platform_now().date().isoformat()
        author = g.user["full_name"]
        if (u["observation"] or "").strip():
            db().execute(
                "INSERT INTO entries(patient_id,kind,category,date,title,content,details,done,author,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (pid, "observation", "", day, "Observation des urgences",
                 observation_text(u["observation"]), "", 0, author, t, t))
        for c in db().execute("SELECT * FROM urg_consignes WHERE urg_id=? AND fait=0 ORDER BY id", (u["id"],)).fetchall():
            details = json.dumps({"schema": "consigne-v2", "action": "Autre", "action_libre": "", "categorie": "Autre", "libre": c["texte"]}, ensure_ascii=False)
            cur = db().execute(
                "INSERT INTO entries(patient_id,kind,category,date,title,content,details,done,author,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (pid, "consigne", "Autre", day, "", c["texte"], details, 0, author, t, t))
            db().execute("UPDATE entries SET author_username=? WHERE id=?", (c["created_by"] or g.user["username"], cur.lastrowid))
        if copied is None:copied = []
        for f in db().execute("SELECT * FROM urg_files WHERE urg_id=? ORDER BY id", (u["id"],)).fetchall():
            source = "urgences/" + f["storage_name"]
            if os.path.basename(f["storage_name"]) != f["storage_name"] or not storage.exists(source):
                continue
            if f["kind"] == "imagerie" and f["extension"] in IMAGING_MIMES:
                name = str(pid) + "_" + secrets.token_hex(16) + f["extension"]
                storage.copy(source, "imaging/" + name)
                copied.append("imaging/" + name)
                try:
                    stored = json.loads(f["details"] or "{}")
                    if not isinstance(stored, dict) or stored.get("schema") != "imaging-v1":raise ValueError("Ancienne imagerie")
                    meta = imaging_metadata(dict(stored, imaging_type=stored.get("type")))
                except (ValueError, TypeError):
                    meta = {"schema":"imaging-v1", "type":"Autre", "plane":"", "phase":"",
                            "custom_title":f["title"][:200], "custom_plane":"", "custom_phase":""}
                meta["notes"] = "Importé des urgences : " + f["original_name"][:200]
                db().execute(
                    "INSERT INTO entries(patient_id,kind,category,date,title,content,details,done,author,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (pid, "video", "fichier", day, f["title"][:200], name, json.dumps(meta, ensure_ascii=False), 0, author, t, t))
            elif f["kind"] == "document" and f["extension"] in DOCUMENT_MIMES:
                name = secrets.token_hex(24) + f["extension"]
                storage.copy(source, "patient_documents/" + name)
                copied.append("patient_documents/" + name)
                db().execute(
                    "INSERT INTO patient_documents(patient_id,title,original_name,storage_name,extension,size_bytes,document_date,uploaded_at,author) VALUES (?,?,?,?,?,?,?,?,?)",
                    (pid, f["title"], f["original_name"], name, f["extension"], f["size_bytes"], day, t, author))
        return copied

    @app.post("/api/urgences/patients/<int:uid>/hospitaliser")
    @login_required
    def api_urgences_admit(uid):
        p = get_patient(uid)
        data = request.get_json(silent=True) or {}
        external = data.get("mode") == "autre"
        legacy_external = bool(p and p["status"] == "hospitalise" and p["exit_type"] == "hospitalisation"
                               and not p["patient_id"] and p["exit_service"])
        if not (external and legacy_external):
            err = require_present(p)
            if err:
                return err
        if external:
            service = _text(data.get("hors_service") or data.get("service"), 200)
            if not service:
                return jsonify(error="Indiquez le service d’hébergement."), 400
            data = dict(data, hors_service=service, room=None, position=None)

        # Hospitalisation dans le service : mêmes règles que l'admission classique.
        payload = {k: data.get(k) for k in ("nom", "sexe", "age", "ip", "cin", "mutuelle", "groupe", "motif", "motif_id",
                                             "motif_code", "room", "position", "hors_service") if k in data}
        payload.setdefault("nom", p["nom"])
        payload.setdefault("motif", p["motif"])
        payload.setdefault("age", "" if p["age"] is None else p["age"])
        if payload.get("age") is None:
            payload["age"] = ""
        ip = str(payload.get("ip") or "").strip()
        if not ip:
            ips = observation_ips(p["observation"])
            if len(ips)>1:return jsonify(error="Plusieurs IP trouvées dans l’observation : vérifiez et saisissez la bonne IP."),400
            if len(ips)==1:ip=ips[0]
        if not ip:
            return jsonify(error="L’IP est obligatoire pour créer le dossier d’hospitalisation."), 400
        payload["ip"] = ip
        db().execute("BEGIN IMMEDIATE")
        current = get_patient(uid)
        if not current or current["patient_id"] or (current["status"] != "present" and not (external and legacy_external and current["status"] == "hospitalise" and current["exit_type"] == "hospitalisation")):
            db().rollback()
            return jsonify(error="Ce passage a déjà été traité. Rechargez le dossier."), 409
        existing = db().execute("SELECT * FROM patients WHERE ip=? ORDER BY id DESC LIMIT 1", (ip,)).fetchone()
        try:
            if existing and existing["status"] == "hospitalise":
                db().rollback()
                return jsonify(error="Un patient avec cette IP est déjà hospitalisé dans le service (" + existing["nom"] + ").",
                               patient_id=existing["id"]), 409
            if existing and not data.get("readmit"):
                db().rollback()
                return jsonify(error="Un dossier archivé existe déjà pour cette IP (" + existing["nom"] + " " + (existing["prenom"] or "") + ").",
                               code="archived", patient_id=existing["id"]), 409
            clean = clean_patient_payload(payload, existing_id=existing["id"] if existing else None)
        except (ValueError, TypeError) as exc:
            db().rollback()
            return jsonify(error=str(exc)), 400
        if not clean.get("room") and not clean.get("hors_service"):
            db().rollback()
            return jsonify(error="Choisissez un lit ou un service d'hébergement."), 400
        where = ("chambre " + str(clean["room"]) + str(clean["position"])) if clean.get("room") else ("hors service : " + str(clean["hors_service"]))
        copied = []
        try:
            if existing:
                if normalize_text(existing["sortie_mode"]) == "deces":
                    db().rollback()
                    return jsonify(error="Impossible de réadmettre un dossier clôturé par décès."), 400
                if not clean.get("motif"):
                    db().rollback()
                    return jsonify(error="Indiquez le nouveau motif d'hospitalisation (l'ancien motif sera archivé en antécédent)."), 400
                pid = existing["id"]
                if archive_previous_stay:
                    archive_previous_stay(existing, g.user["full_name"])
                updates = {k: v for k, v in clean.items() if k not in ("nom", "ip")}
                updates.update({"status": "hospitalise", "date_entree": platform_now().date().isoformat(), "sortie_date": None,
                                "sortie_mode": None, "sortie_destination": None, "sortie_resume": None,
                                "sortie_ordonnance": None, "sortie_rdv": None})
                db().execute("UPDATE patients SET " + ", ".join(k + "=?" for k in updates) + " WHERE id=?", [*updates.values(), pid])
                db().execute("UPDATE entries SET done=1, updated_at=? WHERE patient_id=? AND kind='traitement' AND COALESCE(done,0)=0", (now(), pid))
                log(pid, "Réadmission depuis les urgences", where + " — nouveau motif : " + str(clean.get("motif") or "") + " (ancien motif archivé en antécédent)")
            else:
                clean.setdefault("date_entree", platform_now().date().isoformat())
                clean.setdefault("prenom", "")
                cols = list(clean.keys()) + ["created_at"]
                cur = db().execute("INSERT INTO patients(" + ",".join(cols) + ") VALUES (" + ",".join("?" * len(cols)) + ")", [*clean.values(), now()])
                pid = cur.lastrowid
                log(pid, "Admission depuis les urgences", clean["nom"] + " - IP " + clean["ip"] + " - " + where)
            transfer_to_service(p, pid, copied)
            destination = clean["hors_service"] if external else "Chirurgie viscérale A — " + where
            if legacy_external:
                db().execute("UPDATE urg_patients SET patient_id=?,exit_service=?,updated_at=? WHERE id=?",
                             (pid,destination,now(),uid))
            else:
                close(uid, "hospitalise", exit_type="hospitalisation", exit_service=destination, patient_id=pid)
            ulog(dict(p, patient_id=pid), "hospitalisé(e) hors service" if external else "hospitalisé(e) dans le service", where)
            db().commit()
        except StorageError as exc:
            db().rollback()
            for key in copied:
                storage.delete(key)
            return jsonify(error=str(exc)), 503
        except Exception:
            db().rollback()
            for key in copied:
                storage.delete(key)
            raise
        return jsonify(ok=True, patient_id=pid, readmitted=bool(existing))
