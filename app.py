"""
Chirurgie Viscérale A — CHU Oujda : point d'entrée de la plateforme.

    Local (Windows / Linux) :  python app.py                       → http://localhost:8000
    Production Linux/Render :  gunicorn app:app   (options complètes dans le Procfile)
    Production Windows      :  waitress-serve --listen=127.0.0.1:8000 --threads=8 app:app
    Outils R2               :  python app.py r2 check | migrate | backup | info

Le code de l'application est dans le paquet `cva/` (un module par domaine), voir README.md.
"""
import os
import sys

if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "r2":
    # Outils R2 : n'initialisent ni la base ni le serveur.
    from cva.r2_tools import main
    sys.exit(main(sys.argv[1:]))

from cva.application import app  # noqa: E402

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8000)), debug=False)
