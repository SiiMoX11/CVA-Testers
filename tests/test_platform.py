"""Tests HTTP de bout en bout sur une base temporaire (aucune donnée réelle touchée).

Lancer depuis la racine du projet :  python -m unittest discover -s tests -v
"""
import io
import os
import sqlite3
import sys
import tempfile
import unittest

WORK = tempfile.mkdtemp(prefix="cva_test_")
os.environ.update(CVA_DB=os.path.join(WORK, "cva.db"), CVA_UPLOADS=os.path.join(WORK, "uploads"),
                  CVA_ADMIN_PASSWORD="motdepasse-admin", CVA_STORAGE="local")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from werkzeug.security import generate_password_hash  # noqa: E402

from app import app  # noqa: E402

def _png():
    from PIL import Image
    buffer = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 30, 30)).save(buffer, format="PNG")
    return buffer.getvalue()


PNG = _png()


def sql(query, args=()):
    conn = sqlite3.connect(os.environ["CVA_DB"])
    try:
        rows = conn.execute(query, args).fetchall()
        conn.commit()
        return rows
    finally:
        conn.close()


class PlatformTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sql("UPDATE users SET initial_setup_pending=0, must_change_password=0 WHERE username='admin'")
        sql("INSERT INTO users(username, full_name, role, password_hash, active, initial_setup_pending) VALUES ('doc','Dr Doc','medecin',?,1,0)",
            (generate_password_hash("motdepasse-doc"),))
        cls.client = app.test_client()
        cls.admin = cls.login("admin", "motdepasse-admin")
        cls.doc = cls.login("doc", "motdepasse-doc")

    @classmethod
    def login(cls, user, password):
        r = cls.client.post("/api/login", json={"username": user, "password": password})
        assert r.status_code == 200, r.get_json()
        return {"Authorization": "Bearer " + r.get_json()["token"]}

    def call(self, method, url, who=None, status=200, **kw):
        r = getattr(self.client, method)(url, headers=who or self.admin, **kw)
        self.assertEqual(r.status_code, status, (method, url, r.get_json(silent=True)))
        return r.get_json(silent=True)

    def admit(self, ip, room):
        return self.call("post", "/api/patients", json={"nom": "Patient " + ip, "ip": ip, "room": room, "position": "F",
                                                         "motif": "Appendicite"}, status=201)["id"]

    def test_interface_et_securite(self):
        r = self.client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn(b"app.js", r.data)
        r.close()
        self.assertEqual(self.client.get("/static/app.css").status_code, 200)
        self.assertIn("Content-Security-Policy", r.headers)
        self.assertEqual(self.client.get("/api/rooms").status_code, 401)
        self.assertEqual(self.client.post("/api/login", json={"username": "admin", "password": "faux"}).status_code, 401)

    def test_parcours_patient(self):
        pid = self.admit("T100", "205")
        self.call("post", f"/api/patients/{pid}/entries", json={"kind": "consigne", "content": "NFS"}, status=201)
        self.assertEqual(len(self.call("get", f"/api/patients/{pid}")["entries"]["consigne"]), 1)
        self.call("post", f"/api/patients/{pid}/sortie", json={"sortie_date": "2026-11-05", "sortie_mode": "Domicile",
                                                              "date_entree": "2026-11-01", "valider": True})
        self.assertTrue(any(p["id"] == pid for p in self.call("get", "/api/archives")["patients"]))
        self.call("post", f"/api/patients/{pid}/readmettre", json={"room": "206", "position": "P", "motif": "Occlusion"})
        self.assertEqual(self.call("get", f"/api/patients/{pid}")["patient"]["status"], "hospitalise")
        for url in ("/api/tableau/word", f"/api/patients/{pid}/fiche-traitement", "/api/bilans/reference", "/api/ttt/catalogue"):
            self.call("get", url)

    def test_suppression_definitive_plateforme(self):
        pid = self.admit("T200", "207")
        self.call("post", f"/api/patients/{pid}/upload", data={"file": (io.BytesIO(PNG), "img.png")},
                  content_type="multipart/form-data", status=201)
        name = sql("SELECT content FROM entries WHERE patient_id=? AND kind='video'", (pid,))[0][0]
        path = os.path.join(os.environ["CVA_UPLOADS"], name)
        self.assertTrue(os.path.exists(path))
        self.call("delete", f"/api/patients/{pid}", who=self.doc, status=403)
        info = self.call("get", f"/api/patients/{pid}/suppression")
        self.assertEqual(info["files"], 1)
        self.call("delete", f"/api/patients/{pid}")
        self.assertFalse(os.path.exists(path))
        self.assertEqual(sql("SELECT COUNT(*) FROM entries WHERE patient_id=?", (pid,))[0][0], 0)
        self.assertEqual(sql("SELECT COUNT(*) FROM logs WHERE patient_id=?", (pid,))[0][0], 0)
        self.assertEqual(sql("PRAGMA foreign_key_check"), [])
        self.call("delete", f"/api/patients/{pid}", status=404)

    def test_suppression_definitive_urgences(self):
        uid = self.call("post", "/api/urgences/patients", who=self.doc, json={"nom": "urg", "motif": "Douleur"}, status=201)["id"]
        self.call("post", f"/api/urgences/patients/{uid}/files", who=self.doc, status=201, content_type="multipart/form-data",
                  data={"kind": "document", "title": "Bilan", "file": (io.BytesIO(PNG), "b.png")})
        self.call("post", f"/api/urgences/patients/{uid}/sortie", who=self.doc, json={"type": "autre", "note": "ok"})
        nid = self.call("post", f"/api/urgences/patients/{uid}/revenir", who=self.doc, json={"zone": "box1"}, status=201)["id"]
        self.call("delete", f"/api/urgences/patients/{nid}", who=self.doc, status=403)
        self.assertEqual(self.call("get", f"/api/urgences/patients/{nid}/suppression")["passages"], 2)
        result = self.call("delete", f"/api/urgences/patients/{nid}")
        self.assertEqual((result["removed_passages"], result["removed_files"]), (2, 2))
        self.assertEqual(sql("SELECT COUNT(*) FROM urg_patients WHERE id IN (?,?)", (uid, nid))[0][0], 0)
        self.assertEqual(os.listdir(os.path.join(os.environ["CVA_UPLOADS"], "urgences")), [])

    def test_hospitalisation_depuis_urgences(self):
        uid = self.call("post", "/api/urgences/patients", json={"nom": "urg hosp", "motif": "x"}, status=201)["id"]
        self.call("put", f"/api/urgences/patients/{uid}", json={"observation": "IP : T300\nExamen normal"})
        pid = self.call("post", f"/api/urgences/patients/{uid}/hospitaliser", json={"room": "208", "position": "F", "motif": "Appendicite"})["patient_id"]
        self.assertEqual(self.call("get", f"/api/patients/{pid}")["patient"]["ip"], "T300")
        self.call("delete", f"/api/patients/{pid}")  # supprime aussi le passage aux urgences lié
        self.assertEqual(sql("SELECT COUNT(*) FROM urg_patients WHERE id=?", (uid,))[0][0], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
