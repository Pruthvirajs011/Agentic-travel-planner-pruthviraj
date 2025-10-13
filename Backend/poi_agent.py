# Backend/poi_agent.py
import os
import requests
import dateparser

GEOAPIFY_GEOCODE_URL = "https://api.geoapify.com/v1/geocode/search"
GEOAPIFY_PLACES_URL  = "https://api.geoapify.com/v2/places"


class PoiError(Exception):
    pass


def _geocode_city(city: str, api_key: str) -> tuple[float, float]:
    """Return (lon, lat) for the city using Geoapify geocoding."""
    r = requests.get(
        GEOAPIFY_GEOCODE_URL,
        params={"text": city, "apiKey": api_key},
        timeout=15,
        headers={"Cache-Control": "no-cache"},
    )
    r.raise_for_status()
    data = r.json()
    feats = data.get("features", [])
    if not feats:
        raise PoiError(f"Could not geocode city: {city}")
    coords = feats[0]["geometry"]["coordinates"]
    lon, lat = float(coords[0]), float(coords[1])
    return lon, lat


def _call_places(lon: float, lat: float, cats: list[str], api_key: str,
                 limit: int = 60, radius: int = 5000) -> list[dict]:
    """
    Do one places call with a list of categories.
    Returns a list of simplified POIs or raises HTTPError on 4xx/5xx.
    """
    if not cats:
        return []

    params = {
        "categories": ",".join(cats),                   # let requests encode
        "filter": f"circle:{lon},{lat},{radius}",
        "bias": f"proximity:{lon},{lat}",
        "limit": limit,
        "lang": "en",
        "apiKey": api_key,
    }
    r = requests.get(GEOAPIFY_PLACES_URL, params=params, timeout=20, headers={"Cache-Control": "no-cache"})
    r.raise_for_status()
    data = r.json()
    out = []
    for f in data.get("features", []):
        p = f.get("properties", {})
        out.append({
            "name": p.get("name") or p.get("address_line1") or "Unknown",
            "category": (p.get("categories") or ["unknown"])[0],
            "lat": p.get("lat"),
            "lon": p.get("lon"),
        })
    return out


def _safe_fetch_groups(lon: float, lat: float, api_key: str,
                       groups: list[list[str]], limit_each: int,
                       radius: int) -> list[dict]:
    """
    Try each group of categories; if it 400s, split and try one by one.
    Returns a combined list of POIs from successful calls.
    """
    collected: list[dict] = []

    for group in groups:
        # First try the group as a single request
        try:
            chunk = _call_places(lon, lat, group, api_key, limit=limit_each, radius=radius)
            collected.extend(chunk)
            continue
        except requests.HTTPError as e:
            # Fall back to single-category calls
            for cat in group:
                try:
                    chunk = _call_places(lon, lat, [cat], api_key, limit=limit_each, radius=radius)
                    collected.extend(chunk)
                except requests.HTTPError:
                    # Skip invalid/offending category silently
                    continue
                except requests.RequestException:
                    continue
        except requests.RequestException:
            # Network error, skip this group
            continue

    # De-duplicate by lowercased name
    dedup = {}
    for p in collected:
        key = (p["name"] or "").strip().lower()
        if key and key not in dedup:
            dedup[key] = p
    return list(dedup.values())


def parse_start_date(natural_language_date: str):
    """
    Parse a natural language date string into a datetime.date object.
    Returns None if parsing fails.
    """
    dt = dateparser.parse(natural_language_date)
    if dt:
        return dt.date()
    return None


def get_pois(city: str, interests: list[str] | None = None,
             limit: int = 60, radius: int = 5000) -> tuple[list[dict], list[dict]]:
    """
    Returns (sights, foods) lists.
    - sights: attractions, museums, sights, heritage, religion, parks
    - foods : restaurants & cafes (only if 'food' was in interests)
    """
    api_key = os.getenv("GEOAPIFY_API_KEY")
    if not api_key:
        raise PoiError("Missing GEOAPIFY_API_KEY")

    lon, lat = _geocode_city(city, api_key)

    interests = interests or []
    want_food     = any("food" in i.lower() or "cafe" in i.lower() for i in interests)
    want_shopping = any("shopping" in i.lower() for i in interests)

    # Keep categories conservative & valid; some exotic categories can trigger 400s
    base_sight_groups = [
        ["tourism.attraction", "tourism.sights"],
        ["entertainment.museum", "heritage", "religion"],
        ["natural.park"],  # avoid natural.springs / natural.peak if they cause 400s
    ]

    # Optional interest-based groups
    food_groups = [["catering.restaurant", "catering.cafe"]] if want_food else []
    shop_groups = [["commercial.shopping_mall", "commercial.marketplace"]] if want_shopping else []

    # Fetch POIs group by group with fallbacks
    sights_raw = _safe_fetch_groups(lon, lat, api_key, base_sight_groups, limit_each=min(30, limit), radius=radius)
    foods_raw  = _safe_fetch_groups(lon, lat, api_key, food_groups,        limit_each=min(30, limit), radius=radius) if food_groups else []

    # If user didn't ask for food but categories still gave us foods, split properly
    if shop_groups:
        shops = _safe_fetch_groups(lon, lat, api_key, shop_groups, limit_each=min(20, limit), radius=radius)
        sights_raw.extend(shops)

    # Final split
    sights, foods = [], foods_raw
    for p in sights_raw:
        cat = (p.get("category") or "").lower()
        if cat.startswith("catering."):
            foods.append(p)
        else:
            sights.append(p)

    return sights[:limit], foods[:max(20, min(limit, 60))]