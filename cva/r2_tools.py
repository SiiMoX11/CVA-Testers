"""Outils en ligne de commande pour le stockage Cloudflare R2 de la plateforme.

    python app.py r2 check      # vérifie la connexion (variables R2_* de l'environnement)
    python app.py r2 migrate    # envoie vers R2 les fichiers encore uniquement locaux (--remove-local possible)
    python app.py r2 backup     # sauvegarde la base SQLite dans le bucket (_backups/cva.db)
    python app.py r2 info       # état de la sauvegarde présente dans R2

Les chemins locaux sont ceux de l'application (CVA_DB, CVA_UPLOADS). Utilisable dans le
shell Render (« Shell » du service) ou en local avec un fichier .env chargé.
"""
import os
import sys

from .config import DB_PATH, STORAGE_DIRS
from .storage import FileStorage, StorageError, r2_config_from_env


def _paths():
    """Mêmes chemins que l'application (variables CVA_DB, CVA_UPLOADS, CVA_DOCUMENTS, CVA_URGENCES, CVA_CRO)."""
    for path in STORAGE_DIRS.values():
        os.makedirs(path, exist_ok=True)
    return DB_PATH, dict(STORAGE_DIRS)


def main(argv):
    command = argv[1] if len(argv) > 1 else "check"
    if command not in {"check", "migrate", "backup", "info"}:
        print(__doc__)
        return 2
    try:
        config = r2_config_from_env()
    except StorageError as exc:
        print("Configuration R2 incomplète :", exc)
        return 1
    if config is None:
        print("Aucune variable R2_* détectée (CVA_STORAGE=local ?). Rien à faire.")
        return 1
    db_path, dirs = _paths()
    storage = FileStorage(dirs, config, prefix=os.environ.get("R2_PREFIX", ""))
    try:
        state = storage.check_connection()
        print("Connexion R2 : OK — bucket", state.get("bucket"), "—", state.get("endpoint"))
        if command == "migrate":
            report = storage.migrate_local_to_r2(remove_local="--remove-local" in argv)
            print("Envoyés :", report["uploaded"], "— déjà présents :", report["skipped"])
            for err in report["errors"]:
                print("  Erreur :", err)
            return 1 if report["errors"] else 0
        if command == "backup":
            if not os.path.exists(db_path):
                print("Base introuvable :", db_path)
                return 1
            result = storage.backup_database(db_path)
            print("Sauvegarde :", result)
        if command == "info":
            print("Sauvegarde R2 :", storage.backup_info())
        return 0
    except StorageError as exc:
        print("Erreur R2 :", exc)
        return 1


if __name__ == "__main__":  # python -m cva.r2_tools check
    sys.exit(main(sys.argv))
