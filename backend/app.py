from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import uuid

from flask import Flask, jsonify, request
from flask_cors import CORS
from openai import OpenAI
import sqlite3
import datetime

from backend.default_inventory import DEFAULT_INVENTORY

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "prototype"

app = Flask(
    __name__,
    static_folder=str(FRONTEND_DIR),
    static_url_path="",
)
CORS(app, resources={r"/*": {"origins": "*"}})

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
MOCK_VISION = os.environ.get("MOCK_VISION", "0") == "1"

client = None
if OPENAI_API_KEY:
    try:
        client = OpenAI(api_key=OPENAI_API_KEY)
    except Exception:
        client = None
else:
    if not MOCK_VISION:
        # warn user when not in mock mode
        print("WARNING: OPENAI_API_KEY not set. Set OPENAI_API_KEY or enable MOCK_VISION=1 to use mock responses.")

# SQLite DB for storing reports and inventories
DB_PATH = os.path.join(os.path.dirname(__file__), "data.db")


def _generate_item_id() -> str:
    return f"item-{uuid.uuid4()}"


def _build_default_inventory_state() -> list[dict]:
    return [
        {
            "id": _generate_item_id(),
            "name": item.get("name", ""),
            "ideal": item.get("ideal", 0),
            "current": item.get("ideal", 0),
        }
        for item in DEFAULT_INVENTORY
    ]


def init_db() -> None:
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY,
            created_at TEXT NOT NULL,
            notes TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS inventories (
            id INTEGER PRIMARY KEY,
            report_id INTEGER NOT NULL,
            name TEXT,
            ideal INTEGER,
            current INTEGER,
            FOREIGN KEY(report_id) REFERENCES reports(id)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS app_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            inventory_json TEXT,
            report_json TEXT,
            photo_json TEXT,
            updated_at TEXT NOT NULL
        )
        """
    )
    cur.execute(
        """
        INSERT OR IGNORE INTO app_state (id, inventory_json, report_json, photo_json, updated_at)
        VALUES (1, '[]', '{}', 'null', ?)
        """,
        (datetime.datetime.utcnow().isoformat(),),
    )
    conn.commit()
    conn.close()
    seed_default_app_state()


def seed_default_app_state() -> None:
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT inventory_json FROM app_state WHERE id = 1")
    row = cur.fetchone()
    if not row:
        conn.close()
        return
    inventory_json = row[0]
    try:
        existing = json.loads(inventory_json or "[]")
    except json.JSONDecodeError:
        existing = []
    if existing:
        conn.close()
        return
    default_inventory = _build_default_inventory_state()
    timestamp = datetime.datetime.utcnow().isoformat()
    cur.execute(
        """
        UPDATE app_state
        SET inventory_json = ?, updated_at = ?
        WHERE id = 1
        """,
        (json.dumps(default_inventory, ensure_ascii=False), timestamp),
    )
    conn.commit()
    conn.close()


def save_report(data: dict) -> int:
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    created_at = datetime.datetime.utcnow().isoformat()
    notes = data.get("notes")
    cur.execute("INSERT INTO reports (created_at, notes) VALUES (?, ?)", (created_at, notes))
    report_id = cur.lastrowid
    for item in data.get("inventory", []):
        cur.execute(
            "INSERT INTO inventories (report_id, name, ideal, current) VALUES (?, ?, ?, ?)",
            (
                report_id,
                item.get("name"),
                item.get("ideal") if isinstance(item.get("ideal"), int) else None,
                item.get("current") if isinstance(item.get("current"), int) else None,
            ),
        )
    conn.commit()
    conn.close()
    return report_id


def get_latest_report():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT id, created_at, notes FROM reports ORDER BY id DESC LIMIT 1")
    row = cur.fetchone()
    if not row:
        conn.close()
        return None
    report_id, created_at, notes = row
    cur.execute(
        "SELECT name, ideal, current FROM inventories WHERE report_id = ? ORDER BY id",
        (report_id,),
    )
    items = [
        {"name": r[0], "ideal": r[1], "current": r[2]} for r in cur.fetchall()
    ]
    conn.close()
    return {"id": report_id, "created_at": created_at, "notes": notes, "inventory": items}


# initialize DB on import
init_db()


def _extract_base64_from_file(file_storage) -> str:
    data = file_storage.read()
    return base64.b64encode(data).decode("utf-8")


def _load_app_state() -> dict:
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        "SELECT inventory_json, report_json, photo_json, updated_at FROM app_state WHERE id = 1"
    )
    row = cur.fetchone()
    conn.close()
    if not row:
        return {"inventory": [], "report": {}, "photo": None, "updated_at": None}
    inventory_json, report_json, photo_json, updated_at = row
    return {
        "inventory": json.loads(inventory_json or "[]"),
        "report": json.loads(report_json or "{}"),
        "photo": json.loads(photo_json or "null"),
        "updated_at": updated_at,
    }


def _sanitize_app_state(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")

    base_state = _load_app_state()
    inventory = payload.get("inventory", base_state["inventory"])
    report = payload.get("report", base_state["report"])
    photo = payload.get("photo", base_state["photo"])

    if inventory is not None and not isinstance(inventory, list):
        raise ValueError("inventory must be an array")
    if report is not None and not isinstance(report, dict):
        raise ValueError("report must be an object")
    if photo is not None and not isinstance(photo, dict):
        raise ValueError("photo must be an object or null")

    return {
        "inventory": inventory or [],
        "report": report or {},
        "photo": photo,
    }


def save_app_state(payload: dict) -> dict:
    sanitized = _sanitize_app_state(payload)
    timestamp = datetime.datetime.utcnow().isoformat()
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE app_state
        SET inventory_json = ?, report_json = ?, photo_json = ?, updated_at = ?
        WHERE id = 1
        """,
        (
            json.dumps(sanitized["inventory"], ensure_ascii=False),
            json.dumps(sanitized["report"], ensure_ascii=False),
            json.dumps(sanitized["photo"], ensure_ascii=False),
            timestamp,
        ),
    )
    conn.commit()
    conn.close()
    sanitized["updated_at"] = timestamp
    return sanitized


@app.route("/", methods=["GET"])
def frontend_index():
    if FRONTEND_DIR.exists():
        return app.send_static_file("index.html")
    return jsonify({"status": "ok", "service": "Takoyaki Vision API"})


@app.route("/api/health", methods=["GET"])
def api_health():
    return jsonify({"status": "ok", "service": "Takoyaki Vision API"})


@app.route("/vision/analyze", methods=["POST"])
def analyze_inventory():
    # Accept either multipart file (field 'image') or JSON/form 'image_base64'
    instructions = request.form.get("instructions") or (request.json or {}).get("instructions") if request.is_json else "Detect which takoyaki ingredients are running low. Output JSON list with name, ideal, current."

    image_base64 = None
    if "image" in request.files:
        image_base64 = _extract_base64_from_file(request.files["image"])  # raw base64
    else:
        # try form field or JSON
        if request.form.get("image_base64"):
            image_base64 = request.form.get("image_base64")
        elif request.is_json and (request.json or {}).get("image_base64"):
            image_base64 = (request.json or {}).get("image_base64")

    if not image_base64:
        return jsonify({"error": "image or image_base64 is required"}), 400

    # If data URL, strip prefix
    try:
        if "," in image_base64:
            _, image_base64 = image_base64.split(",", 1)
        base64.b64decode(image_base64)
    except Exception:
        return jsonify({"error": "Invalid base64 image"}), 400

    messages = [
        {"role": "system", "content": "You are a vision assistant for a takoyaki shop inventory app."},
        {
            "role": "user",
            "content": [
                {"type": "input_text", "text": instructions},
                {"type": "input_image", "image_base64": image_base64},
            ],
        },
    ]

    # If mock mode is enabled, return a simulated response for local testing
    if MOCK_VISION:
        simulated = {
            "inventory": [
                {"name": "サラダ油（8個入り）", "ideal": 8, "current": 6},
                {"name": "出汁セット", "ideal": 3, "current": 3},
                {"name": "タコ（1袋）", "ideal": 2, "current": 1},
            ],
            "notes": "これはモック応答です。MOCK_VISION=1 により生成されています。",
        }
        # Persist mock output too, so local testing matches production flow.
        try:
            save_report(simulated)
        except Exception as exc:
            print("WARNING: Failed to save mock report to DB:", exc)
        return jsonify(simulated)

    if client is None:
        return (
            jsonify({
                "error": "OpenAI client not configured. Set OPENAI_API_KEY or enable MOCK_VISION=1 to test locally.",
            }),
            501,
        )

    try:
        response = client.responses.create(
            model="gpt-4.1-mini",
            input=messages,
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "inventory_schema",
                    "schema": {
                        "type": "object",
                        "properties": {
                            "inventory": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "name": {"type": "string"},
                                        "ideal": {"type": "integer"},
                                        "current": {"type": "integer"},
                                    },
                                    "required": ["name", "current"],
                                    "additionalProperties": False,
                                },
                            },
                            "notes": {"type": "string"},
                        },
                        "required": ["inventory"],
                        "additionalProperties": False,
                    },
                },
            },
        )
    except Exception as exc:
        return jsonify({"error": "failed to call model", "detail": str(exc)}), 500

    try:
        json_content = response.output_json()
    except Exception as exc:
        return jsonify({"error": "Failed to parse model response", "detail": str(exc)}), 500

    # persist the model output to SQLite (best-effort)
    try:
        save_report(json_content)
    except Exception as exc:
        # don't fail the request if saving fails; log for debugging
        print("WARNING: Failed to save report to DB:", exc)

    return jsonify(json_content)


@app.route("/reports/latest", methods=["GET"])
def reports_latest():
    rpt = get_latest_report()
    if rpt is None:
        return jsonify({"error": "no reports found"}), 404
    return jsonify(rpt)


@app.route("/state", methods=["GET"])
def get_state():
    return jsonify(_load_app_state())


@app.route("/state", methods=["PUT"])
def update_state():
    data = request.get_json(silent=True)
    if data is None:
        return jsonify({"error": "JSON body is required"}), 400
    try:
        updated = save_app_state(data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(updated)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    app.run(host="0.0.0.0", port=port, debug=True)
