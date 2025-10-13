import requests
from typing import TypedDict, List, Dict
from langgraph.graph import StateGraph
from math import radians, sin, cos, sqrt, atan2

API_KEY_WEATHER = "9e324f204eade8134c0bf3f61bd0969b"
API_KEY_GEOAPIFY = "e78c1cff5f6c42d5868f281bacd8fb45"


class State(TypedDict):
    city: str
    days: int
    weather_forecast: List[Dict]
    pois: List[Dict]
    itinerary: List[Dict]
    final_output: str

def fetch_weather(state: State) -> Dict:
    city = state['city']
    days = state['days']
    url = f"http://api.openweathermap.org/data/2.5/forecast?q={city}&appid={API_KEY_WEATHER}&units=metric"
    resp = requests.get(url)
    data = resp.json()
    forecasts = []
    if resp.status_code == 200:
        for item in data['list']:
            if "12:00:00" in item['dt_txt']:
                forecasts.append({
                    'date': item['dt_txt'].split(' ')[0],
                    'desc': item['weather'][0]['description'].capitalize(),
                    'temp': item['main']['temp']
                })
                if len(forecasts) >= days:
                    break
    return {'weather_forecast': forecasts}

def fetch_pois(state: State) -> Dict:
    city = state['city']
    categories = ["tourism.attraction", "catering.restaurant", "tourism.museum", "leisure.park"]
    geo_url = f"https://api.geoapify.com/v1/geocode/search?text={city}&apiKey={API_KEY_GEOAPIFY}"
    geo_resp = requests.get(geo_url).json()
    if not geo_resp.get('features'):
        return {'pois': []}
    coords = geo_resp['features'][0]['geometry']['coordinates']
    lon, lat = coords[0], coords[1]
    results = []
    for category in categories:
        places_url = (
            f"https://api.geoapify.com/v2/places?"
            f"categories={category}&filter=circle:{lon},{lat},5000&limit=10&apiKey={API_KEY_GEOAPIFY}"
        )
        places_resp = requests.get(places_url).json()
        for feature in places_resp.get('features', []):
            props = feature.get('properties', {})
            # Get lat/lon from geometry
            geometry = feature.get('geometry', {})
            point_coords = geometry.get('coordinates', [None, None])
            results.append({
                'name': props.get('name', 'Unnamed'),
                'type': category,
                'address': props.get('address_line1', '') + ", " + props.get('city', ''),
                'lat': point_coords[1],
                'lon': point_coords[0]
            })
    return {'pois': results}

def haversine_distance(coord1, coord2):
    lat1, lon1 = coord1
    lat2, lon2 = coord2
    R = 6371  # Earth radius kilometers
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)

    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    c = 2 * atan2(sqrt(a), sqrt(1 - a))

    return R * c

def order_pois_by_distance(pois, start_coord):
    ordered = []
    remaining = pois.copy()
    current = start_coord
    while remaining:
        nearest = min(remaining, key=lambda p: haversine_distance(current, (p['lat'], p['lon'])))
        ordered.append(nearest)
        current = (nearest['lat'], nearest['lon'])
        remaining.remove(nearest)
    return ordered

def build_itinerary(state: State) -> Dict:
    weather_forecast = state.get('weather_forecast', [])
    pois = state.get('pois', [])
    days = state['days']

    # Separate POIs by category for each day allocation
    attractions = [p for p in pois if 'attraction' in p['type']]
    restaurants = [p for p in pois if 'restaurant' in p['type']]
    parks = [p for p in pois if 'park' in p['type']]

    itinerary = []
    # Use city center as starting point (from first POI lat/lon or fallback)
    start_coord = (pois[0]['lat'], pois[0]['lon']) if pois else (0, 0)

    for day in range(days):
        # Simple split of POIs per day
        a_slice = attractions[day::days]
        r_slice = restaurants[day::days]
        p_slice = parks[day::days]

        # Order POIs by distance from city center for each category
        a_ordered = order_pois_by_distance(a_slice, start_coord)
        r_ordered = order_pois_by_distance(r_slice, start_coord)
        p_ordered = order_pois_by_distance(p_slice, start_coord)

        itinerary.append({
            'day': day + 1,
            'weather': weather_forecast[day] if day < len(weather_forecast) else {},
            'attractions': a_ordered,
            'restaurants': r_ordered,
            'parks': p_ordered
        })
    return {'itinerary': itinerary}

def format_itinerary(state: State) -> Dict:
    itinerary = state.get('itinerary', [])
    city = state['city']
    days = state['days']
    output = f"## Detailed Travel Itinerary for {city} - {days} day(s) with meal and travel plan\n\n"

    for day_info in itinerary:
        day = day_info['day']
        weather = day_info['weather']
        attractions = day_info['attractions']
        restaurants = day_info['restaurants']
        parks = day_info['parks']

        output += f"### Day {day}\n"
        output += f"Weather: {weather.get('desc', 'N/A')}, Temp: {weather.get('temp', 'N/A')}°C\n\n"

        # Meal Plan, assign first restaurant as Breakfast, second Lunch, third Dinner
        bfast = restaurants[0] if len(restaurants) > 0 else None
        lunch = restaurants[1] if len(restaurants) > 1 else None
        dinner = restaurants[2] if len(restaurants) > 2 else None

        # Output meal info
        output += "| Time | Place | Type | Address |\n"
        output += "|------|-------|------|---------|\n"
        if bfast:
            output += f"| Breakfast | {bfast['name']} | Restaurant | {bfast['address']} |\n"
        # Morning attractions near breakfast
        for attr in attractions[:max(1, len(attractions)//3)]:
            output += f"| Morning Visit | {attr['name']} | Attraction | {attr['address']} |\n"
        if lunch:
            output += f"| Lunch | {lunch['name']} | Restaurant | {lunch['address']} |\n"
        # Afternoon attractions around lunch
        for attr in attractions[max(1, len(attractions)//3):2*max(1, len(attractions)//3)]:
            output += f"| Afternoon Visit | {attr['name']} | Attraction | {attr['address']} |\n"
        if dinner:
            output += f"| Dinner | {dinner['name']} | Restaurant | {dinner['address']} |\n"
        # Evening parks
        for park in parks:
            output += f"| Evening Visit | {park['name']} | Park | {park['address']} |\n"

        output += "\n---\n\n"
    return {'final_output': output}

builder = StateGraph(State)
builder.add_sequence([
    ('fetch_weather', fetch_weather),
    ('fetch_pois', fetch_pois),
    ('build_itinerary', build_itinerary),
    ('format_itinerary', format_itinerary)
])
builder.set_entry_point('fetch_weather')
builder.set_finish_point('format_itinerary')
builder.compile()
builder.validate()

def run_state_graph(graph: StateGraph, initial_state: State, node_order: List[str]) -> State:
    state = initial_state
    for node_name in node_order:
        node_spec = graph.nodes[node_name]
        runnable = getattr(node_spec, "runnable", None)
        if not runnable:
            raise Exception(f"Runnable not found on node '{node_name}'")
        update = runnable.invoke(state)
        if update is not None:
            state.update(update)
    return state

def parse_input_simple(user_input: str) -> (str, int):
    tokens = user_input.lower().split()
    days = None
    digits_in_tokens = [t for t in tokens if t.isdigit()]
    if digits_in_tokens:
        days = int(digits_in_tokens[0])
        filtered_tokens = [t for t in tokens if not t.isdigit() and t not in ['in', 'days', 'day', 'for']]
        city = " ".join(filtered_tokens).strip()
    else:
        raise ValueError("Number of days not found in input.")
    return city.title(), days

def get_travel_plan(city: str, days: int) -> str:
    init_state = {
        'city': city,
        'days': days,
        'weather_forecast': [],
        'pois': [],
        'itinerary': [],
        'final_output': ""
    }
    node_order = ['fetch_weather', 'fetch_pois', 'build_itinerary', 'format_itinerary']
    result_state = run_state_graph(builder, init_state, node_order)
    return result_state['final_output']

if __name__ == "__main__":
    user_input = input("Enter your travel query (e.g., 'Planning to visit Hyderabad in 3 days'): ")
    try:
        city, days = parse_input_simple(user_input)
        plan = get_travel_plan(city, days)
        print(plan)
    except Exception as e:
        print(f"Error processing input: {e}")
