# Chirurgie Viscérale A — CHU Oujda : plateforme du service

Application web de l'équipe du service. Backend Python (Flask + SQLite), interface HTML/CSS/JS servie par Flask.

## Structure (V5 — paquet Python)

```
app.py                     Point d'entrée : `gunicorn app:app`, `waitress-serve app:app`, `python app.py`
cva/                       Code de l'application (un module par domaine)
  application.py           Assemblage : routes du noyau, base, enregistrement des modules
  config.py                Chemins, variables d'environnement, constantes du service (chambres, rôles…)
  core.py                  Objet Flask, stockage, base SQLite, schéma, horloge, en-têtes de sécurité
  auth.py                  Sessions, rôles (admin / modérateur / médecin), journal, connexion, profil
  patients.py              Chambres, admission, dossier, sortie, réadmission, lits, entrées, suppression définitive
  users.py                 Comptes utilisateurs et horloge
  admin.py                 Sauvegarde R2, maintenance du stockage, réinitialisation
  urgences.py              Urgences viscérales (zones, consignes, fichiers, sortie, hospitalisation, suppression)
  urgences_support.py      Avis Word et rendu PDF des urgences
  storage.py               Stockage des fichiers : Cloudflare R2 (production) ou disque local
  documents_obsrv.py       Documents du patient (PDF, images, Word)
  document_pdf_routes.py   Aperçu PDF (rendu dans un processus séparé)
  videos_imageries.py      Vidéos et imageries
  bilans_tools.py          Bilans biologiques
  traitements_ttt.py       Traitements, fiche Word et aperçu
  sortie_documents.py      CRH et ordonnance de sortie
  tableau_word.py          Tableau de visite Word
  word_style.py            Styles Word communs
  cro.py                   Comptes rendus opératoires
  cim10_catalogue.py       Catalogue CIM-10
  cim10_wikipedia_total.py Import CIM-10 depuis Wikipédia
  parametres.py            Paramètres (motifs, traitements, médicaments, réglages)
  service_stats.py         Statistiques du service
  observation_import.py    Import d'une observation texte
  regimes_alimentaires.py  Régimes alimentaires
  adaptations_service.py   Drains et antécédents de séjour
  r2_tools.py              Outils R2 en ligne de commande
data/                      Données lues par l'application : catalogue_traitements.json, ordre_traitements.json,
                           normes_bilans.json, modele_fiche_traitement.docx, sortie_modele.docx, catalogues_cim10/
static/                    Interface : index.html, app.css, app.js, logos (un seul fichier de chaque type)
tests/                     Tests automatiques (voir plus bas)
requirements.txt · Procfile · .env.example · .gitignore
```

La base `cva.db` et le dossier `uploads/` restent à la racine (ou aux chemins `CVA_DB` / `CVA_UPLOADS`) : ils ne font pas partie du code.

Pour modifier une fonctionnalité, ouvrez le module du domaine concerné. Les modules fonctionnels reçoivent leurs dépendances
(`db`, `login_required`, `log`, `storage`…) par leur fonction `register_…`, appelée une seule fois dans `cva/application.py`.

## Tests

Depuis la racine du projet :

```bash
python -m unittest discover -s tests -v
```

- `tests/test_platform.py` : parcours HTTP complet sur une base temporaire (connexion, admission, sortie, réadmission, documents Word,
  urgences → hospitalisation, suppressions définitives et droits). Aucune donnée réelle n'est touchée.
- `tests/modules_check.py` et `tests/frontend_check.js` : vérifications isolées des drains, documents, bilans et de l'interface
  (la partie JavaScript nécessite Node.js ; elle est ignorée sinon).

## Lancer en local (test)

```bash
pip install -r requirements.txt
CVA_ADMIN_PASSWORD='un-mot-de-passe-solide' python app.py      # http://localhost:8000
```

Sans variables `R2_*`, les fichiers sont stockés dans `uploads/` (mode développement). Il n'existe plus aucun compte ni donnée de démonstration : une base vide est créée avec un seul compte `admin`, dont le mot de passe provisoire est pris dans `CVA_ADMIN_PASSWORD` (sinon affiché une seule fois dans la console) et doit être personnalisé à la première connexion.

## Mise à jour depuis la version précédente

1. Arrêtez l'application et faites une copie de `cva.db` et du dossier `uploads/`.
2. Remplacez les fichiers du projet par ceux de cette version, en gardant `cva.db` et `uploads/` (ou les chemins définis par `CVA_DB` / `CVA_UPLOADS`).
3. Relancez : les nouvelles tables (urgences, sécurité des sessions) sont ajoutées automatiquement, sans toucher aux données existantes.
4. Les sessions ouvertes restent valides jusqu'à expiration (12 h d'inactivité, 7 jours maximum).

## Déploiement sur Render + Cloudflare R2

1. **Bucket R2** : créez un bucket (ex. `cva-fichiers`) et un jeton API R2 « Object Read & Write » limité à ce bucket.
2. **Variables d'environnement du service Render** (onglet Environment) :
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` — activent automatiquement le stockage R2 pour **tous** les fichiers (imageries, documents, CRO, urgences).
   - `CVA_ADMIN_PASSWORD` — mot de passe initial de `admin` (premier démarrage uniquement).
   - Recommandé : un **disque persistant** Render monté sur `/var/data` avec `CVA_DB=/var/data/cva.db` et `CVA_UPLOADS=/var/data/uploads`. Sans disque, la base SQLite est restaurée depuis la sauvegarde R2 (`_backups/cva.db`) à chaque redéploiement ; la sauvegarde est envoyée vers R2 toutes les 5 minutes (`CVA_DB_BACKUP_MINUTES`) et à l'arrêt, ce qui limite la perte à quelques minutes au pire.
   - Facultatif : `R2_PREFIX`, `R2_ENDPOINT_URL`, `CVA_STORAGE_CACHE_MB`, `CVA_DB_BACKUP_R2`, durées de session (voir `.env.example`).
3. **Build command** : `pip install -r requirements.txt` — **Start command** : celle du `Procfile` (`gunicorn --preload -k gthread -w 2 --threads 8 --timeout 120 -b 0.0.0.0:$PORT app:app`). Python 3.11 ou plus récent.
4. **Vérification après déploiement** (connecté en `admin`) :
   - `GET /api/admin/storage` → `backend: "r2"`, `ok: true`, informations sur la sauvegarde.
   - `POST /api/admin/storage/test` → écriture, lecture puis suppression d'un objet de test dans le bucket.
   - `POST /api/admin/storage/migrer` → envoie vers R2 les fichiers encore présents uniquement sur le disque (anciennes versions). Équivalent en shell : `python app.py r2 migrate` (aussi `check`, `backup`, `info`).
   - `POST /api/admin/storage/backup` → sauvegarde immédiate de la base dans R2.
   Les logs de démarrage affichent « Cloudflare R2 opérationnel (bucket …) » ou le détail de l'erreur (variable manquante, clé refusée, bucket inexistant).

Les fichiers sont servis par l'application (jamais d'URL publique R2) : chaque lecture passe par l'authentification, avec prise en charge des requêtes `Range` pour la lecture vidéo.

## Production (serveur interne)

Variables d'environnement : voir `.env.example` (`CVA_DB`, `CVA_UPLOADS`, `CVA_ADMIN_PASSWORD`, `CVA_BEHIND_PROXY`, variables `R2_*`, durées de session).

Linux :

```bash
gunicorn --preload -w 2 -b 127.0.0.1:8000 --timeout 120 app:app
```

Windows :

```bash
waitress-serve --listen=127.0.0.1:8000 --threads=8 app:app
```

Placez toujours un proxy HTTPS devant (Nginx, Caddy ou IIS) et définissez `CVA_BEHIND_PROXY=1`. Exemple Nginx :

```nginx
server {
    listen 443 ssl;
    server_name cva.exemple.ma;
    client_max_body_size 300m;
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Avec Caddy : `cva.exemple.ma { reverse_proxy 127.0.0.1:8000 }`.

## Sécurité

- Mots de passe hachés, au moins 8 caractères ; changement obligatoire du mot de passe initial.
- Sessions : jeton uniquement dans l'en-tête `Authorization`, expiration après 12 h d'inactivité et après 7 jours.
- Connexion : blocage 15 minutes après 8 échecs sur un identifiant (40 par adresse IP).
- En-têtes : Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS en HTTPS.
- Fichiers : extensions et contenu vérifiés, noms de stockage aléatoires, accès authentifié uniquement (lecture vidéo via un ticket temporaire lié à la session).
- Aucun compte, mot de passe ou donnée de test dans le code ; `CVA_DEMO` est ignoré.
- Sauvegardez chaque jour `cva.db` (avec `cva.db-wal` si présent) ; avec R2, la base est aussi sauvegardée automatiquement dans le bucket (`_backups/cva.db`).
- Données de santé : loi 09-08 (CNDP). Accord de l'établissement requis avant usage réel ; serveur interne au CHU recommandé.

## Urgences viscérales

Bouton en haut du menu latéral. Plan des urgences (triage, consultation, box 1 à 4, déchocage, observation, bloc des urgences) avec le nombre de patients par zone, actualisé toutes les 20 secondes pour tous les postes.

Par patient : zone, observation, consignes à cocher, imageries et documents, partage WhatsApp (avec confirmation), puis :

- Hospitaliser en Chirurgie viscérale A : formulaire d'admission habituel (IP, motif CIM-10, lit ou hors service). Le dossier est créé — ou le dossier archivé de la même IP est réadmis — avec l'observation, les consignes non faites, les imageries (onglet Vidéos) et les documents (onglet Observation + docs).
- Hospitaliser dans un autre service, ou Sortie (avis écrit, RDV à froid, contre avis médical, évasion, autre).

Toutes les actions sont tracées dans le journal global ; l'historique des passages est consultable depuis l'écran des urgences.

### Visibilité des patients des urgences

Un patient ajouté aux urgences n'est visible que par l'utilisateur qui l'a ajouté (et par l'administrateur). Depuis le dossier, l'auteur peut le **partager** avec un ou plusieurs utilisateurs (liste des médecins et modérateurs), **avec tous les utilisateurs**, ou retirer un partage. Le badge (Privé / Partagé / Tous) apparaît sur les cartes des zones et dans la recherche.

## Autres fonctionnalités de cette version

- **Recherche** : la barre de recherche trouve tous les patients de la plateforme (hospitalisés, hors service, sortis/archives) et les patients des urgences visibles par l'utilisateur, avec résultats groupés.
- **Lecteur d'imagerie** : lecteur vidéo intégré avec curseur de position fluide (glisser sur la barre ou directement sur l'image pour faire défiler les coupes), image par image (← / →), ±1 s (Maj + ← / →), molette, vitesse 0,25× à 2×, boucle, plein écran.
- **Changement de chambre / de lit** : bouton « Déplacer » à côté du numéro de chambre (ou depuis la fiche d'une chambre) : déplacement vers n'importe quel lit libre, ou permutation avec un autre patient hospitalisé en une seule opération, dossiers et historique conservés.
- **Suppression définitive (admin)** :
  - *Plateforme (hospitalisés et sortis)* : bouton « Supprimer » dans la liste des patients sortis, ou dans la fiche « Identité, motif & emplacement ». Un résumé est affiché puis l'IP du patient doit être saisie. Sont supprimés : entrées, imageries, documents, CRO, traitements, régimes, séjours statistiques, journal du patient et passages aux urgences liés.
  - *Urgences* : bouton « Supprimer définitivement » dans le dossier d'un patient présent, dans l'historique des urgences et dans un dossier archivé. Confirmation par saisie de SUPPRIMER. Le patient est supprimé avec tout son historique aux urgences (passages précédents et retours, consignes, imageries, documents, partages). Un éventuel dossier d'hospitalisation dans le service n'est pas touché.
  - Une ligne « Suppression définitive » (auteur, date, nombre d'éléments) reste dans le journal global pour la traçabilité.
- **Maintenance (Paramètres → Maintenance, admin)** : état du stockage R2 et de la sauvegarde, test R2, sauvegarde immédiate, migration des fichiers locaux, et **réinitialisation de la plateforme** (suppression de tous les dossiers de test, hospitalisés, sortis, urgences, fichiers et journal ; les comptes, catalogues et réglages sont conservés). Exige le mot de passe administrateur et la saisie du mot REINITIALISER.
- **Réadmission** : la réadmission d'un patient sorti demande le nouveau motif d'hospitalisation (CIM-10) ; l'ancien motif est automatiquement ajouté aux antécédents (« Hospitalisations ») avec les dates du séjour précédent.
