"""Administration : sauvegarde périodique de la base vers R2, état et test du stockage, migration des
fichiers locaux et réinitialisation complète de la plateforme."""
import atexit
import datetime as dt
import os
import secrets
import sqlite3
import threading
import time

from flask import g, jsonify, request
from werkzeug.security import check_password_hash

from .auth import admin_required, log
from .config import DB_BACKUP_INTERVAL, DB_PATH
from .core import STORAGE_STATUS, app, db, logger, now, platform_now, storage
from .storage import StorageError


# ------------------------------------------------------- Stockage : supervision
DB_BACKUP_ENABLED = storage.backend == "r2" and os.environ.get("CVA_DB_BACKUP_R2", "1").strip() not in ("0", "false", "non")
_backup_state = {"started": False, "last": "", "last_result": "", "error": "", "lock": threading.Lock()}


def _db_backup_once():
    try:
        result = storage.backup_database(DB_PATH)
        _backup_state["last"] = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _backup_state["last_result"] = "envoyée" if result.get("uploaded") else "inchangée"
        _backup_state["error"] = ""
        return result
    except StorageError as exc:
        _backup_state["error"] = str(exc)
        logger.error("Sauvegarde R2 de la base impossible : %s", exc)
        return {"error": str(exc)}


def _db_backup_loop():
    time.sleep(30)
    while True:
        _db_backup_once()
        time.sleep(DB_BACKUP_INTERVAL)


def start_background_tasks():
    """Démarre la sauvegarde périodique de la base vers R2 (une fois par processus serveur)."""
    if not DB_BACKUP_ENABLED:
        return
    with _backup_state["lock"]:
        if _backup_state["started"]:
            return
        _backup_state["started"] = True
    threading.Thread(target=_db_backup_loop, name="cva-db-backup", daemon=True).start()
    atexit.register(_db_backup_at_exit)


def _db_backup_at_exit():
    """Dernière sauvegarde lors de l'arrêt propre du processus (redéploiement Render)."""
    try:
        _db_backup_once()
    except Exception:  # jamais bloquer l'arrêt
        pass


@app.before_request
def _ensure_background_tasks():
    if DB_BACKUP_ENABLED and not _backup_state["started"]:
        start_background_tasks()


@app.get("/api/admin/storage")
@admin_required
def api_admin_storage():
    """État du stockage des fichiers (R2 ou local), test de connexion et sauvegarde de la base."""
    info = {
        "backend": storage.backend,
        "bucket": storage.bucket or "",
        "endpoint": storage.endpoint or "",
        "prefix": storage.prefix,
        "local_dirs": {k: v for k, v in storage.local_dirs.items()},
        "db_path": DB_PATH,
        "db_backup": {"enabled": DB_BACKUP_ENABLED, "interval_minutes": DB_BACKUP_INTERVAL // 60,
                      "last": _backup_state["last"], "last_result": _backup_state["last_result"], "error": _backup_state["error"]},
    }
    try:
        storage.check_connection()
        info["ok"] = True
        info["error"] = ""
        STORAGE_STATUS.update(ok=True, error="", checked_at=dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    except StorageError as exc:
        info["ok"] = False
        info["error"] = str(exc)
        STORAGE_STATUS.update(ok=False, error=str(exc), checked_at=dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    if storage.backend == "r2":
        try:
            info["db_backup"]["remote"] = storage.backup_info()
        except StorageError as exc:
            info["db_backup"]["remote_error"] = str(exc)
    counts = {}
    for label, sql in (("imageries", "SELECT COUNT(*) FROM entries WHERE kind='video' AND category='fichier'"),
                       ("documents", "SELECT COUNT(*) FROM patient_documents"),
                       ("cro", "SELECT COUNT(*) FROM cro_reports WHERE doc_storage IS NOT NULL"),
                       ("urgences", "SELECT COUNT(*) FROM urg_files")):
        try:
            counts[label] = db().execute(sql).fetchone()[0]
        except sqlite3.OperationalError:
            counts[label] = 0
    info["files_in_db"] = counts
    if storage.backend == "r2":
        pending = 0
        for folder, base in storage.local_dirs.items():
            try:
                pending += sum(1 for n in os.listdir(base) if os.path.isfile(os.path.join(base, n)) and not n.endswith(".part"))
            except OSError:
                pass
        info["local_files_pending_migration"] = pending
    return jsonify(info)


@app.post("/api/admin/storage/test")
@admin_required
def api_admin_storage_test():
    """Écrit, relit puis supprime un petit objet pour vérifier lecture/écriture de bout en bout."""
    key = "cro/_test_" + secrets.token_hex(8) + ".txt"
    payload = ("test " + now()).encode("utf-8")
    steps = []
    try:
        storage.save(key, payload, "text/plain")
        steps.append("écriture")
        if storage.read(key) != payload:
            raise StorageError("Le contenu relu ne correspond pas.")
        steps.append("lecture")
        storage.delete(key)
        steps.append("suppression")
        return jsonify(ok=True, backend=storage.backend, steps=steps)
    except StorageError as exc:
        storage.delete(key)
        return jsonify(ok=False, backend=storage.backend, steps=steps, error=str(exc)), 503


RESET_TABLES = [
    # Tables de données patients (ordre : enfants avant parents). Les comptes utilisateurs,
    # catalogues (motifs, traitements, médicaments, types CRO, résidents) et réglages sont conservés.
    "urg_media_tickets", "urg_shares", "urg_files", "urg_consignes", "urg_patients",
    "imaging_media_tickets", "cro_report_residents", "cro_reports", "patient_documents",
    "patient_treatment_info", "patient_regimes", "service_treatment_history", "service_stays",
    "entries", "logs", "login_failures", "patients",
]


@app.get("/api/admin/reinitialisation")
@admin_required
def api_admin_reset_preview():
    """Ce que supprimerait une réinitialisation (pour affichage avant confirmation)."""
    counts = []
    for table, label in (("patients", "dossiers patients (tous statuts)"), ("entries", "entrées de dossiers"),
                         ("patient_documents", "documents"), ("cro_reports", "comptes rendus opératoires"),
                         ("urg_patients", "passages aux urgences"), ("urg_files", "fichiers des urgences"), ("logs", "lignes de journal")):
        try:
            counts.append([label, db().execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]])
        except sqlite3.OperationalError:
            counts.append([label, 0])
    return jsonify(counts=counts, storage=storage.backend)


@app.post("/api/admin/reinitialisation")
@admin_required
def api_admin_reset():
    """Réinitialise la plateforme : supprime tous les dossiers (hospitalisés, sortis, urgences), leurs
    entrées, documents, imageries, CRO et le journal. Conserve les comptes, les catalogues et les réglages.
    Exige le mot de passe de l'administrateur et la saisie du mot REINITIALISER."""
    d = request.get_json(silent=True) or {}
    if str(d.get("confirmation") or "").strip().upper() != "REINITIALISER":
        return jsonify(error="Saisissez le mot REINITIALISER pour confirmer."), 400
    if not check_password_hash(g.user["password_hash"], str(d.get("password") or "")):
        return jsonify(error="Mot de passe administrateur incorrect."), 403
    conn = db()
    conn.execute("BEGIN IMMEDIATE")
    try:
        removed_rows = 0
        for table in RESET_TABLES:
            try:
                removed_rows += conn.execute(f"DELETE FROM {table}").rowcount
            except sqlite3.OperationalError:
                pass  # table absente dans cette version
        for table in RESET_TABLES:
            conn.execute("DELETE FROM sqlite_sequence WHERE name=?", (table,))
        stamp = platform_now().strftime("%Y-%m-%d %H:%M:%S")
        try:
            conn.execute("INSERT OR REPLACE INTO service_stats_meta(key, value) VALUES('started', ?)", (stamp,))
        except sqlite3.OperationalError:
            pass
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    try:
        removed_files = storage.purge_all_files()
        files_error = ""
    except StorageError as exc:
        removed_files, files_error = 0, str(exc)
    log(None, "Réinitialisation de la plateforme",
        f"{removed_rows} enregistrement(s) et {removed_files} fichier(s) supprimés par {g.user['username']}"
        + (f" — fichiers : {files_error}" if files_error else ""))
    conn.commit()
    try:
        conn.execute("VACUUM")
    except sqlite3.OperationalError:
        pass
    if DB_BACKUP_ENABLED:
        _db_backup_once()
    logger.warning("Plateforme réinitialisée par %s : %s lignes, %s fichiers.", g.user["username"], removed_rows, removed_files)
    return jsonify(ok=True, removed_rows=removed_rows, removed_files=removed_files, files_error=files_error)


@app.post("/api/admin/storage/backup")
@admin_required
def api_admin_storage_backup():
    if storage.backend != "r2":
        return jsonify(error="Cloudflare R2 n'est pas configuré : la sauvegarde distante est indisponible."), 400
    result = _db_backup_once()
    if "error" in result:
        return jsonify(error=result["error"]), 503
    log(None, "Sauvegarde de la base vers R2", "manuelle — " + ("envoyée" if result.get("uploaded") else "déjà à jour"))
    db().commit()
    return jsonify(ok=True, **result)


@app.post("/api/admin/storage/migrer")
@admin_required
def api_admin_storage_migrate():
    """Envoie vers R2 les fichiers encore présents uniquement sur le disque local (anciennes versions)."""
    if storage.backend != "r2":
        return jsonify(error="Cloudflare R2 n'est pas configuré."), 400
    try:
        report = storage.migrate_local_to_r2(remove_local=False)
    except StorageError as exc:
        return jsonify(error=str(exc)), 503
    log(None, "Migration des fichiers vers R2", f"{report['uploaded']} envoyé(s), {report['skipped']} déjà présent(s), {len(report['errors'])} erreur(s)")
    db().commit()
    return jsonify(ok=not report["errors"], **report)
