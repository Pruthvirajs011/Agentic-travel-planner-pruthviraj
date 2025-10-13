# Backend/itinerary_agent.py
from __future__ import annotations
from datetime import date as Date, datetime, timedelta
import random

def _to_date(obj) -> Date:
    if not obj:
        return Date.today()
    if isinstance(obj, Date):
        return obj
    if isinstance(obj, str):
        try:
            return datetime.strptime(obj, "%Y-%m-%d").date()
        except Exception:
            return Date.today()
    return Date.today()

def _split_pois(pois: list[dict]) -> tuple[list[dict], list[dict]]:
    sights, foods = [], []
    for p in pois or []:
        cat = (p.get("category") or "").lower()
        if cat.startswith("catering."):
            foods.append(p)
        else:
            sights.append(p)
    return sights, foods

def _dedup_by_name(items: list[dict]) -> list[dict]:
    seen = set()
    out = []
    for p in items:
        key = (p.get("name") or "").strip().lower()
        if key and key not in seen:
            seen.add(key)
            out.append(p)
    return out

def create_itinerary(
    city: str,
    days: int,
    interests: list[str],
    weather_info: list[dict],
    sights: list[dict] | None = None,
    foods: list[dict] | None = None,
    pois: list[dict] | None = None,
    start_date: str | Date | None = None,
    shuffle: bool = False,
    seed: int | None = None,
) -> dict:
    """
    Builds a professional day-by-day plan:
    08:30 Breakfast → 10:00 Sightseeing → 12:30 Lunch → 15:00 Sightseeing
    → 17:30 Cafe/Tea → 18:30 Short Sight → 19:30 Dinner
    """
    # unify POIs
    if pois and (not sights and not foods):
        sights, foods = _split_pois(pois)
    sights = _dedup_by_name(sights or [])
    foods  = _dedup_by_name(foods or [])

    # optionally shuffle
    rnd = random.Random(seed) if seed is not None else random
    if shuffle:
        rnd.shuffle(sights)
        rnd.shuffle(foods)

    # choose start date
    d0 = None
    if start_date:
        d0 = _to_date(start_date)
    elif weather_info and weather_info[0].get("date"):
        d0 = _to_date(weather_info[0]["date"])
    else:
        d0 = Date.today()

    # simple iterators (no repeats)
    s_idx, f_idx = 0, 0
    def next_sight() -> str:
        nonlocal s_idx
        if s_idx < len(sights):
            name = sights[s_idx].get("name") or "Sight"
            s_idx += 1
            return name
        return "Free time"
    def next_food() -> str:
        nonlocal f_idx
        if f_idx < len(foods):
            name = foods[f_idx].get("name") or "Food"
            f_idx += 1
            return name
        return "Free time"

    days_out = []
    for i in range(max(1, int(days))):
        the_date = (d0 + timedelta(days=i)).isoformat()
        w = weather_info[i] if i < len(weather_info) else {}
        notes = w.get("summary", "")
        if "temp_min" in w and "temp_max" in w:
            notes += f" (Min {w.get('temp_min')}°C / Max {w.get('temp_max')}°C)"

        schedule = [
            {"time": "08:30", "activity": "Breakfast",   "place": next_food()},
            {"time": "10:00", "activity": "Sightseeing", "place": next_sight()},
            {"time": "12:30", "activity": "Lunch",       "place": next_food()},
            {"time": "15:00", "activity": "Sightseeing", "place": next_sight()},
            {"time": "17:30", "activity": "Cafe/Tea",    "place": next_food()},
            {"time": "18:30", "activity": "Short Sight", "place": next_sight()},
            {"time": "19:30", "activity": "Dinner",      "place": next_food()},
        ]

        days_out.append({
            "day": i + 1,
            "date": the_date,
            "notes": notes.strip(),
            "schedule": schedule,
        })

    return {
        "city": city,
        "interests": interests or [],
        "weather": weather_info or [],
        "days": days_out,
        # give frontend a pool of what we used (sights + foods)
        "all_pois": (sights + foods),
    }