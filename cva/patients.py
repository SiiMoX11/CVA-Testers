"""Patients du service : plan des chambres, admission, dossier, sortie, réadmission, lits, entrées,
téléversement d'imagerie, journal du patient et suppression définitive (administrateur)."""
import datetime as dt
import os
import re
import secrets
import sqlite3
from functools import wraps

from flask import g, jsonify, request

from .adaptations_service import previous_stay_sentence
from .auth import admin_required, log, login_required, staff_required
from .config import ENTRY_KINDS, GROUPES, KIND_LABEL, MUTUELLES, POSITIONS, ROOMS
from .core import app, db, logger, normalize_text, now, platform_now, storage
from .storage import StorageError
from .urgences import urgences_linked_ids, urgences_purge


@app.get("/api/meta")
def api_meta():
    return jsonify(rooms=ROOMS, positions=POSITIONS, mutuelles=MUTUELLES, groupes=GROUPES)

# ------------------------------------------------------------------- Patients
def patient_dict(r):
    return dict(r) if r else None


def bed_taken(room, position, exclude_id=None):
    q = "SELECT id FROM patients WHERE status='hospitalise' AND room=? AND position=?"
    args = [room, position]
    if exclude_id:
        q += " AND id != ?"
        args.append(exclude_id)
    return db().execute(q, args).fetchone() is not None


@app.get("/api/rooms")
@login_required
def api_rooms():
    rows = db().execute(
        "SELECT p.id, p.nom, p.prenom, p.ip, p.motif, p.motif_code, p.room, p.position, (SELECT COUNT(*) FROM entries e WHERE e.patient_id=p.id AND e.kind='consigne' AND COALESCE(e.done,0)=0) AS pending_consignes FROM patients p WHERE p.status='hospitalise' AND p.room IS NOT NULL"
    ).fetchall()
    rooms = {r: {"room": r, "beds": {"F": None, "P": None}} for r in ROOMS}
    for p in rows:
        if p["room"] in rooms and p["position"] in POSITIONS:
            rooms[p["room"]]["beds"][p["position"]] = dict(p)
    hs = db().execute(
        "SELECT COUNT(*) FROM patients WHERE status='hospitalise' AND hors_service IS NOT NULL AND hors_service != ''"
    ).fetchone()[0]
    return jsonify(rooms=list(rooms.values()), hors_service_count=hs)


@app.get("/api/hors-service")
@login_required
def api_hors_service():
    rows = db().execute(
        """SELECT id, nom, prenom, ip, motif, motif_code, hors_service FROM patients
           WHERE status='hospitalise' AND hors_service IS NOT NULL AND hors_service != ''
           ORDER BY hors_service, nom"""
    ).fetchall()
    return jsonify(patients=[dict(r) for r in rows])


@app.get("/api/lits")
@login_required
def api_beds():
    """Patients hospitalisés avec leur emplacement (pour l'échange de lits)."""
    rows = db().execute(
        """SELECT id, nom, prenom, ip, room, position, hors_service FROM patients
           WHERE status='hospitalise' AND (room IS NOT NULL OR (hors_service IS NOT NULL AND hors_service != ''))
           ORDER BY CASE WHEN room IS NULL THEN 1 ELSE 0 END, room, position, nom"""
    ).fetchall()
    occupied = {(r["room"], r["position"]) for r in rows if r["room"]}
    single_rooms = {"201", "202", "203", "213", "218"}
    free_beds = []
    for room in ROOMS:
        if room in ("201", "218"):
            continue  # chambres indisponibles
        if room in single_rooms:
            if not any(r == room for r, _ in occupied):
                free_beds.append({"room": room, "position": "F", "label": f"Chambre {room} (lit unique)"})
            continue
        for pos in POSITIONS:
            if (room, pos) not in occupied:
                free_beds.append({"room": room, "position": pos, "label": f"Chambre {room}{pos} — {'fenêtre' if pos == 'F' else 'porte'}"})
    return jsonify(patients=[dict(r) for r in rows], free_beds=free_beds)


@app.get("/api/archives")
@login_required
def api_archives():
    q = (request.args.get("q") or "").strip()
    sql = "SELECT id, nom, prenom, ip, motif, sortie_date, sortie_mode FROM patients WHERE status='sorti'"
    args = []
    if q:
        sql += " AND (nom LIKE ? OR prenom LIKE ? OR ip LIKE ?)"
        args = [f"%{q}%"] * 3
    sql += " ORDER BY sortie_date DESC, id DESC LIMIT 300"
    return jsonify(patients=[dict(r) for r in db().execute(sql, args).fetchall()])


@app.get("/api/search")
@login_required
def api_search():
    """Recherche sur tous les patients de la plateforme : hospitalisés, sortis et urgences visibles."""
    q = (request.args.get("q") or "").strip()
    if len(q) < 2:
        return jsonify(patients=[], urgences=[])
    like = f"%{normalize_text(q)}%"
    rows = db().execute(
        """SELECT id, nom, prenom, ip, cin, motif, room, position, hors_service, status, date_entree, sortie_date
           FROM patients
           WHERE norm(nom) LIKE ? OR norm(prenom) LIKE ? OR norm(nom || ' ' || prenom) LIKE ? OR norm(prenom || ' ' || nom) LIKE ?
              OR ip LIKE ? OR norm(cin) LIKE ? OR norm(motif) LIKE ?
           ORDER BY CASE status WHEN 'hospitalise' THEN 0 ELSE 1 END, nom, prenom LIMIT 60""",
        [like] * 7,
    ).fetchall()
    urgences = []
    search_urgences = app.config.get("URGENCES_SEARCH")
    if search_urgences:
        urgences = search_urgences(like)
    return jsonify(patients=[dict(r) for r in rows], urgences=urgences)


PATIENT_FIELDS = ["cin", "motif_code", "motif_id", "sexe", "nom", "prenom", "age", "ip", "mutuelle", "groupe", "motif", "room", "position",
                  "hors_service", "date_entree"]


def clean_patient_payload(data, existing_id=None):
    out = {k: data.get(k) for k in PATIENT_FIELDS if k in data}
    for k in ("nom", "prenom", "ip", "mutuelle", "groupe", "motif", "hors_service", "room", "position", "date_entree"):
        if k in out and out[k] is not None:
            out[k] = str(out[k]).strip()
    if 'cin' in out:
        out['cin'] = str(out['cin'] or '').strip().upper()
        if len(out['cin']) > 40:
            raise ValueError('CIN trop long (40 caractères maximum).')
    if 'motif_id' in out:
        try:
            mid = int(out['motif_id']) if out['motif_id'] not in (None, '') else None
        except (ValueError, TypeError):
            raise ValueError('Motif sélectionné invalide.')
        out['motif_id'] = mid
        if mid is not None:
            selected = db().execute('SELECT id,name,code FROM hospit_motifs WHERE id=?', (mid,)).fetchone()
            if not selected:
                raise ValueError('Ce motif a été supprimé : choisissez de nouveau un motif.')
            out['motif'] = selected['name']
            out['motif_code'] = selected['code']
        else:
            out['motif_code'] = str(out.get('motif_code') or '').strip().upper()
    elif 'motif' in out:
        # Un ancien client changeant le texte ne doit pas conserver le code de l'ancien motif.
        out['motif_id'] = None
        out['motif_code'] = str(out.get('motif_code') or '').strip().upper()
    if 'motif_code' in out:
        out['motif_code'] = str(out['motif_code'] or '').strip().upper()
        if out['motif_code'] and not re.fullmatch(r'[A-Z][0-9]{2}(?:\.[0-9A-Z]{1,4})?', out['motif_code']):
            raise ValueError('Format du code CIM-10 invalide.')
    if "sexe" in out:
        out["sexe"] = str(out["sexe"] or "").strip().upper()
        if out["sexe"] not in ("", "M", "F"):
            raise ValueError("Sexe invalide.")
    if "nom" in out:
        out["nom"] = out["nom"].upper()
    if "age" in out:
        try:
            out["age"] = int(out["age"]) if str(out["age"]).strip() != "" else None
        except ValueError:
            raise ValueError("L'âge doit être un nombre.")
    # Emplacement : soit chambre + lit, soit hors service
    if out.get("hors_service"):
        out["room"] = None
        out["position"] = None
    else:
        if "hors_service" in out:
            out["hors_service"] = None
        room, pos = out.get("room"), out.get("position")
        if room or pos:
            if room not in ROOMS or pos not in POSITIONS:
                raise ValueError("Chambre ou lit invalide.")
            previous = db().execute("SELECT room, position, status FROM patients WHERE id=?", (existing_id,)).fetchone() if existing_id else None
            unchanged = previous and previous["status"] == "hospitalise" and previous["room"] == room and previous["position"] == pos
            if not unchanged:
                if room in ("201", "218"):
                    raise ValueError("Cette chambre est actuellement indisponible.")
                if room in ("201", "202", "203", "213", "218"):
                    if pos != "F":
                        raise ValueError("Cette chambre ne comporte qu'un lit unique.")
                    occupied = db().execute("SELECT id FROM patients WHERE status='hospitalise' AND room=? AND id != ?", (room, existing_id or -1)).fetchone()
                    if occupied:
                        raise ValueError("Le lit unique de cette chambre est déjà occupé.")
            if bed_taken(room, pos, existing_id):
                raise ValueError(f"Le lit {room}{pos} est déjà occupé.")
    return out



def bed_allocation_transaction(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        conn = db()
        conn.execute('BEGIN IMMEDIATE')
        try:
            result = fn(*args, **kwargs)
            status = result[1] if isinstance(result, tuple) and len(result)>1 else getattr(result, 'status_code', 200)
            if conn.in_transaction:
                if status >= 400: conn.rollback()
                else: conn.commit()
            return result
        except Exception:
            conn.rollback()
            raise
    return wrapped

@app.post("/api/patients")
@login_required
@bed_allocation_transaction
def api_create_patient():
    data = request.get_json(silent=True) or {}
    try:
        p = clean_patient_payload(data)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    if not p.get("nom") or not p.get("ip"):
        return jsonify(error="Nom et IP sont obligatoires."), 400
    if not p.get("room") and not p.get("hors_service"):
        return jsonify(error="Choisissez un lit ou un service d'hébergement."), 400
    p.setdefault("date_entree", platform_now().date().isoformat())
    cols = list(p.keys()) + ["created_at"]
    cur = db().execute(
        f"INSERT INTO patients({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
        [*p.values(), now()],
    )
    pid = cur.lastrowid
    where = f"chambre {p['room']}{p['position']}" if p.get("room") else f"hors service : {p['hors_service']}"
    log(pid, "Admission", f"{p['nom']} {p.get('prenom', '')} - IP {p['ip']} - {where}")
    db().commit()
    return jsonify(id=pid), 201


@app.get("/api/patients/<int:pid>")
@login_required
def api_get_patient(pid):
    p = db().execute("SELECT * FROM patients WHERE id = ?", (pid,)).fetchone()
    if not p:
        return jsonify(error="Patient introuvable."), 404
    rows = db().execute(
        "SELECT * FROM entries WHERE patient_id = ? ORDER BY date DESC, id DESC", (pid,)
    ).fetchall()
    entries = {k: [] for k in ENTRY_KINDS}
    for r in rows:
        entries.setdefault(r["kind"], []).append(dict(r))
    return jsonify(patient=dict(p), entries=entries)


@app.put("/api/patients/<int:pid>")
@login_required
@bed_allocation_transaction
def api_update_patient(pid):
    old = db().execute("SELECT * FROM patients WHERE id = ?", (pid,)).fetchone()
    if not old:
        return jsonify(error="Patient introuvable."), 404
    data = request.get_json(silent=True) or {}
    try:
        p = clean_patient_payload(data, existing_id=pid)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    if not p:
        return jsonify(ok=True)
    changes = []
    labels = {"cin": "CIN", "motif_code": "Code CIM-10", "motif_id": "Référence motif", "nom": "Nom", "prenom": "Prénom", "age": "Âge", "ip": "IP", "mutuelle": "Mutuelle",
              "groupe": "Groupe", "motif": "Motif", "room": "Chambre", "position": "Lit",
              "hors_service": "Hors service", "date_entree": "Date d'entrée"}
    for k, v in p.items():
        if (old[k] or "") != (v or ""):
            changes.append(f"{labels.get(k, k)} : {old[k] or '-'} → {v or '-'}")
    db().execute(
        f"UPDATE patients SET {', '.join(f'{k} = ?' for k in p)} WHERE id = ?", [*p.values(), pid]
    )
    if changes:
        log(pid, "Modification du dossier", " | ".join(changes))
    db().commit()
    return jsonify(ok=True)


@app.post("/api/patients/<int:pid>/sortie")
@login_required
def api_sortie(pid):
    p = db().execute("SELECT * FROM patients WHERE id = ?", (pid,)).fetchone()
    if not p:
        return jsonify(error="Patient introuvable."), 404
    data = request.get_json(silent=True) or {}
    fields = {k: (data.get(k) or "").strip() for k in
              ("sortie_date", "sortie_mode", "sortie_destination", "sortie_resume", "sortie_ordonnance")}
    # SORTIE V3 : rendez-vous retirés du formulaire (valeur existante conservée), médecin responsable ajouté.
    if "sortie_rdv" in data:
        fields["sortie_rdv"] = (data.get("sortie_rdv") or "").strip()
    if "sortie_medecin" in data:
        fields["sortie_medecin"] = (data.get("sortie_medecin") or "").strip()[:300]
    if not fields["sortie_mode"].startswith("Transfert"):
        fields["sortie_destination"] = ""
    validate = bool(data.get("valider"))
    # Admission date is editable from SORTIE without clearing it for older clients.
    if "date_entree" in data:
        raw_entry=data.get("date_entree")
        if raw_entry is not None and not isinstance(raw_entry,str):
            return jsonify(error="Date d’entrée invalide."),400
        fields["date_entree"]=(raw_entry or "").strip()
    entry_date=fields.get("date_entree",p["date_entree"] or "")
    exit_date=fields["sortie_date"]
    try:
        admission=dt.date.fromisoformat(entry_date) if entry_date else None
        discharge=dt.date.fromisoformat(exit_date) if exit_date else None
    except ValueError:
        return jsonify(error="Date d’entrée ou de sortie invalide."),400
    if admission and discharge and discharge<admission:
        return jsonify(error="La date de sortie ne peut pas précéder la date d’entrée."),400
    if validate and not admission:
        return jsonify(error="Renseignez la date d’entrée avant de valider la sortie."),400
    if "date_entree" in fields and (p["date_entree"] or "")!=entry_date:
        log(pid,"Date d’entrée modifiée depuis SORTIE",str(p["date_entree"] or "-")+" → "+entry_date)
    if validate and (not fields["sortie_date"] or not fields["sortie_mode"]):
        return jsonify(error="Date et mode de sortie obligatoires pour valider la sortie."), 400
    sets = dict(fields)
    if validate:
        sets["status"] = "sorti"
    db().execute(f"UPDATE patients SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?", [*sets.values(), pid])
    if validate:
        where = f"chambre {p['room']}{p['position']}" if p["room"] else (p["hors_service"] or "-")
        log(pid, "Sortie validée", f"{fields['sortie_mode']} le {fields['sortie_date']} - libère {where}")
    else:
        log(pid, "Fiche de sortie enregistrée (brouillon)", fields["sortie_mode"])
    db().commit()
    return jsonify(ok=True)


def archive_previous_stay(previous, author_name):
    """Réadmission : l'ancien motif d'hospitalisation devient un antécédent du dossier."""
    motif = (previous["motif"] or "").strip()
    if not motif:
        return
    text = previous_stay_sentence(previous, db())
    t = now()
    db().execute(
        """INSERT INTO entries(patient_id, kind, category, date, title, content, details, done, author, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (previous["id"], "atcd", "Hospitalisations", previous["sortie_date"] or previous["date_entree"] or "",
         "", text, "", 0, author_name, t, t),
    )


def readmit_fields(data):
    """Champs acceptés lors d'une réadmission : emplacement + nouveau motif (obligatoire)."""
    keys = ("room", "position", "hors_service", "motif", "motif_id", "motif_code")
    payload = {k: data.get(k) for k in keys if k in data}
    if not str(payload.get("motif") or "").strip() and payload.get("motif_id") in (None, ""):
        raise ValueError("Indiquez le nouveau motif d'hospitalisation.")
    return payload


@app.post("/api/patients/<int:pid>/readmettre")
@login_required
@bed_allocation_transaction
def api_readmit(pid):
    previous = db().execute("SELECT * FROM patients WHERE id=?", (pid,)).fetchone()
    if not previous:
        return jsonify(error="Patient introuvable."),404
    if previous["status"] != "sorti":
        return jsonify(error="Le patient est déjà hospitalisé."),409
    if normalize_text(previous["sortie_mode"]) == "deces":
        return jsonify(error="Impossible de réadmettre un dossier clôturé par décès."),400
    if previous["sortie_date"] and previous["sortie_date"] > platform_now().date().isoformat():
        return jsonify(error="La dernière sortie est postérieure à la réadmission."),400
    data = request.get_json(silent=True) or {}
    try:
        p = clean_patient_payload(readmit_fields(data), existing_id=pid)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    if not p.get("room") and not p.get("hors_service"):
        return jsonify(error="Choisissez un lit ou un service d'hébergement."), 400
    if not p.get("motif"):
        return jsonify(error="Indiquez le nouveau motif d'hospitalisation."), 400
    archive_previous_stay(previous, g.user["full_name"])
    db().execute(
        """UPDATE patients SET status='hospitalise', room=?, position=?, hors_service=?, motif=?, motif_id=?, motif_code=?,
           date_entree=?, sortie_date=NULL, sortie_mode=NULL, sortie_destination=NULL, sortie_resume=NULL,
           sortie_ordonnance=NULL, sortie_rdv=NULL, sortie_medecin='' WHERE id=?""",
        (p.get("room"), p.get("position"), p.get("hors_service"), p["motif"], p.get("motif_id"), p.get("motif_code") or "",
         platform_now().date().isoformat(), pid),
    )
    db().execute("UPDATE entries SET done=1, updated_at=? WHERE patient_id=? AND kind='traitement' AND COALESCE(done,0)=0", (now(),pid))
    where = f"{p.get('room') or ''}{p.get('position') or ''} {p.get('hors_service') or ''}".strip()
    log(pid, "Réadmission", f"{where} — nouveau motif : {p['motif']} (ancien motif archivé en antécédent)")
    db().commit()
    return jsonify(ok=True)


@app.post("/api/patients/<int:pid>/echanger-lit")
@login_required
@bed_allocation_transaction
def api_swap_beds(pid):
    """Échange les emplacements de deux patients hospitalisés, ou déplace un patient vers un lit libre
    (``room`` + ``position``) ou hors service (``hors_service``)."""
    data = request.get_json(silent=True) or {}
    if data.get("target_id") in (None, ""):
        return _move_to_free_bed(pid, data)
    try:
        target_id = int(data.get("target_id"))
    except (TypeError, ValueError):
        return jsonify(error="Choisissez le patient avec qui échanger."), 400
    if target_id == pid:
        return jsonify(error="Choisissez un autre patient."), 400
    a = db().execute("SELECT id, nom, prenom, room, position, hors_service, status FROM patients WHERE id=?", (pid,)).fetchone()
    b = db().execute("SELECT id, nom, prenom, room, position, hors_service, status FROM patients WHERE id=?", (target_id,)).fetchone()
    if not a or not b:
        return jsonify(error="Patient introuvable."), 404
    if a["status"] != "hospitalise" or b["status"] != "hospitalise":
        return jsonify(error="Les deux patients doivent être hospitalisés dans le service."), 409
    if not (a["room"] or a["hors_service"]) or not (b["room"] or b["hors_service"]):
        return jsonify(error="Un des deux patients n'a pas d'emplacement défini."), 409

    def place(r):
        return f"{r['room']}{r['position']}" if r["room"] else f"hors service : {r['hors_service']}"
    if place(a) == place(b):
        return jsonify(error="Les deux patients occupent déjà le même emplacement."), 400
    # Libère temporairement le premier lit pour respecter la contrainte d'unicité des lits.
    db().execute("UPDATE patients SET room=NULL, position=NULL, hors_service='__echange__' WHERE id=?", (a["id"],))
    db().execute("UPDATE patients SET room=?, position=?, hors_service=? WHERE id=?", (a["room"], a["position"], a["hors_service"], b["id"]))
    db().execute("UPDATE patients SET room=?, position=?, hors_service=? WHERE id=?", (b["room"], b["position"], b["hors_service"], a["id"]))
    for src, dst in ((a, b), (b, a)):
        log(src["id"], "Changement de lit (échange)",
            f"{place(src)} → {place(dst)} — échangé avec {dst['nom']} {dst['prenom'] or ''}".strip())
    db().commit()
    return jsonify(ok=True, a={"id": a["id"], "room": b["room"], "position": b["position"], "hors_service": b["hors_service"]},
                   b={"id": b["id"], "room": a["room"], "position": a["position"], "hors_service": a["hors_service"]})


def _move_to_free_bed(pid, data):
    a = db().execute("SELECT id, nom, prenom, room, position, hors_service, status FROM patients WHERE id=?", (pid,)).fetchone()
    if not a:
        return jsonify(error="Patient introuvable."), 404
    if a["status"] != "hospitalise":
        return jsonify(error="Le patient doit être hospitalisé dans le service."), 409
    payload = {"room": data.get("room"), "position": data.get("position"), "hors_service": data.get("hors_service")}
    if not payload["hors_service"] and not (payload["room"] and payload["position"]):
        return jsonify(error="Choisissez un lit libre, un patient avec qui échanger ou un service d'hébergement."), 400
    try:
        p = clean_patient_payload(payload, existing_id=pid)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400

    def place(room, position, hs):
        return f"{room}{position}" if room else f"hors service : {hs}"
    before = place(a["room"], a["position"], a["hors_service"])
    after = place(p.get("room"), p.get("position"), p.get("hors_service"))
    if before == after:
        return jsonify(error="Le patient occupe déjà cet emplacement."), 400
    db().execute("UPDATE patients SET room=?, position=?, hors_service=? WHERE id=?",
                 (p.get("room"), p.get("position"), p.get("hors_service"), pid))
    log(pid, "Changement de lit", f"{before} → {after}")
    db().commit()
    return jsonify(ok=True, a={"id": pid, "room": p.get("room"), "position": p.get("position"), "hors_service": p.get("hors_service")})


def patient_purge_targets(pid):
    """Clés de stockage et passages aux urgences liés à un dossier, avant sa suppression définitive."""
    conn = db()
    keys = ["imaging/" + r[0] for r in conn.execute(
        """SELECT DISTINCT e.content FROM entries e WHERE e.patient_id=? AND e.kind='video' AND e.category='fichier' AND e.content != ''
           AND NOT EXISTS (SELECT 1 FROM entries o WHERE o.patient_id != e.patient_id AND o.category='fichier' AND o.content=e.content)""",
        (pid,)).fetchall()]
    for sql, folder in (("SELECT storage_name FROM patient_documents WHERE patient_id=? AND COALESCE(storage_name,'') != ''", "patient_documents"),
                        ("SELECT doc_storage FROM cro_reports WHERE patient_id=? AND COALESCE(doc_storage,'') != ''", "cro")):
        try:
            keys += [folder + "/" + r[0] for r in conn.execute(sql, (pid,)).fetchall() if os.path.basename(r[0]) == r[0]]
        except sqlite3.OperationalError:
            pass
    try:
        urg_ids = urgences_linked_ids(conn, [r[0] for r in conn.execute("SELECT id FROM urg_patients WHERE patient_id=?", (pid,))])
    except sqlite3.OperationalError:
        urg_ids = []
    return keys, urg_ids


@app.get("/api/patients/<int:pid>/suppression")
@admin_required
def api_delete_patient_preview(pid):
    """Résumé de ce que supprimerait la suppression définitive (affiché avant confirmation)."""
    p = db().execute("SELECT id, nom, prenom, ip, status FROM patients WHERE id = ?", (pid,)).fetchone()
    if not p:
        return jsonify(error="Patient introuvable."), 404
    keys, urg_ids = patient_purge_targets(pid)
    entries = db().execute("SELECT COUNT(*) FROM entries WHERE patient_id=?", (pid,)).fetchone()[0]
    logs_count = db().execute("SELECT COUNT(*) FROM logs WHERE patient_id=?", (pid,)).fetchone()[0]
    return jsonify(patient=dict(p), entries=entries, files=len(keys), urgences=len(urg_ids), logs=logs_count)


@app.delete("/api/patients/<int:pid>")
@admin_required
def api_delete_patient(pid):
    """Suppression DÉFINITIVE d'un dossier (hospitalisé ou sorti) : entrées, documents, imageries, CRO, traitements,
    régimes, séjours statistiques, journal du patient et passages aux urgences liés (avec leur historique)."""
    conn = db()
    conn.execute("BEGIN IMMEDIATE")
    try:
        p = conn.execute("SELECT id, nom, prenom, ip FROM patients WHERE id = ?", (pid,)).fetchone()
        if not p:
            conn.rollback()
            return jsonify(error="Patient introuvable."), 404
        keys, urg_ids = patient_purge_targets(pid)
        keys += urgences_purge(conn, urg_ids)
        for sql in ("DELETE FROM service_treatment_history WHERE patient_id=?", "DELETE FROM logs WHERE patient_id=?"):
            try:
                conn.execute(sql, (pid,))
            except sqlite3.OperationalError:
                pass  # table absente dans cette version
        conn.execute("DELETE FROM patients WHERE id = ?", (pid,))  # le reste suit par ON DELETE CASCADE
        log(None, "Suppression définitive d'un dossier",
            f"id {pid} — {p['nom']} {p['prenom'] or ''} (IP {p['ip']}) — {len(keys)} fichier(s), {len(urg_ids)} passage(s) aux urgences".strip())
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    for key in keys:
        storage.delete(key)
    return jsonify(ok=True, removed_files=len(keys), removed_urgences=len(urg_ids))


# -------------------------------------------------------------------- Entries
ENTRY_FIELDS = ["category", "date", "title", "content", "details", "done"]


def entry_summary(e):
    txt = (e.get("title") or e.get("content") or "").replace("\n", " ")
    bits = [e.get("category") or "", e.get("date") or "", txt[:120]]
    return " - ".join(b for b in bits if b)


@app.post("/api/patients/<int:pid>/entries")
@login_required
def api_add_entry(pid):
    if not db().execute("SELECT 1 FROM patients WHERE id = ?", (pid,)).fetchone():
        return jsonify(error="Patient introuvable."), 404
    data = request.get_json(silent=True) or {}
    kind = data.get("kind")
    if kind not in ENTRY_KINDS:
        return jsonify(error="Type d'entrée invalide."), 400
    e = {k: data.get(k, "" if k != "done" else 0) for k in ENTRY_FIELDS}
    e["done"] = 1 if e["done"] else 0
    if not (str(e["content"]).strip() or str(e["title"]).strip()):
        return jsonify(error="Le contenu est vide."), 400
    t = now()
    cur = db().execute(
        """INSERT INTO entries(patient_id, kind, category, date, title, content, details, done, author,
           created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (pid, kind, e["category"], e["date"], e["title"], e["content"], e["details"], e["done"],
         g.user["full_name"], t, t),
    )
    if kind == "consigne":
        db().execute("UPDATE entries SET author_username=?, validated_by_username=?, validated_at=? WHERE id=?",
                     (g.user["username"], g.user["username"] if e["done"] else "", t if e["done"] else "", cur.lastrowid))
    log(pid, f"{KIND_LABEL[kind]} ajouté(e)", entry_summary(e))
    db().commit()
    return jsonify(id=cur.lastrowid), 201


@app.put("/api/entries/<int:eid>")
@login_required
def api_update_entry(eid):
    old = db().execute("SELECT * FROM entries WHERE id = ?", (eid,)).fetchone()
    if not old:
        return jsonify(error="Entrée introuvable."), 404
    data = request.get_json(silent=True) or {}
    upd = {k: data[k] for k in ENTRY_FIELDS if k in data}
    if "done" in upd:
        upd["done"] = 1 if upd["done"] else 0
    if not upd:
        return jsonify(ok=True)
    upd["updated_at"] = now()
    status_only = set(upd) == {"done", "updated_at"}
    if old["kind"] == "consigne" and "done" in upd and upd["done"] != old["done"]:
        upd["validated_by_username"] = g.user["username"] if upd["done"] else ""
        upd["validated_at"] = upd["updated_at"] if upd["done"] else ""

    db().execute(f"UPDATE entries SET {', '.join(f'{k} = ?' for k in upd)} WHERE id = ?", [*upd.values(), eid])
    merged = {**dict(old), **upd}
    label = KIND_LABEL.get(old["kind"], old["kind"])
    if status_only:
        if old["kind"] == "consigne":
            action = "Consigne validée" if upd["done"] else "Consigne remise à faire"
        else:
            action = f"{label} : statut modifié"
    else:
        action = f"{label} modifié(e)"
    log(old["patient_id"], action, entry_summary(merged))
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/entries/<int:eid>")
@login_required
def api_delete_entry(eid):
    old = db().execute("SELECT * FROM entries WHERE id = ?", (eid,)).fetchone()
    if not old:
        return jsonify(error="Entrée introuvable."), 404
    db().execute("DELETE FROM entries WHERE id = ?", (eid,))
    log(old["patient_id"], f"{KIND_LABEL.get(old['kind'], old['kind'])} supprimé(e)", entry_summary(dict(old)))
    db().commit()
    if old["kind"] == "video" and old["category"] == "fichier" and old["content"]:
        still_used = db().execute("SELECT 1 FROM entries WHERE category='fichier' AND content=? LIMIT 1", (old["content"],)).fetchone()
        if not still_used:
            storage.delete("imaging/" + old["content"])
    return jsonify(ok=True)


# ------------------------------------------------------------- Video upload
ALLOWED_VIDEO = {".mp4", ".webm", ".mov", ".m4v", ".ogg", ".jpg", ".jpeg", ".png"}


IMAGING_MIMES = {".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/mp4",
                 ".ogg": "video/ogg", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}


@app.post("/api/patients/<int:pid>/upload")
@login_required
def api_upload(pid):
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="Aucun fichier."), 400
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ALLOWED_VIDEO:
        return jsonify(error="Format non supporté (mp4, webm, mov, jpg, png)."), 400
    if not db().execute("SELECT 1 FROM patients WHERE id = ?", (pid,)).fetchone():
        return jsonify(error="Patient introuvable."), 404
    # Nom de stockage opaque (le nom d'origine est conservé dans le titre).
    name = f"{pid}_{secrets.token_hex(16)}{ext}"
    key = "imaging/" + name
    try:
        f.stream.seek(0, 2)
        size = f.stream.tell()
        f.stream.seek(0)
    except (OSError, ValueError):
        size = None
    if size == 0:
        return jsonify(error="Le fichier est vide."), 400
    try:
        storage.save(key, f.stream, IMAGING_MIMES.get(ext, "application/octet-stream"))
    except StorageError as exc:
        logger.error("Téléversement imagerie impossible : %s", exc)
        return jsonify(error=str(exc)), 503
    t = now()
    title = (request.form.get("title") or f.filename)[:240]
    date = request.form.get("date") or platform_now().date().isoformat()
    try:
        db().execute(
            """INSERT INTO entries(patient_id, kind, category, date, title, content, details, done, author,
               created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (pid, "video", "fichier", date, title, name, request.form.get("details", ""), 0, g.user["full_name"], t, t),
        )
        log(pid, "Vidéo ajoutée", title)
        db().commit()
    except Exception:
        db().rollback()
        storage.delete(key)
        raise
    return jsonify(ok=True), 201


# ----------------------------------------------------------------------- Logs
@app.get("/api/patients/<int:pid>/logs")
@staff_required  # LOGS MODERATEUR V1
def api_logs(pid):
    rows = db().execute("SELECT * FROM logs WHERE patient_id = ? ORDER BY id DESC", (pid,)).fetchall()
    return jsonify(logs=[dict(r) for r in rows])


@app.get("/api/logs")
@staff_required
def api_all_logs():
    rows = db().execute(
        """SELECT l.*, p.nom, p.prenom, p.ip FROM logs l LEFT JOIN patients p ON p.id = l.patient_id
           ORDER BY l.id DESC LIMIT 500"""
    ).fetchall()
    return jsonify(logs=[dict(r) for r in rows])
