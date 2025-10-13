# Backend/app.py
from pathlib import Path
from dotenv import load_dotenv

# Load .env from Backend/
load_dotenv(dotenv_path=Path(__file__).parent / ".env", override=True)

import os
from datetime import date, datetime
from flask import Flask, request, jsonify
from flask_cors import CORS

from weather_agent import get_weather
from poi_agent import get_pois, parse_start_date
from itinerary_agent import create_itinerary

app = Flask(__name__)
CORS(app)

@app.get("/")
def health():
    return {"status": "ok", "service": "travel-planner"}

@app.errorhandler(Exception)
def handle_error(e):
    app.logger.exception(e)
    return jsonify({"error": "Internal error", "detail": str(e)}), 500

@app.get("/debug_full")
def debug_full():
    dbg = {
        "OPENWEATHER_API_KEY": os.getenv("OPENWEATHER_API_KEY"),
        "GEOAPIFY_API_KEY": os.getenv("GEOAPIFY_API_KEY"),
    }

    city = request.args.get("city", "Delhi")
    days = int(request.args.get("days", 2))
    start = date.today().strftime("%Y-%m-%d")

    try:
        weather = get_weather(city, start, days)
        dbg["weather_sample"] = weather
    except Exception as e:
        dbg["weather_error"] = str(e)

    try:
        sights, foods = get_pois(city, interests=["history", "food"], limit=40)
        dbg["poi_sample"] = (sights[:10] + foods[:10])
    except Exception as e:
        dbg["poi_error"] = str(e)

    return jsonify(dbg)

def _normalize_inputs(data: dict):
    city = (data.get("city") or "").strip()
    if not city:
        raise ValueError("Missing 'city'")

    try:
        days = int(data.get("days", 1))
        if days < 1:
            days = 1
        if days > 10:
            days = 10
    except Exception:
        days = 1

    start_date = data.get("start_date")
    if start_date:
        # allow natural phrases or YYYY-MM-DD
        parsed = parse_start_date(start_date) or _safe_strptime(start_date)
        if parsed:
            start_date = parsed.isoformat()
        else:
            start_date = date.today().isoformat()
    else:
        start_date = date.today().isoformat()

    interests = data.get("interests") or []
    return city, days, start_date, interests

def _safe_strptime(s: str):
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except Exception:
        return None

@app.post("/plan_trip")
def plan_trip():
    data = request.get_json(silent=True) or {}
    try:
        city, days, start_date, interests = _normalize_inputs(data)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    # weather (best-effort)
    try:
        weather_info = get_weather(city, start_date, days)
    except Exception as e:
        app.logger.exception(e)
        weather_info = []

    # POIs — sights & foods
    try:
        sights, foods = get_pois(city, interests, limit=80)
    except Exception as e:
        app.logger.exception(e)
        sights, foods = [], []

    # Build itinerary — pass start_date explicitly
    try:
        itinerary = create_itinerary(
            city=city,
            days=days,
            interests=interests,
            weather_info=weather_info,
            sights=sights,
            foods=foods,
            start_date=start_date,
            shuffle=False,
            seed=None
        )
    except Exception as e:
        app.logger.exception(e)
        return jsonify({"error": "Failed to build itinerary", "detail": str(e)}), 500

    return jsonify(itinerary), 200

@app.post("/replan")
def replan():
    data = request.get_json(silent=True) or {}
    try:
        city, days, start_date, interests = _normalize_inputs(data)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    shuffle = bool(data.get("shuffle", True))
    seed = data.get("seed")
    try:
        seed = int(seed)
    except Exception:
        seed = None

    try:
        weather_info = get_weather(city, start_date, days)
    except Exception as e:
        app.logger.exception(e)
        weather_info = []

    try:
        sights, foods = get_pois(city, interests, limit=80)
    except Exception as e:
        app.logger.exception(e)
        sights, foods = [], []

    try:
        itinerary = create_itinerary(
            city=city,
            days=days,
            interests=interests,
            weather_info=weather_info,
            sights=sights,
            foods=foods,
            start_date=start_date,
            shuffle=shuffle,
            seed=seed
        )
    except Exception as e:
        app.logger.exception(e)
        return jsonify({"error": "Failed to build itinerary", "detail": str(e)}), 500

    return jsonify(itinerary), 200

if __name__ == "__main__":
    app.run(debug=True, port=5001)