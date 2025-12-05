// frontend/app.js

// ======= CONFIG =======// You can override with ?backend=http://127.0.0.1:5001&prefix=
const qs = new URLSearchParams(location.search);
const BACKEND_BASE_URL = qs.get("backend") || "http://127.0.0.1:5001"; // default to 5001 (the one that worked)
const BACKEND_PREFIX   = qs.get("prefix")  || "";
let nlQuery = document.getElementById("nlQuery");
const cityInput = document.getElementById("city");
const daysInput = document.getElementById("days");
const startDateInput = document.getElementById("startDate");
const interestsInput = document.getElementById("interests");
const planBtn = document.getElementById("planBtn");
const useFormBtn = document.getElementById("useFormBtn");
const statusEl = document.getElementById("status");
const results = document.getElementById("results");
const replanBtn = document.getElementById("replanBtn");

const weatherBlock = document.getElementById("weatherBlock");
const poiBlock = document.getElementById("poiBlock");
const itinBlock = document.getElementById("itineraryBlock");

let lastPayload = null;
let leafletLoaded = false;
let map, mapLayer;
let exportBtn, replanDistanceBtn;
let lastItinerary = null;

// POI selection + map state
let lastAllPois = [];
let selectedPoiNames = new Set();
let mapShowMode = 'all'; // 'all' | 'selected'
// Map raw -> ascii name for POIs (used to fix schedule names)
let rawNameMap = new Map();

// ===== helpers =====
// Surface unexpected errors to the UI
window.addEventListener('error', (ev) => {
  console.error('Global error:', ev.error || ev.message);
  setStatus(`Error: ${ev.error?.message || ev.message}`, 'error');
});
window.addEventListener('unhandledrejection', (ev) => {
  console.error('Unhandled promise:', ev.reason);
  const msg = ev?.reason?.message || String(ev.reason || 'Unknown error');
  setStatus(`Error: ${msg}`, 'error');
});
// ---- Polyfills / Safe defaults ----
if (typeof window.toInterests !== 'function') {
  window.toInterests = function(str){
    return String(str || '')
      .split(/[,\n;]+/)
      .map(s => s.trim())
      .filter(Boolean);
  };
}
function setStatus(msg, kind = "") {
  statusEl.textContent = msg || "";
  statusEl.className = `status ${kind}`;
}
function show(el, on=true) { el.classList.toggle("hidden", !on); }

// ---- Utility: load external script/css ----
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
function loadCSS(href){
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l);
}

// ---- Leaflet lazy loader ----
async function ensureLeaflet(){
  if (window.L) return true;
  if (!leafletLoaded){
    loadCSS('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
    await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
    leafletLoaded = true;
  }
  return true;
}

function haversine(a, b){
  const R = 6371e3; // meters
  const toRad = d => d*Math.PI/180;
  const dLat = toRad(b.lat-a.lat);
  const dLon = toRad(b.lon-a.lon);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat/2), sinDLon = Math.sin(dLon/2);
  const h = sinDLat*sinDLat + Math.cos(lat1)*Math.cos(lat2)*sinDLon*sinDLon;
  return 2*R*Math.asin(Math.sqrt(h));
}

function orderByNearest(points){
  if (!points.length) return points;
  const remaining = points.slice();
  const out = [remaining.shift()];
  while (remaining.length){
    const last = out[out.length-1];
    let bestIdx = 0, bestDist = Infinity;
    for (let i=0;i<remaining.length;i++){
      const d = haversine(last, remaining[i]);
      if (d < bestDist){bestDist = d; bestIdx = i;}
    }
    out.push(remaining.splice(bestIdx,1)[0]);
  }
  return out;
}


// ---- Text sanitization: keep Latin/ASCII only (strip non-English scripts) ----
function sanitizeLatin(s){
  if (s == null) return s;
  const cleaned = String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')            // strip diacritics
    .replace(/[^\x00-\x7F]/g, '')               // strip non-ASCII
    .replace(/[^A-Za-z0-9\s.,'’()\-\"]/g, '') // keep latin + punctuation
    .replace(/\s{2,}/g, ' ')                     // collapse spaces
    .trim();
  return cleaned || 'Unnamed';
}

// Example pills → NL box
(function bindExamplePills(){
  const pills = document.querySelectorAll('.pill[data-ex]');
  pills.forEach(btn => btn.addEventListener('click', () => {
    nlQuery.value = btn.dataset.ex || '';
    setStatus('');
    nlQuery.focus();
  }));
})();

// ===== Natural language parsing =====
function parseNL(q) {
  const out = {};
  if (!q) return out;

  // days: "2 day", "3-day"
  const dayMatch = q.match(/(\d+)\s*[- ]?\s*day/i);
  if (dayMatch) out.days = parseInt(dayMatch[1], 10);

  // Detect and strip 'starting from', 'starting', 'from', 'on' prefixes
  let date = null;
  let dateStr = null;
  let dateMatch = null;
  const prefixMatch = q.match(/\b(starting from|starting|from|on)\b\s*[:,\-]?\s*(.+)/i);
  dateStr = prefixMatch ? (prefixMatch[2] || q) : q;

  // 1. ISO yyyy-mm-dd
  dateMatch = dateStr.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (dateMatch) date = dateMatch[1];

  // 2. dd-mm-yyyy or dd/mm/yyyy
  if (!date) {
    dateMatch = dateStr.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
    if (dateMatch) {
      date = dateMatch[3] + '-' + dateMatch[2].padStart(2,'0') + '-' + dateMatch[1].padStart(2,'0');
    }
  }

  // 2.5. 12th Oct 2025 or 12th Oct (assume current year; if past, roll to next year)
  if (!date) {
    const m = dateStr.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})(?:,?\s*(\d{4}))?\b/i);
    if (m) {
      let year = m[3] ? parseInt(m[3], 10) : (new Date()).getFullYear();
      let d = new Date(`${m[2]} ${m[1]}, ${year}`);
      if (!isNaN(d)) {
        if (!m[3]) {
          const today = new Date();
          const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
          if (d < t0) d.setFullYear(year + 1);
        }
        date = d.toISOString().slice(0,10);
      }
    }
  }

  // 3. 12 Oct 2025
  if (!date) {
    dateMatch = dateStr.match(/\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/i);
    if (dateMatch) {
      const d = new Date(`${dateMatch[2]} ${dateMatch[1]}, ${dateMatch[3]}`);
      if (!isNaN(d)) date = d.toISOString().slice(0,10);
    }
  }

  // 4. Oct 12, 2025
  if (!date) {
    dateMatch = dateStr.match(/\b([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\b/i);
    if (dateMatch) {
      const d = new Date(`${dateMatch[1]} ${dateMatch[2]}, ${dateMatch[3]}`);
      if (!isNaN(d)) date = d.toISOString().slice(0,10);
    }
  }

  // 3.5. 12 Oct (no year) → assume current year; if past, roll to next year
  if (!date) {
    const m = dateStr.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\b/i);
    if (m) {
      const now = new Date();
      let d = new Date(`${m[2]} ${m[1]}, ${now.getFullYear()}`);
      if (!isNaN(d)) {
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (d < today) d.setFullYear(d.getFullYear() + 1);
        date = d.toISOString().slice(0,10);
      }
    }
  }

  // Weekday phrases: "next Friday" / "this Tuesday"
  if (!date) {
    const weekdayMap = {sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6};
    const m = q.match(/\b(next|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
    if (m) {
      const now = new Date();
      const target = weekdayMap[m[2].toLowerCase()];
      const cur = now.getDay();
      let diff = target - cur;
      if (m[1].toLowerCase() === 'next' || diff <= 0) diff += 7;
      const d = new Date(now);
      d.setDate(now.getDate() + diff);
      date = d.toISOString().slice(0,10);
    }
  }

  // "this weekend" → upcoming Saturday
  if (!date && /\bthis weekend\b/i.test(q)) {
    const now = new Date();
    const cur = now.getDay();
    const diff = (6 - cur + 7) % 7 || 7;
    const d = new Date(now);
    d.setDate(now.getDate() + diff);
    date = d.toISOString().slice(0,10);
  }

  // Relative options
  const relDatePatterns = [
    {regex: /\b(?:starting|from|on)?\s*day after tomorrow\b/i, offset: 2},
    {regex: /\b(?:starting|from|on)?\s*tomorrow\b/i, offset: 1},
    {regex: /\b(?:starting|from|on)?\s*today\b/i, offset: 0},
    {regex: /\b(?:starting|from|on)?\s*next week\b/i, offset: 7},
  ];
  if (!date) {
    for (const pattern of relDatePatterns) {
      if (pattern.regex.test(q)) {
        const d = new Date();
        d.setDate(d.getDate() + pattern.offset);
        date = d.toISOString().slice(0,10);
        break;
      }
    }
  }
  if (date) out.start_date = date;

  // city: try "to <City>" or "in <City>"
  let city = null;
  const toIn = q.match(/\b(?:to|in)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/);
  if (toIn) city = toIn[1];
  if (!city) {
    const caps = q.match(/([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/g);
    if (caps && caps.length) city = caps[caps.length-1];
  }
  if (city) out.city = city.trim();

  console.debug("parseNL:", out);
  return out;
}

// ===== Live NL → form sync (non-destructive) =====
function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const liveSyncFromNL = debounce(() => {
  if (!nlQuery) nlQuery = document.getElementById('nlQuery');
  if (!nlQuery) return;
  const text = (nlQuery.value || "").trim();
  if (!text) return;

  const parsed = parseNL(text);

  // Only set fields we actually detect; do NOT clear user-entered values.
  if (parsed.start_date) {
    const sdi = startDateInput || document.getElementById('startDate') || document.querySelector('input[type="date"]');
    if (sdi && sdi.value !== parsed.start_date) {
      sdi.value = parsed.start_date;
      sdi.dispatchEvent(new Event('input', { bubbles: true }));
      sdi.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('Updated Start Date from sentence:', parsed.start_date);
    }
  }
  if (parsed.days && daysInput && String(daysInput.value) !== String(parsed.days)) {
    daysInput.value = parsed.days;
    daysInput.dispatchEvent(new Event('input', { bubbles: true }));
    daysInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (parsed.city && cityInput && cityInput.value.trim() !== parsed.city) {
    cityInput.value = parsed.city;
    cityInput.dispatchEvent(new Event('input', { bubbles: true }));
    cityInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
}, 200);

if (nlQuery) {
  nlQuery.addEventListener('input', liveSyncFromNL);
  nlQuery.addEventListener('change', liveSyncFromNL);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (!nlQuery) nlQuery = document.getElementById('nlQuery');
    if (nlQuery) {
      nlQuery.addEventListener('input', liveSyncFromNL);
      nlQuery.addEventListener('change', liveSyncFromNL);
    }
  });
}
// ===== End Live NL → form sync =====

// ===== HTTP =====
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(body)
  });
  const ct = res.headers.get("content-type") || "";
  let payload = null;
  try {
    if (ct.includes("application/json")) payload = await res.json();
    else payload = { raw: await res.text() };
  } catch {
    payload = { raw: await res.text() };
  }
  return { status: res.status, data: payload };
}

// ===== Renderers =====
function renderWeather(weather) {
  if (!Array.isArray(weather) || weather.length === 0) {
    return `<h3>Weather</h3><div class="badge">No forecast available</div>`;
  }
  const rows = weather.map(w => `
    <tr>
      <td>${w.date || "-"}</td>
      <td>${w.summary || w.description || "-"}</td>
      <td>${w.temp_min ?? "-"}°C / ${w.temp_max ?? "-"}°C</td>
    </tr>
  `).join("");
  return `
    <h3>Weather</h3>
    <table class="table">
      <thead><tr><th>Date</th><th>Condition</th><th>Min / Max</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ----- Map (top-level) -----
async function renderMap(pois){
  try{ await ensureLeaflet(); }catch(e){ console.warn('Leaflet load failed', e); return; }
  // Create/ensure map container inside poiBlock
  let mapEl = document.getElementById('map');
  if (!mapEl){
    mapEl = document.createElement('div');
    mapEl.id = 'map';
    mapEl.style.height = '320px';
    mapEl.style.borderRadius = '8px';
    mapEl.style.marginTop = '12px';
    poiBlock.appendChild(mapEl);
  }
  if (!map){
    map = L.map('map');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
  }
  if (mapLayer){ map.removeLayer(mapLayer); }
  const markers = [];
  (pois||[]).forEach(p => {
    if (typeof p.lat === 'number' && typeof p.lon === 'number'){
      const m = L.marker([p.lat, p.lon]).bindPopup(`<b>${p.name||'Place'}</b><br>${p.category||''}`);
      markers.push(m);
    }
  });
  mapLayer = L.layerGroup(markers).addTo(map);
  if (markers.length){
    const group = L.featureGroup(markers);
    map.fitBounds(group.getBounds().pad(0.1));
  } else {
    map.setView([20.5937, 78.9629], 5); // India fallback
  }
}

// Group POIs by rough categories
function groupPoisByCategory(pois) {
  const groups = {
    attractions: [],
    restaurants: [],
    worship: [],
    shopping: [],
    others: []
  };
  (pois || []).forEach(p => {
    const c = (p.category || '').toLowerCase();
    if (c.includes('tourism') || c.includes('attraction') || c.includes('museum') || c.includes('heritage') || c.includes('park')) {
      groups.attractions.push(p);
    } else if (c.includes('catering') || c.includes('restaurant') || c.includes('cafe')) {
      groups.restaurants.push(p);
    } else if (c.includes('religion') || c.includes('mosque') || c.includes('temple') || c.includes('church')) {
      groups.worship.push(p);
    } else if (c.includes('shopping') || c.includes('market') || c.includes('mall')) {
      groups.shopping.push(p);
    } else {
      groups.others.push(p);
    }
  });
  return groups;
}

function renderPOISelector(pois) {
  // Preprocess: clean names/categories to remove non-English (Latin alphabet) characters
  pois = (pois || []).map(p => {
    // also remember the raw name so we can show it in title/tooltip later
    p.__raw = p.name;
    // Build a stable ASCII fallback too
    if (!p.name || p.name.trim().length === 0) p.name = 'Unnamed';
    const ascii = p.name.replace(/[^A-Za-z0-9\s.,'’()\-\"]/g, '').trim();
    if (!ascii) {
      p.name_ascii = (p.category ? (p.category.split(/[.,]/)[0] + ' place') : 'Place');
    } else {
      p.name_ascii = ascii;
    }
    if (p.category) p.category = p.category.replace(/[^A-Za-z0-9\s.,'’()\-\"]/g, '').trim();
    return p;
  });
  const g = groupPoisByCategory(pois);
  const section = (title, arr, key) => {
    if (!arr.length) return '';
    const items = arr.map(p => `
      <label class="chk">
        <input type="checkbox" data-poi-name="${encodeURIComponent(p.name)}" />
        <span title="${(p.__raw||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\\"/g,'&quot;')}">${p.name_ascii || p.name}</span>
      </label>
    `).join("");
    return `
      <div class="poi-group">
        <div class="poi-group-header">
          <h4>${title} <small>(${arr.length})</small></h4>
          <div class="poi-actions">
            <button class="btn tiny" data-act="select-all" data-key="${key}">Select all</button>
            <button class="btn tiny" data-act="clear-all" data-key="${key}">Clear</button>
          </div>
        </div>
        <div class="poi-grid" data-group="${key}">
          ${items}
        </div>
      </div>
    `;
  };

  return `
    <h3>Points of Interest</h3>
    <div class="poi-selector">
      ${section('Tourist attractions', g.attractions, 'attractions')}
      ${section('Restaurants & Cafes', g.restaurants, 'restaurants')}
      ${section('Temples / Churches / Mosques', g.worship, 'worship')}
      ${section('Shopping & Markets', g.shopping, 'shopping')}
      ${section('Others', g.others, 'others')}
      <div class="poi-controls" style="margin-top:10px;">
        <button id="buildPlanBtn" class="btn small">Build My Plan</button>
        <span class="hint">Select the places you want, then click “Build My Plan”.</span>
      </div>
      <div id="mapToggle" style="margin-top:8px;"></div>
    </div>
  `;
}

function bindPOISelectorEvents() {
  // Select all / Clear buttons
  poiBlock.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-key');
      const grid = poiBlock.querySelector(`.poi-grid[data-group="${key}"]`);
      if (!grid) return;
      const checks = Array.from(grid.querySelectorAll('input[type="checkbox"][data-poi-name]'));
      if (btn.dataset.act === 'select-all') {
        checks.forEach(c => c.checked = true);
      } else {
        checks.forEach(c => c.checked = false);
      }
      // Update selection set
      selectedPoiNames = new Set(getSelectedPoiNamesFromUI());
      // Update map if toggled to selected
      if (mapShowMode === 'selected') updateMapAccordingToToggle();
    });
  });

  // Build My Plan
  const buildBtn = document.getElementById('buildPlanBtn');
  if (buildBtn) {
    buildBtn.addEventListener('click', () => {
      selectedPoiNames = new Set(getSelectedPoiNamesFromUI());
      const selectedPois = getSelectedPois(lastAllPois, selectedPoiNames);
      if (!selectedPois.length) {
        setStatus('Select at least a couple of POIs to build your plan.', 'warn');
        return;
      }
      const custom = clientBuildPlanFromSelection(selectedPois);
      // Only update itinerary + map (keep selector as-is)
      itinBlock.innerHTML = renderItinerary(custom);
      lastItinerary = custom;
      // Switch map to selected view
      mapShowMode = 'selected';
      ensureMapControls();
      updateMapAccordingToToggle();
      setStatus('Built your custom plan!');
    });
  }
}

function getSelectedPoiNamesFromUI() {
  const checks = poiBlock.querySelectorAll('input[type="checkbox"][data-poi-name]:checked');
  return Array.from(checks).map(c => decodeURIComponent(c.getAttribute('data-poi-name')));
}

function getSelectedPois(allPois, nameSet) {
  const set = new Set(nameSet || []);
  return (allPois || []).filter(p => set.has(p.name));
}

function ensureMapControls() {
  let cont = document.getElementById('mapToggle');
  if (!cont) {
    cont = document.createElement('div');
    cont.id = 'mapToggle';
    poiBlock.appendChild(cont);
  }
  cont.innerHTML = `
    <div class="toggle">
      <label><input type="radio" name="mapShow" value="all" ${mapShowMode==='all'?'checked':''}/> Show: All POIs</label>
      <label style="margin-left:12px;"><input type="radio" name="mapShow" value="selected" ${mapShowMode==='selected'?'checked':''}/> Show: Selected</label>
    </div>
  `;
  cont.querySelectorAll('input[name="mapShow"]').forEach(r => {
    r.addEventListener('change', (e) => {
      mapShowMode = e.target.value;
      updateMapAccordingToToggle();
    });
  });
}

function updateMapAccordingToToggle() {
  if (mapShowMode === 'selected') {
    const sel = getSelectedPois(lastAllPois, selectedPoiNames);
    renderMap(sel);
  } else {
    renderMap(lastAllPois);
  }
}

function renderPOIs(pois) {
  // render selection UI
  return renderPOISelector(pois || []);
}

function renderItinerary(itin) {
  if (!itin || !Array.isArray(itin.days) || itin.days.length === 0) {
    return `<h3>Itinerary</h3><div class="badge">No plan generated</div>`;
  }
  // ensure English-only display for place names in schedule
  const clean = (s) => {
    if (!s) return 'Unnamed';
    const ascii = String(s).replace(/[^A-Za-z0-9\s.,'’()\-\"]/g, '').trim();
    if (ascii) return ascii;
    // fallback: try to map from original raw name (if backend sent local script)
    if (rawNameMap.has(s)) return rawNameMap.get(s);
    return 'Place';
  };
  const blocks = itin.days.map(d => {
    const notes = d.notes ? `<div class="badge">${d.notes}</div>` : "";
    const rows = (d.schedule || []).map(s => `
      <tr>
        <td>${s.time || "-"}</td>
        <td>${s.activity || "-"}</td>
        <td>${clean(s.place) || "-"}</td>
      </tr>
    `).join("");
    return `
      <div class="block">
        <h4>Day ${d.day} — ${d.date || ""}</h4>
        ${notes}
        <table class="table">
          <thead><tr><th>Time</th><th>Activity</th><th>Place</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }).join("");
  return `<h3>Daily Plan</h3>${blocks}`;
}

// Build custom itinerary from selected POIs
function clientBuildPlanFromSelection(selectedPois) {
  // split by type
  const groups = groupPoisByCategory(selectedPois);
  const eats = groups.restaurants.slice();
  const sights = groups.attractions.concat(groups.worship, groups.shopping);
  // nearest-neighbor order on sights to keep flows tighter
  const sightsOrdered = orderByNearest(sights.map(p => ({ ...p })));

  // How many days?
  const days = parseInt(daysInput.value || '0', 10) || (lastItinerary?.days?.length) || 2;

  // Start date?
  let startDate = startDateInput.value || (lastItinerary?.days?.[0]?.date);
  if (!startDate) {
    const d = new Date();
    startDate = d.toISOString().slice(0,10);
  }
  const d0 = new Date(startDate);

  // make helpers to rotate through arrays without repeating too fast
  const takeNext = (arr, idxObj) => {
    if (!arr.length) return null;
    const v = arr[idxObj.i % arr.length];
    idxObj.i++;
    return v;
  };
  const eatIdx = {i:0}, sightIdx = {i:0};

  const makeTime = (hh, mm='00') => `${String(hh).padStart(2,'0')}:${mm}`;

  const outDays = [];
  for (let i=0;i<days;i++){
    const d = new Date(d0);
    d.setDate(d0.getDate() + i);
    const dateStr = d.toISOString().slice(0,10);

    const schedule = [];
    const b = takeNext(eats, eatIdx);
    if (b) schedule.push({ time: makeTime(8,30), activity: 'Breakfast', place: b.name });

    const s1 = takeNext(sightsOrdered, sightIdx);
    if (s1) schedule.push({ time: makeTime(10, '00'), activity: 'Sightseeing', place: s1.name });

    const l = takeNext(eats, eatIdx);
    if (l) schedule.push({ time: makeTime(12,30), activity: 'Lunch', place: l.name });

    const s2 = takeNext(sightsOrdered, sightIdx);
    if (s2) schedule.push({ time: makeTime(15, '00'), activity: 'Sightseeing', place: s2.name });

    const c = takeNext(eats, eatIdx);
    if (c) schedule.push({ time: makeTime(17,30), activity: 'Cafe/Tea', place: c.name });

    const dnr = takeNext(eats, eatIdx);
    if (dnr) schedule.push({ time: makeTime(19,30), activity: 'Dinner', place: dnr.name });

    outDays.push({
      day: i+1,
      date: dateStr,
      notes: '',
      schedule
    });
  }

  return {
    city: cityInput.value || (lastItinerary?.city) || '',
    interests: toInterests(interestsInput.value),
    weather: lastItinerary?.weather || lastItinerary?.weather_info || [],
    all_pois: lastAllPois,
    selected_pois: selectedPois,
    days: outDays
  };
}

/* -------------------------------------------
   FILL BLANK "PLACE" ENTRIES WITH THEMED NAMES
-------------------------------------------- */
function __rand(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

function __fallbackPlaces(city){
  const c = (city || cityInput?.value || 'City').trim();
  return [
    `${c} Central Park`, `${c} City Museum`, `${c} Old Town Market`, `${c} Fort`,
    `${c} Riverfront Walk`, `${c} Food Street`, `${c} Art Gallery`, `${c} Heritage Walk`,
    `${c} Botanical Garden`, `${c} Science Center`, `${c} Palace`, `${c} Temple`,
    `${c} Night Bazaar`, `${c} Viewpoint`, `${c} Lakeside Promenade`, `${c} Street Food Lane`
  ];
}

function fillMissingPlacesInItinerary(itin){
  try{
    const pool = __fallbackPlaces(itin?.city);
    if (!Array.isArray(pool) || pool.length === 0) return itin;
    (itin?.days || []).forEach(day => {
      (day?.schedule || []).forEach(slot => {
        const p = (slot?.place || '').trim();
        const lower = p.toLowerCase();
        // Replace if blank or placeholder-ish
        if (!p || lower === 'place' || lower === 'unnamed' || lower === 'unknown') {
          slot.place = __rand(pool);
        }
      });
    });
  } catch(e){ console.warn('fillMissingPlaces failed:', e); }
  return itin;
}

// ===== high-level results =====
function showResults(json) {
  // Global safeguard: ensure all relevant text fields (POIs, schedule, etc.) are English-only
  const cleanEnglish = s => {
    if (typeof s !== 'string') return s;
    const ascii = s.replace(/[^A-Za-z0-9\s.,'’()\-\"]/g, '').trim();
    if (ascii) return ascii;
    // fallback from map
    return rawNameMap.get(s) || 'Place';
  };
  // Clean POI names/categories in-place
  if (json.all_pois && Array.isArray(json.all_pois)) {
    json.all_pois.forEach(p => {
      p.__raw = p.name;
      const ascii = cleanEnglish(p.name || '');
      p.name_ascii = ascii || (p.category ? (p.category.split(/[.,]/)[0] + ' place') : 'Place');
      if (!p.category) p.category = '';
    });
  }
  if (json.pois && Array.isArray(json.pois)) {
    json.pois.forEach(p => {
      p.__raw = p.name;
      const ascii = cleanEnglish(p.name || '');
      p.name_ascii = ascii || (p.category ? (p.category.split(/[.,]/)[0] + ' place') : 'Place');
      if (!p.category) p.category = '';
    });
  }
  // Clean schedule place names
  if (json?.days) {
    json.days.forEach(day => {
      (day.schedule||[]).forEach(slot => {
        if (slot.place) {
          const cleaned = cleanEnglish(slot.place);
          slot.place = cleaned || 'Place';
        }
      });
    });
  }

  // fill any remaining blanks like "Place"/"Unnamed"
  fillMissingPlacesInItinerary(json);

  // build raw -> ascii map so we can fix schedule entries later
  rawNameMap = new Map();
  (json.all_pois||json.pois||[]).forEach(p=>{
    const raw = (p.__raw ?? p.name) || '';
    const ascii = p.name_ascii || (p.name ? String(p.name).replace(/[^A-Za-z0-9\s.,'’()\-\"]/g,'').trim() : '') || 'Place';
    if (raw) rawNameMap.set(raw, ascii);
  });
  // Save state
  lastItinerary = json;
  const weather = json.weather || json.weather_info || [];
  // Clean POI names/categories to English-only for UI + map
  const rawPois = (json.all_pois || json.pois || []).map(p=>({
    ...p,
    name: p.name_ascii || cleanEnglish(String(p.name||'')) || 'Place',
    category: cleanEnglish(String(p.category||''))
  }));
  // Prepare selection state
  lastAllPois = rawPois.slice();
  selectedPoiNames = new Set();
  mapShowMode = 'all';

  weatherBlock.innerHTML = renderWeather(weather);
  poiBlock.innerHTML = renderPOIs(rawPois);
  bindPOISelectorEvents();
  ensureMapControls();
  updateMapAccordingToToggle();
  itinBlock.innerHTML = renderItinerary(json);
  show(results, true);
}

// ===== Buttons below itinerary header =====
function ensureActionButtons(){
  // Export PDF button
  if (!exportBtn){
    exportBtn = document.createElement('button');
    exportBtn.id = 'exportBtn';
    exportBtn.className = 'btn small';
    exportBtn.textContent = 'Export PDF';
    exportBtn.style.marginLeft = '8px';
    replanBtn?.insertAdjacentElement('afterend', exportBtn);
    exportBtn.addEventListener('click', exportPDF);
  }
  // Replan by distance button
  if (!replanDistanceBtn){
    replanDistanceBtn = document.createElement('button');
    replanDistanceBtn.id = 'replanDistanceBtn';
    replanDistanceBtn.className = 'btn small';
    replanDistanceBtn.textContent = 'Replan by distance';
    replanDistanceBtn.style.marginLeft = '8px';
    replanBtn?.insertAdjacentElement('afterend', replanDistanceBtn);
    replanDistanceBtn.addEventListener('click', () => replanTrip('distance'));
  }
}

async function ensureHtml2Pdf(){
  if (window.html2pdf) return true;
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js');
  return true;
}

async function exportPDF(){
  try{
    await ensureHtml2Pdf();
    const opt = {
      margin:       0.3,
      filename:     `itinerary_${Date.now()}.pdf`,
      image:        { type: 'jpeg', quality: 0.95 },
      html2canvas:  { scale: 2, useCORS: true },
      jsPDF:        { unit: 'in', format: 'a4', orientation: 'portrait' }
    };
    const node = document.querySelector('#results');
    setStatus('Generating PDF…');
    await window.html2pdf().from(node).set(opt).save();
    setStatus('PDF downloaded!');
  }catch(e){
    console.error(e);
    setStatus('Failed to export PDF', 'error');
  }
}

function buildNameToCoord(pois){
  const m = new Map();
  (pois||[]).forEach(p => {
    if (p && p.name && typeof p.lat==='number' && typeof p.lon==='number'){
      m.set(p.name, {lat:p.lat, lon:p.lon, name:p.name});
    }
  });
  return m;
}

function clientReplanByDistance(itin){
  if (!itin || !Array.isArray(itin.days)) return itin;
  const allPois = itin.all_pois || itin.pois || [];
  const name2coord = buildNameToCoord(allPois);
  const cloned = JSON.parse(JSON.stringify(itin));
  cloned.days.forEach(day => {
    if (!Array.isArray(day.schedule)) return;
    // extract sightseeing-like slots
    const sightIdx = [];
    const sightPts = [];
    day.schedule.forEach((slot, idx) => {
      const act = (slot.activity||'').toLowerCase();
      if (act.includes('sight')){
        const pt = name2coord.get(slot.place);
        if (pt) { sightIdx.push(idx); sightPts.push({...pt, slot}); }
      }
    });
    if (sightPts.length < 2) return;
    // order
    const ordered = orderByNearest(sightPts);
    // write back keeping original times
    for (let i=0;i<sightIdx.length;i++){
      const idx = sightIdx[i];
      const src = ordered[i];
      day.schedule[idx].place = src.name;
    }
  });
  return cloned;
}

// ===== actions =====
async function planTrip(payload) {
  lastPayload = payload;
  setStatus("Planning your trip…");
  show(results, false);
  try {
// BEFORE
const { status, data } = await postJSON(`${BACKEND_BASE_URL}/plan_trip`, payload);
// AFTER
const { status, data } = await postJSON(`${BACKEND_BASE_URL}${BACKEND_PREFIX}/plan_trip`, payload);    if (status >= 200 && status < 300) {
      setStatus("Done!");
      ensureActionButtons();
      showResults(data);
    } else {
      setStatus(`Error ${status}: ${data?.error || "Unexpected error"}`, "error");
      if (data?.detail) console.error(data.detail);
    }
  } catch (e) {
    setStatus(`Network error: ${e.message}`, "error");
  }
}

async function replanTrip(mode) {
  if (!lastPayload) {
    setStatus('Make a plan first.', 'warn');
    return;
  }
  const label = mode === 'distance' ? 'Replanning by distance…' : 'Replanning your trip…';
  setStatus(label);
  try {
    const body = { ...lastPayload, shuffle: true, seed: Date.now(), mode: mode||'default' };
    const { status, data } = await postJSON(`${BACKEND_BASE_URL}/replan`, body);
    if (status >= 200 && status < 300) {
      setStatus('Replanned!');
      showResults(data);
    } else {
      // fallback to client distance if requested
      if (mode === 'distance' && lastItinerary){
        const replanned = clientReplanByDistance(lastItinerary);
        setStatus('Replanned (client-side distance)!');
        showResults(replanned);
      } else {
        setStatus(`Error ${status}: ${data?.error || 'Unexpected error'}`, 'error');
        if (data?.detail) console.error(data.detail);
      }
    }
  } catch (e) {
    if (mode === 'distance' && lastItinerary){
      const replanned = clientReplanByDistance(lastItinerary);
      setStatus('Replanned (client-side distance)!');
      showResults(replanned);
    } else {
      setStatus(`Network error: ${e.message}`, 'error');
    }
  }
}
// 🌦️ WEATHER FALLBACK — fetch directly from OpenWeather if backend doesn't include it
// 🌦️ WEATHER FALLBACK — fetch directly from OpenWeather if backend doesn't include it
// 🌦️ WEATHER FALLBACK — fixed version (OpenWeatherMap)
async function fetchWeatherForCity(city) {
  const API_KEY = "9e324f204eade8134c0bf3f61bd0969b";
  try {
    if (!city) return [];
    const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(
      city
    )}&appid=${API_KEY}&units=metric`;

    console.log("🌦️ Fetching weather for:", city);
    const res = await fetch(url);
    if (!res.ok) {
      console.warn("Weather API failed:", res.status);
      return [];
    }
    const data = await res.json();

    // Convert 3-hourly forecast to daily summary
    const dailyMap = new Map();
    data.list.forEach((entry) => {
      const date = entry.dt_txt.split(" ")[0];
      if (!dailyMap.has(date)) {
        dailyMap.set(date, {
          date,
          temp_min: entry.main.temp_min,
          temp_max: entry.main.temp_max,
          summary: entry.weather?.[0]?.description || "—",
        });
      } else {
        const day = dailyMap.get(date);
        day.temp_min = Math.min(day.temp_min, entry.main.temp_min);
        day.temp_max = Math.max(day.temp_max, entry.main.temp_max);
      }
    });

    const result = Array.from(dailyMap.values()).slice(0, 5); // limit to 5 days
    console.log("✅ Weather fetched successfully:", result);
    return result;
  } catch (err) {
    console.error("Weather fetch error:", err);
    return [];
  }
}

// 💡 Patch showResults() — auto-fetch weather if backend didn’t provide it
const __oldShowResults = showResults;
showResults = async function (json) {
  if ((!json.weather || json.weather.length === 0) && json.city) {
    console.log("🌦️ Fetching fallback weather for:", json.city);
    json.weather = await fetchWeatherForCity(json.city);
  }
  __oldShowResults(json);
};
// ===== Bind buttons =====
// ===== Bind buttons (robust, single-attach) =====
function onPlanClick(){
  try{
    const nlEl = document.getElementById('nlQuery');
    const parsed = parseNL((nlEl?.value || '').trim());
    const sdi = document.getElementById('startDate');
    const cityEl = document.getElementById('city');
    const daysEl = document.getElementById('days');
    const interestsEl = document.getElementById('interests');

    if (parsed.start_date && sdi) sdi.value = parsed.start_date;
    if (parsed.days && daysEl) daysEl.value = parsed.days;
    if (parsed.city && cityEl) cityEl.value = parsed.city;

    const payload = {
      city: (parsed.city || cityEl?.value || '').trim(),
      days: parsed.days || parseInt(daysEl?.value || '0', 10) || 2,
      start_date: parsed.start_date || (sdi?.value || undefined),
      interests: (typeof toInterests === 'function')
        ? toInterests(interestsEl?.value || '')
        : String(interestsEl?.value || '').split(/[,\n;]+/).map(s => s.trim()).filter(Boolean)
    };
    if (!payload.city) {
      console.warn('City missing from payload:', payload);
      setStatus('Please specify a city (type it or include in your sentence).', 'warn');
      return;
    }
    planTrip(payload);
  } catch (e) {
    console.error('Plan click failed:', e);
    setStatus(`Could not start planning: ${e?.message || 'see console'}`, 'error');
  }
}

function onUseFormClick(){
  try{
    const sdi = document.getElementById('startDate');
    const cityEl = document.getElementById('city');
    const daysEl = document.getElementById('days');
    const interestsEl = document.getElementById('interests');
    // Defensive guard for toInterests
    const ti = (typeof toInterests === 'function') ? toInterests : (s => String(s || '').split(/[,\n;]+/).map(x=>x.trim()).filter(Boolean));
    const payload = {
      city: (cityEl?.value || '').trim(),
      days: parseInt((daysEl?.value || '0'), 10) || 1,
      start_date: sdi?.value || undefined,
      interests: ti(interestsEl?.value || '')
    };
    if (!payload.city) {
      setStatus('City is required.', 'warn');
      return;
    }
    console.debug('Submitting payload (form):', payload);
    planTrip(payload);
  } catch (e) {
    console.error('Use Form click failed:', e);
    setStatus(`Could not start planning: ${e?.message || 'see console'}`, 'error');
  }
}

function onReplanClick(){
  replanTrip();
}

function bindUIOnce(){
  if (window.__UI_BOUND__) return; // prevent double-binding
  window.__UI_BOUND__ = true;
  const _planBtn = document.getElementById('planBtn');
  const _useFormBtn = document.getElementById('useFormBtn');
  const _replanBtn = document.getElementById('replanBtn');

  if (_planBtn) _planBtn.addEventListener('click', onPlanClick, { once: false });
  else console.warn('#planBtn not found');

  if (_useFormBtn) _useFormBtn.addEventListener('click', onUseFormClick, { once: false });
  else console.warn('#useFormBtn not found');

  if (_replanBtn) _replanBtn.addEventListener('click', onReplanClick, { once: false });
  else console.warn('#replanBtn not found');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindUIOnce);
} else {
  // DOM already parsed
  bindUIOnce();
}