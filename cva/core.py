"""Noyau de l'application : objet Flask, stockage des fichiers, base SQLite, horloge, schéma et sécurité HTTP."""
import datetime as dt
import logging
import os
import secrets
import sqlite3
import time
import unicodedata

from flask import Flask, g, jsonify, request, send_from_directory
from werkzeug.security import generate_password_hash

from .config import DB_PATH, STATIC_DIR, STORAGE_DIRS, UPLOAD_DIR, ensure_dirs
from .storage import FileStorage, StorageError, r2_config_from_env

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("cva")
ensure_dirs()

# --------------------------------------------------------------- Stockage (R2 / local)
# Tous les fichiers (imageries, documents, CRO, urgences) passent par `storage`.
# Si les variables R2_* sont définies (Render), Cloudflare R2 est le stockage principal ;
# sinon les dossiers locaux sont utilisés (développement).
try:
    _R2_CONFIG = r2_config_from_env()
except StorageError as exc:
    logger.error("%s - le stockage local est utilisé en attendant.", exc)
    _R2_CONFIG = None
storage = FileStorage(
    STORAGE_DIRS,
    _R2_CONFIG,
    prefix=os.environ.get("R2_PREFIX", ""),
)
STORAGE_STATUS = {"backend": storage.backend, "ok": None, "error": "", "checked_at": ""}
if storage.backend == "r2":
    try:
        storage.check_connection()
        STORAGE_STATUS.update(ok=True, checked_at=dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        logger.info("Cloudflare R2 opérationnel (bucket %s).", storage.bucket)
    except StorageError as exc:
        STORAGE_STATUS.update(ok=False, error=str(exc), checked_at=dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        logger.error("Cloudflare R2 inaccessible : %s", exc)
    # Conteneur neuf sans disque persistant : récupère la dernière sauvegarde de la base.
    try:
        storage.restore_database_if_missing(DB_PATH)
    except StorageError as exc:
        logger.error("Restauration de la base depuis R2 impossible : %s", exc)
else:
    STORAGE_STATUS.update(ok=True)
    logger.info("Stockage local des fichiers : %s", UPLOAD_DIR)
if os.environ.get("CVA_DEMO") == "1":
    logger.warning("CVA_DEMO est ignoré : aucun compte de démonstration n'est créé en production.")

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 300 * 1024 * 1024  # 300 Mo (vidéos)
app.config["JSON_AS_ASCII"] = False
if os.environ.get("CVA_BEHIND_PROXY", "").strip() in ("1", "true", "yes") or os.environ.get("RENDER") or os.environ.get("RENDER_SERVICE_ID"):
    # Derrière Render/Nginx/Caddy : utilise l'IP réelle du client pour la limitation des connexions.
    from werkzeug.middleware.proxy_fix import ProxyFix
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


# --------------------------------------------------------------------------- DB
def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=15)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
        g.db.execute("PRAGMA busy_timeout = 15000")
        g.db.create_function("norm", 1, normalize_text, deterministic=True)
    return g.db


def normalize_text(value):
    """Minuscules sans accents, pour une recherche tolérante (é = e)."""
    text = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(c for c in text if not unicodedata.combining(c)).lower()


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'medecin',   -- admin | moderateur | medecin
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    prenom TEXT NOT NULL DEFAULT '',
    age INTEGER,
    ip TEXT NOT NULL,
    mutuelle TEXT DEFAULT '',
    groupe TEXT DEFAULT '',
    motif TEXT DEFAULT '',
    room TEXT,                 -- 201..218 ou NULL si hors service
    position TEXT,             -- F | P
    hors_service TEXT,         -- ex. 'Service Réanimation Brûlés BOX 2'
    status TEXT NOT NULL DEFAULT 'hospitalise',  -- hospitalise | sorti
    date_entree TEXT,
    sortie_date TEXT, sortie_mode TEXT, sortie_destination TEXT,
    sortie_resume TEXT, sortie_ordonnance TEXT, sortie_rdv TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    category TEXT DEFAULT '',   -- type d'examen, catégorie clinique, spécialité...
    date TEXT DEFAULT '',
    title TEXT DEFAULT '',
    content TEXT DEFAULT '',
    details TEXT DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0,
    author TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id INTEGER,
    user TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT DEFAULT '',
    ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_patient ON entries(patient_id, kind);
CREATE INDEX IF NOT EXISTS idx_logs_patient ON logs(patient_id);
"""


def _clock_offset_minutes():
    """Décalage horaire configuré (table clock_settings) ; réutilise la connexion de la requête si possible."""
    try:
        if g and "db" in g:
            row = g.db.execute("SELECT offset_minutes FROM clock_settings WHERE id=1").fetchone()
            return int(row[0]) if row else 0
    except (RuntimeError, sqlite3.Error):
        pass
    try:
        conn = sqlite3.connect(DB_PATH, timeout=15)
        try:
            row = conn.execute("SELECT offset_minutes FROM clock_settings WHERE id=1").fetchone()
            return int(row[0]) if row else 0
        finally:
            conn.close()
    except sqlite3.Error:
        return 0


def platform_now():
    return dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=_clock_offset_minutes())


def now():
    return platform_now().strftime("%Y-%m-%d %H:%M:%S")


def init_db(seed=True):
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("PRAGMA journal_mode=WAL")  # lectures et écritures simultanées plus fluides
    except sqlite3.DatabaseError:
        pass
    conn.executescript(SCHEMA)
    # SECURITE V1 : expiration des sessions et limitation des tentatives de connexion.
    token_columns = {r[1] for r in conn.execute("PRAGMA table_info(tokens)")}
    if "last_seen" not in token_columns:
        conn.execute("ALTER TABLE tokens ADD COLUMN last_seen REAL NOT NULL DEFAULT 0")
    if "issued_at" not in token_columns:
        conn.execute("ALTER TABLE tokens ADD COLUMN issued_at REAL NOT NULL DEFAULT 0")
    stamp = time.time()
    conn.execute("UPDATE tokens SET issued_at=?, last_seen=? WHERE issued_at=0", (stamp, stamp))
    conn.execute("CREATE TABLE IF NOT EXISTS login_failures (key TEXT NOT NULL, ts REAL NOT NULL)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_login_failures ON login_failures(key, ts)")
    # CONSIGNES AUTEURS V1 : colonnes additives, aucune entrée supprimée.
    entry_columns = {r[1] for r in conn.execute("PRAGMA table_info(entries)")}
    for column in ("author_username", "validated_by_username", "validated_at"):
        if column not in entry_columns:
            conn.execute(f"ALTER TABLE entries ADD COLUMN {column} TEXT NOT NULL DEFAULT ''")

    columns = {r[1] for r in conn.execute("PRAGMA table_info(users)")}
    if "must_change_password" not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0")
    if "initial_setup_pending" not in columns:
        conn.execute("ALTER TABLE users ADD COLUMN initial_setup_pending INTEGER NOT NULL DEFAULT 0")
        conn.execute("UPDATE users SET initial_setup_pending=must_change_password")
    # CIN CIM10 V5 : colonnes additives, aucun dossier supprimé.
    for column, definition in [('cin', "TEXT NOT NULL DEFAULT ''"), ('motif_code', "TEXT NOT NULL DEFAULT ''"), ('motif_id', 'INTEGER')]:
        if column not in {r[1] for r in conn.execute('PRAGMA table_info(patients)')}:
            conn.execute('ALTER TABLE patients ADD COLUMN ' + column + ' ' + definition)
    # SORTIE V3 : médecin responsable du CRH.
    if "sexe" not in {r[1] for r in conn.execute("PRAGMA table_info(patients)")}:
        conn.execute("ALTER TABLE patients ADD COLUMN sexe TEXT NOT NULL DEFAULT ''")
    if "sortie_medecin" not in {r[1] for r in conn.execute("PRAGMA table_info(patients)")}:
        conn.execute("ALTER TABLE patients ADD COLUMN sortie_medecin TEXT DEFAULT ''")
    conn.execute("CREATE TABLE IF NOT EXISTS clock_settings (id INTEGER PRIMARY KEY CHECK(id=1), timezone TEXT NOT NULL DEFAULT 'UTC', offset_minutes INTEGER NOT NULL DEFAULT 0)")
    conn.execute("INSERT OR IGNORE INTO clock_settings VALUES (1, 'UTC', 0)")
    conn.execute("CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY)")
    if not conn.execute("SELECT 1 FROM app_migrations WHERE name='utc_default_v2'").fetchone():
        conn.execute("UPDATE clock_settings SET timezone='UTC', offset_minutes=0 WHERE id=1")
        conn.execute("INSERT INTO app_migrations VALUES ('utc_default_v2')")
    conn.execute("UPDATE users SET active=1 WHERE role='admin'")
    # ROLES MODERATEUR V1 : le rôle infirmier n'existe plus.
    conn.execute("UPDATE users SET role='medecin' WHERE role NOT IN ('admin','moderateur','medecin')")
    conn.execute("UPDATE users SET must_change_password=initial_setup_pending")
    conn.commit()
    if seed and conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        _seed(conn)
    conn.commit()
    conn.close()


def _seed(conn):
    # Production : un seul compte administrateur, sans patient fictif ni identifiant de test.
    # Mot de passe initial : variable CVA_ADMIN_PASSWORD, sinon mot de passe aléatoire affiché une fois dans les journaux.
    password = os.environ.get("CVA_ADMIN_PASSWORD") or secrets.token_urlsafe(12)
    conn.execute(
        "INSERT INTO users(username, full_name, role, password_hash, must_change_password, initial_setup_pending) VALUES (?,?,?,?,1,1)",
        ("admin", "Administrateur", "admin", generate_password_hash(password)),
    )
    if not os.environ.get("CVA_ADMIN_PASSWORD"):
        print("\n[CVA] Compte initial créé : identifiant « admin », mot de passe provisoire : " + password)
        print("[CVA] Il devra être personnalisé à la première connexion.\n", flush=True)


# ---------------------------------------------------------------- Front-end
@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://api.fontshare.com",
    "font-src 'self' data: https://api.fontshare.com https://cdn.fontshare.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "connect-src 'self' https:",
    "frame-src 'self' blob: https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
])


@app.after_request
def security_headers(resp):
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()")
    resp.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    resp.headers.setdefault("Content-Security-Policy", CSP)
    if request.is_secure:
        resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return resp


@app.errorhandler(413)
def too_large(_exc):
    return jsonify(error="Fichier trop volumineux."), 413


@app.errorhandler(500)
def server_error(_exc):
    if request.path.startswith("/api/"):
        return jsonify(error="Erreur interne du serveur. Réessayez ou contactez l'administrateur."), 500
    return "Erreur interne du serveur.", 500
