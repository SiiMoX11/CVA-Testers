"""Stockage des fichiers de la plateforme : Cloudflare R2 (S3) ou disque local.

Une seule interface pour tous les modules (imageries, documents, CRO, urgences) :

    storage.save(key, data_or_stream, content_type)
    storage.exists(key) / storage.size(key) / storage.read(key)
    storage.copy(src_key, dst_key) / storage.delete(key)
    storage.response(key, mimetype, as_attachment, download_name)   # Flask, gère les requêtes Range
    with storage.local_path(key) as path: ...                       # copie locale temporaire (PDF, Word)

Les clés sont de la forme ``dossier/nom_de_fichier`` (``imaging/…``, ``patient_documents/…``,
``urgences/…``, ``cro/…``). Avec R2, les fichiers déjà présents sur le disque (anciennes versions)
restent lisibles : si une clé n'existe pas dans le bucket, le fichier local correspondant est utilisé.

Variables d'environnement :
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME   (obligatoires pour R2)
    R2_ENDPOINT_URL   (facultatif : endpoint S3 complet, sinon https://<account>.r2.cloudflarestorage.com)
    R2_PREFIX         (facultatif : préfixe commun des clés, ex. "cva/")
    CVA_STORAGE       (facultatif : "r2" ou "local" pour forcer le mode ; sinon R2 si configuré)
"""
import io
import os
import re
import sqlite3
import hashlib
import logging
import tempfile
import threading
import time
from contextlib import contextmanager

log = logging.getLogger("cva.storage")

SAFE_KEY = re.compile(r"^[A-Za-z0-9_\-]+/[A-Za-z0-9_\-][A-Za-z0-9_\-.]{0,200}\.[A-Za-z0-9]{1,8}$")
CHUNK = 256 * 1024
# Cache local des objets R2 utilisés par les traitements serveur (aperçu PDF, lecture Word).
CACHE_MAX_BYTES = int(os.environ.get("CVA_STORAGE_CACHE_MB", "512")) * 1024 * 1024
CACHE_MAX_AGE = 2 * 3600


class StorageError(Exception):
    pass


def _check_key(key):
    if not isinstance(key, str) or not SAFE_KEY.match(key) or ".." in key:
        raise StorageError("Clé de stockage invalide.")
    return key


def _folder_and_name(key):
    folder, name = key.split("/", 1)
    return folder, name


class FileStorage:
    """Stockage local (dossiers) avec, si configuré, Cloudflare R2 comme stockage principal."""

    def __init__(self, local_dirs, r2_config=None, prefix=""):
        # local_dirs : {"imaging": "/chemin/uploads", "patient_documents": "...", ...}
        self.local_dirs = dict(local_dirs)
        for path in self.local_dirs.values():
            os.makedirs(path, exist_ok=True)
        self.prefix = (prefix or "").strip("/")
        self.prefix = self.prefix + "/" if self.prefix else ""
        self.bucket = None
        self.client = None
        self.endpoint = None
        self._lock = threading.Lock()
        self.cache_dir = os.path.join(tempfile.gettempdir(), "cva_storage_cache")
        os.makedirs(self.cache_dir, exist_ok=True)
        if r2_config:
            self._init_r2(r2_config)

    # ------------------------------------------------------------------ R2
    def _init_r2(self, cfg):
        import boto3
        from botocore.config import Config

        account = (cfg.get("account_id") or "").strip()
        endpoint = (cfg.get("endpoint_url") or "").strip() or ("https://%s.r2.cloudflarestorage.com" % account)
        self.endpoint = endpoint
        self.bucket = (cfg.get("bucket") or "").strip()
        self.client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=(cfg.get("access_key_id") or "").strip(),
            aws_secret_access_key=(cfg.get("secret_access_key") or "").strip(),
            region_name="auto",
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                retries={"max_attempts": 4, "mode": "standard"},
                connect_timeout=10,
                read_timeout=120,
                max_pool_connections=32,
            ),
        )

    @property
    def backend(self):
        return "r2" if self.client else "local"

    def _r2_key(self, key):
        return self.prefix + key

    def check_connection(self):
        """Vérifie l'accès au bucket (liste 1 objet). Lève StorageError avec un message lisible."""
        if not self.client:
            return {"backend": "local", "ok": True}
        try:
            self.client.list_objects_v2(Bucket=self.bucket, MaxKeys=1, Prefix=self.prefix)
            return {"backend": "r2", "ok": True, "bucket": self.bucket, "endpoint": self.endpoint}
        except Exception as exc:  # botocore ClientError, EndpointConnectionError…
            raise StorageError(_describe_boto_error(exc)) from exc

    # ------------------------------------------------------------- lecture
    def _local_path(self, key):
        folder, name = _folder_and_name(key)
        base = self.local_dirs.get(folder)
        if not base:
            raise StorageError("Dossier de stockage inconnu : " + folder)
        return os.path.join(base, name)

    def _r2_head(self, key):
        try:
            return self.client.head_object(Bucket=self.bucket, Key=self._r2_key(key))
        except Exception as exc:
            code = _error_code(exc)
            if code in ("404", "NoSuchKey", "NotFound"):
                return None
            raise StorageError(_describe_boto_error(exc)) from exc

    def locate(self, key):
        """Retourne ("r2", taille) / ("local", chemin) / (None, None)."""
        _check_key(key)
        if self.client:
            head = self._r2_head(key)
            if head is not None:
                return "r2", int(head.get("ContentLength") or 0)
        path = self._local_path(key)
        if os.path.isfile(path):
            return "local", path
        return None, None

    def exists(self, key):
        return self.locate(key)[0] is not None

    def size(self, key):
        where, info = self.locate(key)
        if where == "r2":
            return info
        if where == "local":
            return os.path.getsize(info)
        return None

    def read(self, key):
        where, info = self.locate(key)
        if where == "r2":
            try:
                body = self.client.get_object(Bucket=self.bucket, Key=self._r2_key(key))["Body"]
                return body.read()
            except Exception as exc:
                raise StorageError(_describe_boto_error(exc)) from exc
        if where == "local":
            with open(info, "rb") as handle:
                return handle.read()
        raise FileNotFoundError(key)

    # ------------------------------------------------------------- écriture
    def save(self, key, data, content_type=None):
        """Enregistre des octets ou un flux (objet avec read/seek)."""
        _check_key(key)
        if self.client:
            extra = {"ContentType": content_type} if content_type else {}
            try:
                if isinstance(data, (bytes, bytearray, memoryview)):
                    self.client.put_object(Bucket=self.bucket, Key=self._r2_key(key), Body=bytes(data), **extra)
                else:
                    try:
                        data.seek(0)
                    except (AttributeError, OSError, io.UnsupportedOperation):
                        pass
                    self.client.upload_fileobj(data, self.bucket, self._r2_key(key), ExtraArgs=extra or None)
            except StorageError:
                raise
            except Exception as exc:
                raise StorageError("Enregistrement sur Cloudflare R2 impossible : " + _describe_boto_error(exc)) from exc
            return key
        path = self._local_path(key)
        tmp = path + ".part"
        with open(tmp, "wb") as target:
            if isinstance(data, (bytes, bytearray, memoryview)):
                target.write(data)
            else:
                try:
                    data.seek(0)
                except (AttributeError, OSError, io.UnsupportedOperation):
                    pass
                while True:
                    chunk = data.read(CHUNK)
                    if not chunk:
                        break
                    target.write(chunk)
        os.replace(tmp, path)
        return key

    def delete(self, key):
        """Suppression silencieuse (R2 et disque local)."""
        try:
            _check_key(key)
        except StorageError:
            return
        if self.client:
            try:
                self.client.delete_object(Bucket=self.bucket, Key=self._r2_key(key))
            except Exception as exc:
                log.warning("Suppression R2 impossible pour %s : %s", key, _describe_boto_error(exc))
        try:
            os.remove(self._local_path(key))
        except (OSError, StorageError):
            pass
        self._cache_forget(key)

    def purge_all_files(self):
        """Supprime TOUS les fichiers patients (R2 + disque), en conservant les sauvegardes `_backups/`.
        Retourne le nombre d'objets supprimés."""
        removed = 0
        if self.client:
            for folder in self.local_dirs:
                token = None
                while True:
                    kwargs = {"Bucket": self.bucket, "Prefix": self.prefix + folder + "/", "MaxKeys": 1000}
                    if token:
                        kwargs["ContinuationToken"] = token
                    try:
                        page = self.client.list_objects_v2(**kwargs)
                    except Exception as exc:
                        raise StorageError(_describe_boto_error(exc)) from exc
                    objs = [{"Key": o["Key"]} for o in page.get("Contents") or []]
                    if objs:
                        try:
                            self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": objs, "Quiet": True})
                        except Exception as exc:
                            raise StorageError(_describe_boto_error(exc)) from exc
                        removed += len(objs)
                    if not page.get("IsTruncated"):
                        break
                    token = page.get("NextContinuationToken")
        for base in self.local_dirs.values():
            try:
                names = os.listdir(base)
            except OSError:
                continue
            for name in names:
                path = os.path.join(base, name)
                if os.path.isfile(path):
                    try:
                        os.remove(path)
                        removed += 1
                    except OSError:
                        pass
        self._cache_clear()
        return removed

    def copy(self, src_key, dst_key):
        _check_key(src_key)
        _check_key(dst_key)
        where, info = self.locate(src_key)
        if where is None:
            raise FileNotFoundError(src_key)
        if self.client:
            try:
                if where == "r2":
                    self.client.copy_object(
                        Bucket=self.bucket, Key=self._r2_key(dst_key),
                        CopySource={"Bucket": self.bucket, "Key": self._r2_key(src_key)},
                    )
                else:
                    with open(info, "rb") as handle:
                        self.save(dst_key, handle, _guess_type(dst_key))
            except StorageError:
                raise
            except Exception as exc:
                raise StorageError("Copie sur Cloudflare R2 impossible : " + _describe_boto_error(exc)) from exc
            return dst_key
        import shutil
        shutil.copyfile(info, self._local_path(dst_key))
        return dst_key

    # --------------------------------------------------------- Flask/HTTP
    def response(self, key, mimetype, as_attachment=False, download_name=None, request=None):
        """Réponse Flask pour un fichier : Range (vidéo) et téléchargement conditionnel."""
        from flask import send_file, abort, Response, request as flask_request
        req = request or flask_request
        where, info = self.locate(key)
        if where is None:
            abort(404)
        if where == "local":
            resp = send_file(info, mimetype=mimetype, as_attachment=as_attachment,
                             download_name=download_name, conditional=True)
            resp.headers["Accept-Ranges"] = "bytes"
            return resp
        total = info
        r2_key = self._r2_key(key)
        start, end = 0, total - 1
        status = 200
        range_header = req.headers.get("Range", "") if req is not None else ""
        if range_header and total > 0:
            parsed = _parse_range(range_header, total)
            if parsed is None:
                resp = Response(status=416)
                resp.headers["Content-Range"] = "bytes */%d" % total
                return resp
            start, end = parsed
            status = 206
        if req is not None and req.method == "HEAD":
            resp = Response(status=200, mimetype=mimetype)
            resp.headers["Content-Length"] = str(total)
            resp.headers["Accept-Ranges"] = "bytes"
            return resp
        kwargs = {}
        if status == 206:
            kwargs["Range"] = "bytes=%d-%d" % (start, end)
        try:
            obj = self.client.get_object(Bucket=self.bucket, Key=r2_key, **kwargs)
        except Exception as exc:
            code = _error_code(exc)
            if code in ("404", "NoSuchKey", "NotFound"):
                abort(404)
            if code == "InvalidRange":
                resp = Response(status=416)
                resp.headers["Content-Range"] = "bytes */%d" % total
                return resp
            log.error("Lecture R2 impossible pour %s : %s", key, _describe_boto_error(exc))
            abort(502)
        body = obj["Body"]

        def generate():
            try:
                for chunk in body.iter_chunks(CHUNK):
                    if chunk:
                        yield chunk
            finally:
                try:
                    body.close()
                except Exception:
                    pass

        length = end - start + 1 if total else 0
        resp = Response(generate(), status=status, mimetype=mimetype, direct_passthrough=True)
        resp.headers["Content-Length"] = str(length)
        resp.headers["Accept-Ranges"] = "bytes"
        if status == 206:
            resp.headers["Content-Range"] = "bytes %d-%d/%d" % (start, end, total)
        disposition = "attachment" if as_attachment else "inline"
        if download_name:
            from urllib.parse import quote
            ascii_name = download_name.encode("ascii", "ignore").decode("ascii").replace('"', "") or "fichier"
            resp.headers["Content-Disposition"] = "%s; filename=\"%s\"; filename*=UTF-8''%s" % (
                disposition, ascii_name, quote(download_name))
        else:
            resp.headers["Content-Disposition"] = disposition
        return resp

    # ------------------------------------------------------------- cache
    def _cache_path(self, key):
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        return os.path.join(self.cache_dir, digest + os.path.splitext(key)[1].lower())

    def _cache_forget(self, key):
        try:
            os.remove(self._cache_path(key))
        except OSError:
            pass

    def _cache_clear(self):
        try:
            names = os.listdir(self.cache_dir)
        except OSError:
            return
        for name in names:
            try:
                os.remove(os.path.join(self.cache_dir, name))
            except OSError:
                pass

    def _cache_cleanup(self):
        try:
            entries = []
            for name in os.listdir(self.cache_dir):
                path = os.path.join(self.cache_dir, name)
                try:
                    stat = os.stat(path)
                except OSError:
                    continue
                entries.append((stat.st_mtime, stat.st_size, path))
            now = time.time()
            total = sum(size for _, size, _ in entries)
            entries.sort()
            for mtime, size, path in entries:
                if now - mtime > CACHE_MAX_AGE or total > CACHE_MAX_BYTES:
                    try:
                        os.remove(path)
                        total -= size
                    except OSError:
                        pass
        except OSError:
            pass

    @contextmanager
    def local_path(self, key):
        """Chemin local lisible (fichier du disque ou copie en cache d'un objet R2)."""
        where, info = self.locate(key)
        if where is None:
            raise FileNotFoundError(key)
        if where == "local":
            yield info
            return
        path = self._cache_path(key)
        with self._lock:
            if not os.path.isfile(path) or os.path.getsize(path) != info:
                tmp = path + ".%d.part" % threading.get_ident()
                try:
                    with open(tmp, "wb") as target:
                        self.client.download_fileobj(self.bucket, self._r2_key(key), target)
                    os.replace(tmp, path)
                except Exception as exc:
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass
                    raise StorageError("Lecture du fichier sur Cloudflare R2 impossible : " + _describe_boto_error(exc)) from exc
            else:
                os.utime(path, None)
        self._cache_cleanup()
        yield path

    # ------------------------------------------------------- migration
    def migrate_local_to_r2(self, remove_local=False):
        """Envoie dans R2 les fichiers encore présents uniquement sur le disque."""
        if not self.client:
            raise StorageError("R2 n'est pas configuré.")
        report = {"uploaded": 0, "skipped": 0, "errors": []}
        for folder, base in self.local_dirs.items():
            for name in sorted(os.listdir(base)):
                path = os.path.join(base, name)
                key = folder + "/" + name
                if not os.path.isfile(path) or not SAFE_KEY.match(key):
                    continue
                try:
                    if self._r2_head(key) is not None:
                        report["skipped"] += 1
                        continue
                    with open(path, "rb") as handle:
                        self.save(key, handle, _guess_type(key))
                    report["uploaded"] += 1
                    if remove_local:
                        os.remove(path)
                except Exception as exc:
                    report["errors"].append(key + " : " + str(exc))
        return report

    # ------------------------------------------------------- base SQLite
    def backup_database(self, db_path, key="_backups/cva.db"):
        """Sauvegarde cohérente de la base SQLite dans R2 (API backup, compatible WAL)."""
        if not self.client:
            raise StorageError("R2 n'est pas configuré.")
        if not os.path.isfile(db_path):
            raise StorageError("Base introuvable : " + db_path)
        fd, tmp = tempfile.mkstemp(prefix="cva_backup_", suffix=".db")
        os.close(fd)
        try:
            src = sqlite3.connect(db_path, timeout=30)
            try:
                dst = sqlite3.connect(tmp)
                try:
                    src.backup(dst)
                finally:
                    dst.close()
            finally:
                src.close()
            digest = _file_sha256(tmp)
            head = None
            try:
                head = self.client.head_object(Bucket=self.bucket, Key=self.prefix + key)
            except Exception as exc:
                if _error_code(exc) not in ("404", "NoSuchKey", "NotFound"):
                    raise StorageError(_describe_boto_error(exc)) from exc
            if head is not None and (head.get("Metadata") or {}).get("sha256") == digest:
                return {"uploaded": False, "sha256": digest}
            with open(tmp, "rb") as handle:
                self.client.upload_fileobj(handle, self.bucket, self.prefix + key,
                                           ExtraArgs={"ContentType": "application/x-sqlite3", "Metadata": {"sha256": digest}})
            return {"uploaded": True, "sha256": digest, "size": os.path.getsize(tmp)}
        except StorageError:
            raise
        except Exception as exc:
            raise StorageError("Sauvegarde de la base sur R2 impossible : " + _describe_boto_error(exc)) from exc
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass

    def restore_database_if_missing(self, db_path, key="_backups/cva.db"):
        """Au démarrage d'un conteneur neuf : récupère la dernière sauvegarde si la base locale n'existe pas."""
        if not self.client or os.path.isfile(db_path):
            return False
        try:
            head = self.client.head_object(Bucket=self.bucket, Key=self.prefix + key)
        except Exception as exc:
            if _error_code(exc) in ("404", "NoSuchKey", "NotFound"):
                return False
            raise StorageError(_describe_boto_error(exc)) from exc
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        tmp = db_path + ".restore"
        try:
            with open(tmp, "wb") as target:
                self.client.download_fileobj(self.bucket, self.prefix + key, target)
            check = sqlite3.connect(tmp)
            try:
                ok = check.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            finally:
                check.close()
            if not ok:
                raise StorageError("La sauvegarde R2 de la base est corrompue ; restauration annulée.")
            os.replace(tmp, db_path)
            log.warning("Base SQLite restaurée depuis R2 (%s octets, %s).", head.get("ContentLength"), head.get("LastModified"))
            return True
        except StorageError:
            raise
        except Exception as exc:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise StorageError("Restauration de la base depuis R2 impossible : " + _describe_boto_error(exc)) from exc

    def backup_info(self, key="_backups/cva.db"):
        if not self.client:
            return None
        try:
            head = self.client.head_object(Bucket=self.bucket, Key=self.prefix + key)
        except Exception as exc:
            if _error_code(exc) in ("404", "NoSuchKey", "NotFound"):
                return None
            raise StorageError(_describe_boto_error(exc)) from exc
        return {"size": int(head.get("ContentLength") or 0),
                "last_modified": head["LastModified"].strftime("%Y-%m-%d %H:%M:%S UTC") if head.get("LastModified") else "",
                "sha256": (head.get("Metadata") or {}).get("sha256", "")}


# ---------------------------------------------------------------- helpers
def _parse_range(header, total):
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
    if not match:
        return None
    first, last = match.group(1), match.group(2)
    if first == "" and last == "":
        return None
    if first == "":
        count = int(last)
        if count <= 0:
            return None
        start = max(0, total - count)
        end = total - 1
    else:
        start = int(first)
        if start >= total:
            return None
        end = min(int(last), total - 1) if last else total - 1
        if end < start:
            return None
    return start, end


def _error_code(exc):
    response = getattr(exc, "response", None) or {}
    error = response.get("Error") or {}
    code = str(error.get("Code") or "")
    if not code:
        meta = response.get("ResponseMetadata") or {}
        code = str(meta.get("HTTPStatusCode") or "")
    return code


def _describe_boto_error(exc):
    code = _error_code(exc)
    hints = {
        "InvalidAccessKeyId": "R2_ACCESS_KEY_ID incorrect.",
        "SignatureDoesNotMatch": "R2_SECRET_ACCESS_KEY incorrect.",
        "AccessDenied": "Jeton R2 sans droit Lecture/Écriture sur ce bucket.",
        "NoSuchBucket": "R2_BUCKET_NAME introuvable sur ce compte.",
        "InvalidBucketName": "R2_BUCKET_NAME invalide.",
    }
    text = str(exc)
    if "Could not connect" in text or "EndpointConnectionError" in type(exc).__name__:
        return "Connexion à l'endpoint R2 impossible (R2_ACCOUNT_ID / R2_ENDPOINT_URL)."
    if code in hints:
        return hints[code] + " (" + code + ")"
    return (code + " : " if code else "") + text[:300]


def _guess_type(key):
    import mimetypes
    return mimetypes.guess_type(key)[0] or "application/octet-stream"


def _file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def r2_config_from_env():
    """Lit la configuration R2 ; None si absente ou si CVA_STORAGE=local."""
    mode = (os.environ.get("CVA_STORAGE") or "").strip().lower()
    if mode == "local":
        return None
    cfg = {
        "account_id": os.environ.get("R2_ACCOUNT_ID", ""),
        "access_key_id": os.environ.get("R2_ACCESS_KEY_ID", ""),
        "secret_access_key": os.environ.get("R2_SECRET_ACCESS_KEY", ""),
        "bucket": os.environ.get("R2_BUCKET_NAME") or os.environ.get("R2_BUCKET", ""),
        "endpoint_url": os.environ.get("R2_ENDPOINT_URL", ""),
    }
    present = {k: bool(str(v).strip()) for k, v in cfg.items() if k != "endpoint_url"}
    if all(present.values()):
        return cfg
    if any(present.values()) or mode == "r2":
        missing = [name for name, ok in (("R2_ACCOUNT_ID", present["account_id"]), ("R2_ACCESS_KEY_ID", present["access_key_id"]),
                                         ("R2_SECRET_ACCESS_KEY", present["secret_access_key"]), ("R2_BUCKET_NAME", present["bucket"])) if not ok]
        raise StorageError("Configuration Cloudflare R2 incomplète : variable(s) manquante(s) " + ", ".join(missing))
    return None
