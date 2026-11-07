"""Authentification et droits : sessions (jetons), décorateurs de rôles, journal, connexion et profil."""
import secrets
import sqlite3
import time
from functools import wraps

from flask import g, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

from .config import LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS, SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS
from .core import app, db, now

_DUMMY_HASH = generate_password_hash(secrets.token_urlsafe(16))


# ----------------------------------------------------------------------- Auth
def bearer_token():
    auth = request.headers.get("Authorization", "")
    return auth[7:].strip() if auth.startswith("Bearer ") else ""


def current_user():
    # Le jeton n'est accepté que dans l'en-tête Authorization (jamais dans l'URL : fuite via historique/journaux).
    token = bearer_token()
    if not token or len(token) > 200:
        return None
    row = db().execute(
        "SELECT u.*, t.last_seen AS _last_seen, t.issued_at AS _issued_at FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ? AND u.active = 1",
        (token,),
    ).fetchone()
    if row is None:
        return None
    stamp = time.time()
    if stamp - (row["_issued_at"] or 0) > SESSION_MAX_SECONDS or stamp - (row["_last_seen"] or 0) > SESSION_IDLE_SECONDS:
        db().execute("DELETE FROM tokens WHERE token = ?", (token,))
        db().commit()
        return None
    if stamp - (row["_last_seen"] or 0) > 60:
        db().execute("UPDATE tokens SET last_seen = ? WHERE token = ?", (stamp, token))
        db().commit()
    return row


def login_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        u = current_user()
        if u is None:
            return jsonify(error="Session expirée, veuillez vous reconnecter."), 401
        g.user = u
        if u["initial_setup_pending"] and request.endpoint not in {"api_me", "api_logout", "api_profile", "api_clock"}:
            return jsonify(error="Personnalisez votre compte à la première connexion."), 403
        return fn(*a, **kw)
    return wrapper


def admin_required(fn):
    @wraps(fn)
    @login_required
    def wrapper(*a, **kw):
        if g.user["role"] != "admin":
            return jsonify(error="Réservé à l'administrateur."), 403
        return fn(*a, **kw)
    return wrapper


def staff_required(fn):
    """Administrateur ou modérateur."""
    @wraps(fn)
    @login_required
    def wrapper(*a, **kw):
        if g.user["role"] not in ("admin", "moderateur"):
            return jsonify(error="Réservé à l'administrateur et au modérateur."), 403
        return fn(*a, **kw)
    return wrapper


def log(patient_id, action, detail=""):
    db().execute(
        "INSERT INTO logs(patient_id, user, action, detail, ts) VALUES (?,?,?,?,?)",
        (patient_id, g.user["full_name"], action, detail[:500], now()),
    )


def user_public(u):
    return {"id": u["id"], "username": u["username"], "full_name": u["full_name"], "role": u["role"], "must_change_password": bool(u["initial_setup_pending"])}


@app.post("/api/login")
def api_login():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username") or "").strip().lower()[:80]
    password = str(data.get("password") or "")[:500]
    stamp = time.time()
    keys = ("ip:" + (request.remote_addr or "?"), "user:" + username)
    db().execute("DELETE FROM login_failures WHERE ts < ?", (stamp - LOGIN_WINDOW_SECONDS,))
    ip_failures, user_failures = (db().execute("SELECT COUNT(*) FROM login_failures WHERE key = ?", (k,)).fetchone()[0] for k in keys)
    # Seuil plus large par IP : plusieurs postes du service peuvent partager la même IP.
    if user_failures >= LOGIN_MAX_FAILURES or ip_failures >= LOGIN_MAX_FAILURES * 5:
        db().commit()
        return jsonify(error="Trop de tentatives de connexion. Réessayez dans 15 minutes."), 429
    u = db().execute("SELECT * FROM users WHERE username = ? AND active = 1", (username,)).fetchone()
    # Vérification à durée constante, même si l'identifiant n'existe pas.
    valid = check_password_hash(u["password_hash"] if u else _DUMMY_HASH, password)
    if not u or not valid:
        db().executemany("INSERT INTO login_failures(key, ts) VALUES (?,?)", [(k, stamp) for k in keys])
        db().commit()
        return jsonify(error="Nom d'utilisateur ou mot de passe incorrect."), 401
    db().execute("DELETE FROM login_failures WHERE key = ?", (keys[1],))
    token = secrets.token_urlsafe(32)
    db().execute("INSERT INTO tokens(token, user_id, created_at, issued_at, last_seen) VALUES (?,?,?,?,?)", (token, u["id"], now(), stamp, stamp))
    db().execute("DELETE FROM tokens WHERE issued_at > 0 AND (issued_at < ? OR last_seen < ?)", (stamp - SESSION_MAX_SECONDS, stamp - SESSION_IDLE_SECONDS))
    db().commit()
    return jsonify(token=token, user=user_public(u))


@app.post("/api/logout")
@login_required
def api_logout():
    db().execute("DELETE FROM tokens WHERE token = ?", (bearer_token(),))
    db().commit()
    return jsonify(ok=True)


@app.get("/api/me")
@login_required
def api_me():
    return jsonify(user=user_public(g.user))


@app.put("/api/me/profile")
@login_required
def api_profile():
    d = request.get_json(silent=True) or {}
    if not check_password_hash(g.user["password_hash"], str(d.get("current_password") or "")):
        return jsonify(error="Mot de passe actuel incorrect."), 400
    password = str(d.get("password") or "")
    # MODERATEUR PROFIL V1 : le modérateur peut changer lui-même ses coordonnées et son mot de passe à tout moment.
    free_password = g.user["role"] == "moderateur"
    if password and not g.user["initial_setup_pending"] and not free_password:
        return jsonify(error="Après la première connexion, seul l'administrateur peut modifier votre mot de passe."), 403
    if free_password and password and (len(password)<8 or check_password_hash(g.user["password_hash"], password)):
        return jsonify(error="Choisissez un nouveau mot de passe différent de 8 caractères minimum."), 400
    if g.user["initial_setup_pending"] and (len(password)<8 or check_password_hash(g.user["password_hash"], password)):
        return jsonify(error="Choisissez un mot de passe différent de 8 caractères minimum."), 400
    username = str(d.get("username", g.user["username"])).strip().lower()
    name = str(d.get("full_name", g.user["full_name"])).strip()
    if not username or not name or len(username)>80 or len(name)>160:
        return jsonify(error="Identifiant et nom complet valides obligatoires."), 400
    try:
        db().execute("UPDATE users SET username=?, full_name=?, password_hash=?, must_change_password=0, initial_setup_pending=0 WHERE id=?",
                     (username, name, generate_password_hash(password) if password else g.user["password_hash"], g.user["id"]))
    except sqlite3.IntegrityError:
        return jsonify(error="Cet identifiant existe déjà."), 400
    db().execute("DELETE FROM tokens WHERE user_id=? AND token<>?", (g.user["id"], bearer_token()))
    log(None, "Compte personnalisé", f"id {g.user['id']} : {username}")
    db().commit()
    return jsonify(user=user_public(db().execute("SELECT * FROM users WHERE id=?", (g.user["id"],)).fetchone()))
