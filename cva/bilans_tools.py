import json
import os
import re
import math
import datetime as dt

from .config import DATA_DIR

GROUPS = [['Alb', ['Alb']], ['GB', ['GB']], ['Lymphocytes', ['Lymphocytes']], ['Hb', ['Hb']], ['Plq', ['Plq']], ['TP', ['TP']], ['CRP', ['CRP']], ['Lipase', ['Lipase']], ['BT/BD', ['BT', 'BD']], ['GGT/PAL', ['GGT', 'PAL']], ['ASAT/ALAT', ['ASAT', 'ALAT']], ['Urée/Créat', ['Uree', 'Creat']], ['Na/K', ['Na', 'K']], ['ECBU', ['ECBU']], ['ACE', ['ACE']], ['CA19-9', ['CA19-9']], ['CA125', ['CA125']], ['CA15-3', ['CA15-3']], ['Bilan lipidique', ['Cholesterol', 'HDL', 'LDL', 'Triglycerides']], ['Ph/Ca', ['Ph', 'Ca']], ['Pus profond', ['PusProfondPrelevement', 'PusProfondResultat']], ['Pus superficiel', ['PusSuperficielPrelevement', 'PusSuperficielResultat']], ['Autre', ['Autre']]]
KEYS = [k for _, keys in GROUPS for k in keys]
MULTIPLES = {"Lipase", "BT", "BD", "GGT", "PAL", "ASAT", "ALAT"}

def number(v):
    s = str(v or "").strip().replace(",", ".")
    if not s:
        return None
    try:
        n = float(s)
        return n if math.isfinite(n) else None
    except ValueError:
        return None

def decode(e):
    try:
        p = json.loads(e.get("details") or "")
        return p if isinstance(p, dict) and p.get("schema") == "bilan-v1" and isinstance(p.get("values"), dict) else None
    except (ValueError, TypeError):
        return None

def validate(p):
    if not isinstance(p, dict) or p.get("schema") != "bilan-v1":
        raise ValueError("Format de bilan invalide.")
    values = p.get("values", {})
    if not isinstance(values, dict) or set(values)-set(KEYS):
        raise ValueError("Paramètres de bilan invalides.")
    cleaned = {}
    for key, item in values.items():
        if not isinstance(item, dict):
            raise ValueError("Champ invalide.")
        row = {name: str(item.get(name) or "").strip() for name in ("value", "unit", "min", "max")}
        if any(len(v)>4000 for v in row.values()):
            raise ValueError("Champ trop long.")
        for name in ("min", "max"):
            if row[name] and number(row[name]) is None:
                raise ValueError("Référence numérique invalide pour " + key)
        lo, hi = number(row["min"]), number(row["max"])
        if lo is not None and hi is not None and lo>hi:
            raise ValueError("Minimum supérieur au maximum pour " + key)
        if (row["min"] or row["max"]) and not row["unit"]:
            raise ValueError("Unité requise pour interpréter " + key)
        cleaned[key] = row
    if not any(r["value"] for r in cleaned.values()):
        raise ValueError("Renseignez au moins un résultat.")
    return {"schema":"bilan-v1", "values":cleaned, **({"legacy_original":str(p["legacy_original"])[:50000]} if p.get("legacy_original") else {})}

def parts(row, key):
    if not row or not row.get("value"):
        return "—", False
    text = row["value"]
    value = number(text)
    lo, hi = number(row.get("min")), number(row.get("max"))
    abnormal = False
    if row.get("unit") and value is not None:
        abnormal = (lo is not None and value<lo) or (hi is not None and value>hi)
    if row.get("unit"):
        text += " " + row["unit"]
    return text, abnormal

def summary(p):
    lines = []
    for label, keys in GROUPS:
        if any(p["values"].get(k, {}).get("value") for k in keys):
            lines.append(label + " : " + " / ".join(p["values"].get(k, {}).get("value") or "—" for k in keys))
    return "\n".join(lines)



def reference_profile():
    path = os.path.join(DATA_DIR, "normes_bilans.json")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def decode_v2(e):
    try:
        p = json.loads(e.get("details") or "")
        return p if isinstance(p, dict) and p.get("schema") == "bilan-simple-v2" and isinstance(p.get("values"), dict) else None
    except (ValueError, TypeError):
        return None


def numeric_v2(v, key):
    s = str(v if v is not None else "").strip().replace(",", ".")
    if key in {"GB", "Plq"} and re.fullmatch(r"[0-9]+(?:\.[0-9]+)?[kK]", s):
        return float(s[:-1])*1000
    if not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", s):
        return None
    n = float(s)
    return n if math.isfinite(n) else None


def short_dates(items):
    dates = [str(e.get("date") or "") for e in items]
    if not dates:
        return []
    last = dates[-1]
    labels = []
    for i, value in enumerate(dates):
        if i == len(dates)-1 or len(value)!=10:
            labels.append("/".join(reversed(value.split("-"))))
        elif value[:7] == last[:7]:
            labels.append(value[8:10])
        elif value[:4] == last[:4]:
            labels.append(value[8:10]+"/"+value[5:7])
        else:
            labels.append("/".join(reversed(value.split("-"))))
    return labels


def result_v2(p, key):
    raw = p.get("values", {}).get(key, "")
    if not raw:
        return "—", False
    r = p.get("references", {}).get(key, {})
    n = numeric_v2(raw, key)
    text = raw
    abnormal = False
    if n is not None and r.get("active"):
        lo, hi = r.get("min"), r.get("max")
        abnormal = (lo is not None and n<lo) or (hi is not None and (n>=hi if r.get("max_exclusive") else n>hi))
    return text, abnormal


def summary_v2(p):
    return "\n".join(label+" : "+" / ".join(p["values"].get(k) or "—" for k in keys)
                     for label, keys in GROUPS if any(p["values"].get(k) for k in keys))


def normalize_v2(p, patient, previous=None):
    values = p.get("values")
    if not isinstance(values, dict) or set(values)-set(KEYS):
        raise ValueError("Paramètres de bilan invalides.")
    clean = {}
    for key, value in values.items():
        if not isinstance(value, str) or len(value)>4000:
            raise ValueError("Résultat invalide : "+key)
        clean[key] = value.strip()
    if not any(clean.values()):
        raise ValueError("Renseignez au moins un résultat.")
    if previous:
        snapshot = previous.get("references", {})
        version = previous.get("reference_version", "")
    else:
        cfg = reference_profile()
        age = patient["age"]
        adult = age is not None and age >= cfg.get("minimum_age",19)
        snapshot = {k:{**cfg["parameters"].get(k, {}), "active":bool(adult and cfg.get("enabled") and k in cfg["parameters"] and cfg["parameters"][k].get("auto_flag", True))}
                    for k in KEYS}
        version = cfg.get("version", "")
    return {"schema":"bilan-simple-v2", "values":clean, "references":snapshot, "reference_version":version}

def register_bilans(app, db, login_required, now=None, log=None):
    from flask import request, jsonify
    @app.get("/api/bilans/reference")
    @login_required
    def api_bilan_reference():
        cfg = reference_profile()
        return jsonify(version=cfg.get("version"), status=cfg.get("status"), enabled=cfg.get("enabled"), minimum_age=cfg.get("minimum_age"), parameters=cfg.get("parameters"))

    @app.before_request
    def validate_bilan_request():
        if request.endpoint not in {"api_add_entry", "api_update_entry"}:
            return None
        @login_required
        def check():
            data = request.get_json(silent=True) or {}
            kind = data.get("kind")
            if request.endpoint == "api_update_entry":
                row = db().execute("SELECT kind FROM entries WHERE id=?", (request.view_args["eid"],)).fetchone()
                kind = row["kind"] if row else None
            if kind != "bilan":
                return None
            raw = data.get("details")
            if not raw:
                return None
            try:
                p = json.loads(raw)
            except (ValueError, TypeError):
                return None
            if isinstance(p, dict) and p.get("schema") == "bilan-simple-v2":
                previous = None
                if request.endpoint == "api_update_entry":
                    existing = db().execute("SELECT * FROM entries WHERE id=?", (request.view_args["eid"],)).fetchone()
                    previous = decode_v2(dict(existing)) if existing else None
                    if not previous:
                        return jsonify(error="Un ancien bilan ne peut pas être converti automatiquement."), 400
                    patient_id = existing["patient_id"]
                else:
                    patient_id = request.view_args["pid"]
                patient = db().execute("SELECT * FROM patients WHERE id=?", (patient_id,)).fetchone()
                if not patient:
                    return jsonify(error="Patient introuvable."), 404
                try:
                    p = normalize_v2(p, patient, previous)
                    dt.date.fromisoformat(data.get("date") or "")
                except (ValueError, TypeError) as exc:
                    return jsonify(error=str(exc)), 400
                if request.endpoint == "api_add_entry":
                    # Serialize additions to avoid two concurrent records for the same date.
                    db().execute("BEGIN IMMEDIATE")
                    same_day = db().execute("SELECT * FROM entries WHERE patient_id=? AND kind='bilan' AND date=? ORDER BY id", (patient_id, data["date"])).fetchall()
                    matches = [(r, decode_v2(dict(r))) for r in same_day]
                    matches = [(r, existing) for r, existing in matches if existing]
                    if matches:
                        merged_values, merged_refs = {}, {}
                        for _, existing in matches:
                            for key, value in existing.get("values", {}).items():
                                if str(value or "").strip():
                                    merged_values[key] = value
                                    if key in existing.get("references", {}):
                                        merged_refs[key] = existing["references"][key]
                        for key, value in p["values"].items():
                            if value.strip():
                                merged_values[key] = (merged_values[key] + "\n\n" + value) if key == "Autre" and merged_values.get(key) else value
                                if key in p.get("references", {}):
                                    merged_refs[key] = p["references"][key]
                        p["values"] = merged_values
                        p["references"] = merged_refs
                        target_id = matches[-1][0]["id"]
                        timestamp = now() if now else dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
                        db().execute("UPDATE entries SET content=?, details=?, updated_at=? WHERE id=?", (summary_v2(p), json.dumps(p, ensure_ascii=False), timestamp, target_id))
                        if log:
                            log(patient_id, "Bilan complété (même date)", "Bilan du " + data["date"] + " — dernière valeur non vide retenue")
                        db().commit()
                        return jsonify(id=target_id, merged=True), 200
                data["details"] = json.dumps(p, ensure_ascii=False)
                data["content"] = summary_v2(p)
                return None
            if not isinstance(p, dict) or p.get("schema") != "bilan-v1":
                return None
            try:
                p = validate(p)
                dt.date.fromisoformat(data.get("date") or "")
            except (ValueError, TypeError) as exc:
                return jsonify(error=str(exc)), 400
            data["details"] = json.dumps(p, ensure_ascii=False)
            data["content"] = summary(p)
            return None
        return check()
