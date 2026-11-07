"""Assemblage de l'application : routes du noyau, création/migration de la base, puis enregistrement
des modules fonctionnels (même ordre que les versions précédentes) et des outils d'administration.

Point d'entrée WSGI : `app.py` à la racine (`gunicorn app:app`, `waitress-serve app:app`).
"""
from .core import app, db, init_db, normalize_text, now, platform_now, storage
from .config import DB_PATH
from .auth import admin_required, log, login_required, staff_required
from . import users  # noqa: F401  (routes des comptes et de l'horloge)
from .patients import archive_previous_stay, clean_patient_payload

from .adaptations_service import register_drains
from .bilans_tools import register_bilans
from .cro import register_cro
from .document_pdf_routes import register_document_pdf_routes
from .documents_obsrv import register_documents
from .observation_import import register_observation_import
from .parametres import register_parametres, register_parametres_v2
from .regimes_alimentaires import register_regimes
from .service_stats import register_service_stats
from .sortie_documents import register_sortie_documents
from .tableau_word import register_tableau
from .traitements_ttt import register_treatments, register_ttt_preview
from .urgences import register_urgences
from .videos_imageries import register_imaging

init_db()

register_drains(app, db, login_required, now, log)
register_bilans(app, db, login_required, now, log)
register_tableau(app, db, login_required, now)
# Documents du patient et aperçu PDF (stockage R2/local via `storage`)
register_documents(app, db, login_required, now, log, DB_PATH, storage)
register_document_pdf_routes(app, db, login_required, storage)
register_treatments(app, db, login_required, now, log, DB_PATH)
register_ttt_preview(app, db, login_required, now)
register_imaging(app, db, login_required, DB_PATH, storage, now, log)
register_sortie_documents(app, db, login_required)
register_cro(app, db, login_required, admin_required, now, log, DB_PATH, storage, staff_required)
register_parametres(app, db, login_required, staff_required, log, DB_PATH)
register_parametres_v2(app, db, login_required, staff_required, log, DB_PATH)
register_service_stats(app, db, staff_required, now, DB_PATH)
register_observation_import(app, db, login_required, now, log, storage)
register_regimes(app, db, login_required, now, log, DB_PATH)
# Urgences viscérales (visibilité par utilisateur, suppression définitive réservée à l'administrateur)
register_urgences(app, db, login_required, now, log, DB_PATH, storage, clean_patient_payload, platform_now, normalize_text,
                  archive_previous_stay=archive_previous_stay, admin_required=admin_required)

from . import admin  # noqa: E402,F401  (sauvegarde R2, maintenance, réinitialisation)

__all__ = ["app"]
