"""Comptes utilisateurs (administrateur et modérateur) et réglage de l'horloge de la plateforme."""
import datetime as dt
import sqlite3

from flask import g, jsonify, request
from werkzeug.security import generate_password_hash

from .auth import admin_required, log, login_required, staff_required
from .config import ROLES
from .core import app, db
from .patients import bed_allocation_transaction


# ---------------------------------------------------------------------- Users
# ROLES MODERATEUR V1 : rôles définis dans config.ROLES


def assignable_roles():
    return ROLES if g.user["role"] == "admin" else ("medecin",)


def can_manage(target):
    """L'administrateur gère tout le monde ; le modérateur ne gère que les médecins."""
    return g.user["role"] == "admin" or target["role"] == "medecin"


@app.get("/api/users")
@staff_required
def api_users():
    sql = "SELECT id, username, full_name, role, active FROM users"
    if g.user["role"] != "admin":
        sql += " WHERE role != 'admin'"
    rows = db().execute(sql + " ORDER BY id").fetchall()
    return jsonify(users=[dict(r, manageable=can_manage(r)) for r in rows], roles=list(assignable_roles()))


@app.post("/api/users")
@staff_required
def api_add_user():
    d = request.get_json(silent=True) or {}
    username = (d.get("username") or "").strip().lower()
    full_name = (d.get("full_name") or "").strip()
    if not username or not d.get("password") or not full_name:
        return jsonify(error="Identifiant, nom complet et mot de passe obligatoires."), 400
    if not isinstance(d.get("password"), str) or len(d["password"]) < 8:
        return jsonify(error="Le mot de passe doit contenir au moins 8 caractères."), 400
    if len(username) > 80 or len(full_name) > 160:
        return jsonify(error="Identifiant ou nom trop long."), 400
    role = d.get("role") or "medecin"
    if role not in assignable_roles():
        return jsonify(error="Rôle invalide ou non autorisé."), 403
    # Les coordonnées d'un modérateur sont définies par l'administrateur : pas de personnalisation à la 1re connexion.
    pending = 0 if role == "moderateur" else 1
    try:
        db().execute(
            "INSERT INTO users(username, full_name, role, password_hash, must_change_password, initial_setup_pending) VALUES (?,?,?,?,?,?)",
            (username, full_name, role, generate_password_hash(d["password"]), pending, pending),
        )
    except sqlite3.IntegrityError:
        return jsonify(error="Cet identifiant existe déjà."), 400
    log(None, "Utilisateur créé", f"{username} ({role})")
    db().commit()
    return jsonify(ok=True), 201


@app.put("/api/users/<int:uid>")
@staff_required
@bed_allocation_transaction
def api_update_user(uid):
    d = request.get_json(silent=True) or {}
    u = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u or (u["role"] == "admin" and g.user["role"] != "admin"):
        return jsonify(error="Utilisateur introuvable."), 404
    if not can_manage(u):
        return jsonify(error="Seul l'administrateur peut modifier ce compte."), 403
    if u["role"] == "admin" and "active" in d and not d["active"]:
        return jsonify(error="Impossible de désactiver un compte administrateur."), 403
    if u["role"] == "admin" and "role" in d and d["role"] != "admin":
        return jsonify(error="Le rôle administrateur est protégé contre la rétrogradation."), 403
    sets, args, changes = [], [], []
    if "username" in d:
        username = str(d.get("username") or "").strip().lower()
        if not username or len(username) > 80:
            return jsonify(error="Identifiant invalide."), 400
        if username != u["username"]:
            sets.append("username=?"); args.append(username); changes.append(f"identifiant {u['username']} → {username}")
    if "full_name" in d:
        name = str(d.get("full_name") or "").strip()
        if not name or len(name) > 160:
            return jsonify(error="Nom complet invalide."), 400
        if name != u["full_name"]:
            sets.append("full_name=?"); args.append(name); changes.append(f"nom → {name}")
    if d.get("password"):
        if not isinstance(d["password"], str) or len(d["password"]) < 8:
            return jsonify(error="Le mot de passe doit contenir au moins 8 caractères."), 400
        sets.append("password_hash=?"); args.append(generate_password_hash(d["password"])); changes.append("mot de passe")
        db().execute("DELETE FROM tokens WHERE user_id=?", (uid,))
    if "active" in d:
        sets.append("active=?"); args.append(1 if d["active"] else 0); changes.append("activé" if d["active"] else "désactivé")
        if not d["active"]:
            db().execute("DELETE FROM tokens WHERE user_id=?", (uid,))
    if d.get("role") and d["role"] != u["role"]:
        if d["role"] not in assignable_roles():
            return jsonify(error="Rôle invalide ou non autorisé."), 403
        sets.append("role=?"); args.append(d["role"]); changes.append(f"rôle {u['role']} → {d['role']}")
        if d["role"] == "moderateur":
            sets.append("initial_setup_pending=0"); sets.append("must_change_password=0")
        db().execute("DELETE FROM tokens WHERE user_id=?", (uid,))
    if sets:
        try:
            db().execute(f"UPDATE users SET {', '.join(sets)} WHERE id=?", [*args, uid])
        except sqlite3.IntegrityError:
            db().rollback()
            return jsonify(error="Cet identifiant existe déjà."), 400
        log(None, "Utilisateur modifié", f"{u['username']} (id {uid}) : " + ", ".join(changes))
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/users/<int:uid>")
@staff_required
@bed_allocation_transaction
def api_delete_user(uid):
    u = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u or (u["role"] == "admin" and g.user["role"] != "admin"):
        return jsonify(error="Utilisateur introuvable."), 404
    if u["role"] == "admin":
        return jsonify(error="Impossible de supprimer un compte administrateur."), 403
    if not can_manage(u):
        return jsonify(error="Seul l'administrateur peut supprimer ce compte."), 403
    db().execute("DELETE FROM users WHERE id=?", (uid,))
    log(None, "Utilisateur supprimé", f"{u['username']} — {u['full_name']} (id {uid})")
    db().commit()
    return jsonify(ok=True)


@app.get("/api/clock")
@login_required
def api_clock():
    row = db().execute("SELECT offset_minutes FROM clock_settings WHERE id=1").fetchone()
    return jsonify(timezone="UTC", offset_minutes=row[0], epoch_ms=dt.datetime.now(dt.timezone.utc).timestamp()*1000)


@app.put("/api/clock")
@admin_required
def api_set_clock():
    d = request.get_json(silent=True) or {}
    try:
        offset = int(d.get("offset_minutes", 0))
        if not -1440 <= offset <= 1440:
            raise ValueError()
    except (ValueError, TypeError):
        return jsonify(error="Correction invalide : -1440 à 1440 minutes."), 400
    db().execute("UPDATE clock_settings SET timezone='UTC', offset_minutes=? WHERE id=1", (offset,))
    db().commit()
    log(None, "Réglage de l'horloge UTC", f"Correction {offset} minutes")
    db().commit()
    return api_clock()
