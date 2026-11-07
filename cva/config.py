"""Configuration de la plateforme : chemins, variables d'environnement et constantes du service.

Aucun import de Flask ici : ce module est aussi utilisé par les outils en ligne de commande (python app.py r2 ...).
Les chemins par défaut sont ceux des versions précédentes : cva.db et uploads/ à la racine du projet.
"""
import os

# Racine du projet (dossier qui contient app.py, static/, data/ et cva/).
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(ROOT_DIR, "static")
DATA_DIR = os.path.join(ROOT_DIR, "data")  # catalogues JSON, normes des bilans, modèles Word, catalogues CIM-10

DB_PATH = os.environ.get("CVA_DB", os.path.join(ROOT_DIR, "cva.db"))
UPLOAD_DIR = os.environ.get("CVA_UPLOADS", os.path.join(ROOT_DIR, "uploads"))
DOCUMENTS_DIR = os.environ.get("CVA_DOCUMENTS", os.path.join(UPLOAD_DIR, "patient_documents"))
URGENCES_DIR = os.environ.get("CVA_URGENCES", os.path.join(UPLOAD_DIR, "urgences"))
CRO_DIR = os.environ.get("CVA_CRO", os.path.join(UPLOAD_DIR, "cro"))
STORAGE_DIRS = {"imaging": UPLOAD_DIR, "patient_documents": DOCUMENTS_DIR, "urgences": URGENCES_DIR, "cro": CRO_DIR}


def ensure_dirs():
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    os.makedirs(UPLOAD_DIR, exist_ok=True)


# Sécurité des sessions : expiration après inactivité et durée maximale.
SESSION_IDLE_SECONDS = int(os.environ.get("CVA_SESSION_IDLE_HOURS", "12")) * 3600
SESSION_MAX_SECONDS = int(os.environ.get("CVA_SESSION_MAX_DAYS", "7")) * 86400
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_FAILURES = 8

# Sauvegarde périodique de la base vers R2.
DB_BACKUP_INTERVAL = int(os.environ.get("CVA_DB_BACKUP_MINUTES", "5")) * 60

# Plan du service (vue de haut) : utilisé par le front et pour valider les chambres
ROOMS = [str(n) for n in range(201, 219)]
POSITIONS = ["F", "P"]  # F = côté fenêtre, P = côté porte
MUTUELLES = ["CNSS", "CNOPS", "AMO", "RAMED", "FAR", "Assurance privée", "Payant"]
GROUPES = ["O+", "O-", "A+", "A-", "B+", "B-", "AB+", "AB-", "Inconnu"]
ENTRY_KINDS = {
    "consigne", "atcd", "clinique", "bilan", "examen", "avis",
    "observation", "traitement", "video",
}
KIND_LABEL = {
    "consigne": "Consigne", "atcd": "Antécédent", "clinique": "Clinique",
    "bilan": "Bilan", "examen": "Examen complémentaire", "avis": "Avis spécialisé",
    "observation": "Observation", "traitement": "Traitement", "video": "Vidéo",
}
ROLES = ("admin", "moderateur", "medecin")
