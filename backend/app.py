from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import threading
import uuid

from flask import Flask, jsonify, request
from flask_cors import CORS
from openai import OpenAI
import datetime

from backend.default_inventory import DEFAULT_INVENTORY

PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "prototype"
DATA_DIR = Path(__file__).resolve().parent
STATE_FILE = DATA_DIR / "app_state.json"
REPORTS_FILE = DATA_DIR / "reports.json"
STATE_LOCK = threading.Lock()
REPORTS_LOCK = threading.Lock()

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

# JSON files for storing reports and inventories


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


def _read_json_file(path: Path, default):
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default
    except json.JSONDecodeError:
        return default


def _write_json_file(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    tmp_path.replace(path)


def init_storage() -> None:
    with STATE_LOCK:
        state = _read_json_file(
            STATE_FILE,
            {
                "inventory": [],
                "report": {},
                "photo": None,
                "updated_at": None,
            },
        )
        if not state["inventory"]:
            state["inventory"] = _build_default_inventory_state()
            state["updated_at"] = datetime.datetime.utcnow().isoformat()
            _write_json_file(STATE_FILE, state)
    with REPORTS_LOCK:
        if not REPORTS_FILE.exists():
            _write_json_file(REPORTS_FILE, {"reports": []})


def save_report(data: dict) -> int:
    created_at = datetime.datetime.utcnow().isoformat()
    entry = {
        "created_at": created_at,
        "notes": data.get("notes"),
        "inventory": [],
    }
    for item in data.get("inventory", []):
        entry["inventory"].append(
            {
                "name": item.get("name"),
                "ideal": item.get("ideal") if isinstance(item.get("ideal"), int) else None,
                "current": item.get("current") if isinstance(item.get("current"), int) else None,
            }
        )
    with REPORTS_LOCK:
        store = _read_json_file(REPORTS_FILE, {"reports": []})
        reports = store.get("reports", [])
        next_id = (reports[-1]["id"] + 1) if reports else 1
        entry["id"] = next_id
        reports.append(entry)
        _write_json_file(REPORTS_FILE, {"reports": reports})
    return entry["id"]


def get_latest_report():
    store = _read_json_file(REPORTS_FILE, {"reports": []})
    reports = store.get("reports", [])
    if not reports:
        return None
    return reports[-1]


# initialize storage on import
init_storage()


def _extract_base64_from_file(file_storage) -> str:
    data = file_storage.read()
    return base64.b64encode(data).decode("utf-8")


def _load_app_state() -> dict:
    data = _read_json_file(
        STATE_FILE,
        {
            "inventory": [],
            "report": {},
            "photo": None,
            "updated_at": None,
        },
    )
    return {
        "inventory": data.get("inventory", []),
        "report": data.get("report", {}),
        "photo": data.get("photo"),
        "updated_at": data.get("updated_at"),
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
    sanitized["updated_at"] = timestamp
    with STATE_LOCK:
        _write_json_file(STATE_FILE, sanitized)
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

    # persist the model output to JSON storage (best-effort)
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
