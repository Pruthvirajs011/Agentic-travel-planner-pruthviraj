import os
import requests
from datetime import datetime, timedelta
from pathlib import Path
from dotenv import load_dotenv

# Load env
load_dotenv(dotenv_path=Path(__file__).parent / ".env", override=True)

OWM_KEY = os.getenv("OPENWEATHER_API_KEY", "").strip()

def _geocode_city(city: str):
    """Return (lat, lon) for city using OpenWeather geocoding API."""
    if not OWM_KEY:
        raise RuntimeError("OPENWEATHER_API_KEY is missing")

    url = "http://api.openweathermap.org/geo/1.0/direct"
    params = {"q": city, "limit": 1, "appid": OWM_KEY}
    r = requests.get(url, params=params, timeout=20)
    r.raise_for_status()
    arr = r.json()
    if not arr:
        raise ValueError(f"Could not geocode city: {city}")
    return arr[0]["lat"], arr[0]["lon"]

def _fetch_daily_forecast(lat: float, lon: float):
    """Call OneCall 3.0 daily forecast"""
    if not OWM_KEY:
        raise RuntimeError("OPENWEATHER_API_KEY is missing")

    url = "https://api.openweathermap.org/data/3.0/onecall"
    params = {
        "lat": lat,
        "lon": lon,
        "exclude": "minutely,hourly,alerts",
        "units": "metric",
        "appid": OWM_KEY,
    }
    r = requests.get(url, params=params, timeout=20)
    r.raise_for_status()
    return r.json()

def get_weather(city: str, start_date: str, days: int):
    """Return list of daily weather dicts for the given city & days."""
    # Geocode
    lat, lon = _geocode_city(city)
    # Try normal daily forecast
    try:
        data = _fetch_daily_forecast(lat, lon)
        daily = data.get("daily", [])
        by_date = {}
        for d in daily:
            dt = datetime.utcfromtimestamp(d.get("dt", 0)).date()
            by_date[dt.strftime("%Y-%m-%d")] = d

        start = datetime.strptime(start_date, "%Y-%m-%d").date()
        result = []
        for i in range(int(days)):
            d = start + timedelta(days=i)
            key = d.strftime("%Y-%m-%d")
            item = by_date.get(key)
            if item:
                wx = item.get("weather", [{}])[0]
                result.append({
                    "date": key,
                    "summary": wx.get("description", "n/a").title(),
                    "temp_min": round(item.get("temp", {}).get("min", 0)),
                    "temp_max": round(item.get("temp", {}).get("max", 0)),
                    "icon": wx.get("icon", ""),
                })
            else:
                result.append({
                    "date": key,
                    "summary": "No forecast available",
                    "temp_min": None,
                    "temp_max": None,
                    "icon": "",
                })
        return result
    except Exception as e:
        # Fallback to 5-day / 3-hour forecast
        url = "https://api.openweathermap.org/data/2.5/forecast"
        params = {"lat": lat, "lon": lon, "appid": OWM_KEY, "units": "metric"}
        r = requests.get(url, params=params, timeout=20)
        r.raise_for_status()
        js = r.json()

        from collections import defaultdict
        buckets = defaultdict(list)
        for item in js.get("list", []):
            ts = item.get("dt", 0)
            dt = datetime.utcfromtimestamp(ts)
            day_key = dt.date().strftime("%Y-%m-%d")
            buckets[day_key].append(item)

        start = datetime.strptime(start_date, "%Y-%m-%d").date()
        result = []
        for i in range(int(days)):
            d = start + timedelta(days=i)
            key = d.strftime("%Y-%m-%d")
            chunk = buckets.get(key, [])
            if chunk:
                temps = [c.get("main", {}).get("temp") for c in chunk if c.get("main")]
                tmin = round(min(temps)) if temps else None
                tmax = round(max(temps)) if temps else None
                descs = [ (c.get("weather") or [{}])[0].get("description", "") for c in chunk ]
                summary = max(set(descs), key=descs.count).title() if descs else ""
                icon = (chunk[len(chunk)//2].get("weather") or [{}])[0].get("icon", "")
                result.append({
                    "date": key,
                    "summary": summary,
                    "temp_min": tmin,
                    "temp_max": tmax,
                    "icon": icon,
                })
            else:
                result.append({
                    "date": key,
                    "summary": "No forecast available",
                    "temp_min": None,
                    "temp_max": None,
                    "icon": "",
                })
        return result