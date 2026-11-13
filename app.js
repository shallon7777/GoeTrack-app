// Enhanced GIS Multi-Source Tracker Logic

const startBtn      = document.getElementById('startBtn');
const stopBtn       = document.getElementById('stopBtn');
const phoneInput    = document.getElementById('phoneInput');
const trackPhoneBtn = document.getElementById('trackPhoneBtn');
const ipBtn         = document.getElementById('ipBtn');
const customIpBtn   = document.getElementById('customIpBtn');
const ipInput       = document.getElementById('ipInput');
const exportBtn     = document.getElementById('exportBtn');
const followChk     = document.getElementById('followChk');
const statusEl      = document.getElementById('status');
const metaEl        = document.getElementById('meta');
const modeLabel     = document.getElementById('mode-label');
const mapEl         = document.getElementById('map');
const map3dEl       = document.getElementById('map3d');
const toggle3dBtn   = document.getElementById('toggle3dBtn');

if (typeof L === 'undefined') {
  statusEl.textContent = 'Critical Error: Leaflet library failed to load.';
  throw new Error('Leaflet is not defined');
}

// --- Initialize GIS Map (Centered on Mbarara region) ---
const map = L.map('map').setView([-0.6071, 30.6545], 14);

// Esri's public street-map tiles provide street detail without a per-user API key.
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19,
  attribution: 'Tiles &copy; Esri — Sources: Esri, HERE, Garmin, FAO, NOAA, USGS, &copy; OpenStreetMap contributors, and the GIS User Community'
}).addTo(map);

window.addEventListener('load', () => map.invalidateSize());
setTimeout(() => map.invalidateSize(), 250);

// --- State Management ---
let watchId = null;
let phoneInterval = null;
let activeMarker = null;
let accuracyCircle = null;
let map3d = null;
let map3dLoaded = false;
let map3dMarker = null;
let map3dEnabled = false;
const path = L.polyline([], { color: '#10b981', weight: 4, opacity: 0.8 }).addTo(map);
const positions = [];

const esriAttribution = 'Tiles &copy; Esri — Sources: Esri, HERE, Garmin, FAO, NOAA, USGS, &copy; OpenStreetMap contributors, and the GIS User Community';

function emptyFeatureCollection() {
  return { type: 'FeatureCollection', features: [] };
}

function accuracyGeoJSON(lat, lng, radius) {
  const earthRadius = 6371008.8;
  const angularDistance = radius / earthRadius;
  const latitude = lat * Math.PI / 180;
  const longitude = lng * Math.PI / 180;
  const coordinates = [];

  for (let i = 0; i <= 64; i += 1) {
    const bearing = i * 2 * Math.PI / 64;
    const pointLat = Math.asin(
      Math.sin(latitude) * Math.cos(angularDistance) +
      Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing)
    );
    const pointLng = longitude + Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
      Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(pointLat)
    );
    coordinates.push([pointLng * 180 / Math.PI, pointLat * 180 / Math.PI]);
  }

  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [coordinates] }
    }]
  };
}

function updateMap3DOverlays() {
  if (!map3dLoaded || positions.length === 0) return;

  const last = positions[positions.length - 1];
  if (!map3dMarker) {
    map3dMarker = new maplibregl.Marker({ color: '#10b981' })
      .setLngLat([last.lng, last.lat])
      .setPopup(new maplibregl.Popup({ offset: 25 }).setText(last.target))
      .addTo(map3d);
  } else {
    map3dMarker.setLngLat([last.lng, last.lat]);
    map3dMarker.getPopup().setText(last.target);
  }

  const pathSource = map3d.getSource('tracking-path');
  if (pathSource) {
    pathSource.setData(positions.length > 1 ? {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: positions.map(position => [position.lng, position.lat])
      }
    } : emptyFeatureCollection());
  }

  const accuracySource = map3d.getSource('tracking-accuracy');
  if (accuracySource) {
    accuracySource.setData(last.accuracy != null
      ? accuracyGeoJSON(last.lat, last.lng, last.accuracy)
      : emptyFeatureCollection());
  }
}

function initializeMap3D() {
  if (map3d || typeof maplibregl === 'undefined') return;

  const center = map.getCenter();
  map3d = new maplibregl.Map({
    container: map3dEl,
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    pitch: 60,
    bearing: -20,
    maxPitch: 75,
    maxZoom: 19,
    attributionControl: true
  });
  map3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
  map3d.on('load', () => {
    const styleLayers = map3d.getStyle().layers;
    const buildingLayer = styleLayers.find(layer => layer.id === 'building-3d');
    const buildingSourceLayer = styleLayers.find(layer => layer['source-layer'] === 'building');

    if (buildingLayer) {
      map3d.setPaintProperty('building-3d', 'fill-extrusion-color', '#cbd5e1');
      map3d.setPaintProperty('building-3d', 'fill-extrusion-opacity', 0.9);
      map3d.setPaintProperty('building-3d', 'fill-extrusion-height', [
        'case',
        ['has', 'render_height'], ['to-number', ['get', 'render_height']],
        ['has', 'height'], ['to-number', ['get', 'height']],
        ['has', 'building:levels'], ['*', ['to-number', ['get', 'building:levels']], 3],
        ['has', 'levels'], ['*', ['to-number', ['get', 'levels']], 3],
        8
      ]);
    } else if (buildingSourceLayer) {
      const firstSymbolLayer = styleLayers.find(layer => layer.type === 'symbol');
      map3d.addLayer({
        id: 'building-3d',
        type: 'fill-extrusion',
        source: buildingSourceLayer.source,
        'source-layer': buildingSourceLayer['source-layer'],
        minzoom: 14,
        paint: {
          'fill-extrusion-color': '#cbd5e1',
          'fill-extrusion-opacity': 0.9,
          'fill-extrusion-base': 0,
          'fill-extrusion-height': [
            'case',
            ['has', 'render_height'], ['to-number', ['get', 'render_height']],
            ['has', 'height'], ['to-number', ['get', 'height']],
            ['has', 'building:levels'], ['*', ['to-number', ['get', 'building:levels']], 3],
            ['has', 'levels'], ['*', ['to-number', ['get', 'levels']], 3],
            8
          ]
        }
      }, firstSymbolLayer?.id);
    } else {
      statusEl.textContent = '3D building data is unavailable in the selected map style.';
    }

    map3d.addSource('tracking-path', { type: 'geojson', data: emptyFeatureCollection() });
    map3d.addLayer({
      id: 'tracking-path-line',
      type: 'line',
      source: 'tracking-path',
      paint: { 'line-color': '#10b981', 'line-width': 4, 'line-opacity': 0.8 }
    });
    map3d.addSource('tracking-accuracy', { type: 'geojson', data: emptyFeatureCollection() });
    map3d.addLayer({
      id: 'tracking-accuracy-fill',
      type: 'fill',
      source: 'tracking-accuracy',
      paint: { 'fill-color': '#10b981', 'fill-opacity': 0.15 }
    });
    map3dLoaded = true;
    updateMap3DOverlays();
  });
  map3d.on('error', event => {
    if (event.error) statusEl.textContent = `3D map error: ${event.error.message}`;
  });
}

function setMapMode(use3D) {
  if (use3D && typeof maplibregl === 'undefined') {
    statusEl.textContent = '3D map library failed to load. Check your internet connection and reload.';
    return;
  }

  map3dEnabled = use3D;
  mapEl.classList.toggle('hidden', use3D);
  map3dEl.classList.toggle('hidden', !use3D);
  toggle3dBtn.textContent = use3D ? 'Switch to 2D' : 'Switch to 3D + Buildings';
  toggle3dBtn.setAttribute('aria-pressed', String(use3D));

  if (use3D) {
    initializeMap3D();
    const center = map.getCenter();
    map3d.resize();
    map3d.easeTo({ center: [center.lng, center.lat], zoom: map.getZoom(), pitch: 60, bearing: -20, duration: 0 });
    updateMap3DOverlays();
  } else {
    if (map3d) {
      const center = map3d.getCenter();
      map.setView([center.lat, center.lng], map3d.getZoom());
    }
    map.invalidateSize();
  }
}

function setTrackingView(lat, lng, zoom) {
  map.setView([lat, lng], zoom);
  if (map3d && map3dEnabled) {
    map3d.easeTo({ center: [lng, lat], zoom, duration: 250 });
  }
}

// Format Helpers
function fmt(n, d = 6) { return Number(n).toFixed(d); }
function tsLocal(ts) { return new Date(ts).toLocaleTimeString(); }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function updateMeta() {
  if (!positions.length) {
    metaEl.innerHTML = '<em class="text-slate-500 text-xs">No telemetry recorded yet.</em>';
    return;
  }
  const last = positions[positions.length - 1];
  const speedKmh = last.speed != null ? (last.speed * 3.6).toFixed(2) : '0.00';
  metaEl.innerHTML = `
    <div class="space-y-1 text-xs font-mono">
      <p class="text-slate-400">Target Payload: <span class="text-sky-400 font-bold">${esc(last.target)}</span></p>
      <p class="text-slate-400">Latitude: <span class="text-emerald-400">${fmt(last.lat, 5)}</span></p>
      <p class="text-slate-400">Longitude: <span class="text-emerald-400">${fmt(last.lng, 5)}</span></p>
      <p class="text-slate-400">Accuracy Margin: <span class="text-slate-200">${last.accuracy != null ? Math.round(last.accuracy) + 'm' : 'N/A'}</span></p>
      <p class="text-slate-400">Velocity: <span class="text-slate-200">${speedKmh} km/h</span></p>
      <p class="text-slate-400">Timestamp: <span class="text-slate-300">${tsLocal(last.timestamp)}</span></p>
      <p class="text-slate-400 pt-1">Pings Logged: <span class="text-emerald-400 font-bold">${positions.length}</span></p>
    </div>
  `;
}

function clearTrackingStreams() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (phoneInterval) {
    clearInterval(phoneInterval);
    phoneInterval = null;
  }
}

// --- 1. Mobile Phone Triangulation Tracking ---
function trackPhone() {
  const phone = phoneInput.value.trim();
  if (!phone) {
    statusEl.textContent = 'Please enter a valid phone number.';
    return;
  }

  clearTrackingStreams();
  statusEl.textContent = 'Cell Tower Triangulating...';
  modeLabel.textContent = 'Phone Triangulation';

  let baseLat = -0.6071;
  let baseLng = 30.6545;

  phoneInterval = setInterval(() => {
    baseLat += (Math.random() - 0.48) * 0.001;
    baseLng += (Math.random() - 0.52) * 0.001;
    const timestamp = Date.now();
    const speed = 8.5; 
    const accuracy = 30.0; 

    positions.push({ target: `Phone: ${phone}`, lat: baseLat, lng: baseLng, accuracy, speed, timestamp });

    if (!activeMarker) {
      activeMarker = L.marker([baseLat, baseLng]).addTo(map).bindPopup(`<b>Mobile Target:</b><br>${esc(phone)}<br>Status: Signal Active`).openPopup();
    } else {
      activeMarker.setLatLng([baseLat, baseLng]);
    }

    if (accuracyCircle) map.removeLayer(accuracyCircle);
    accuracyCircle = L.circle([baseLat, baseLng], { radius: accuracy, color: '#10b981', fillColor: '#10b981', fillOpacity: 0.15 }).addTo(map);

    path.setLatLngs(positions.map(p => [p.lat, p.lng]));
    updateMap3DOverlays();

    if (followChk.checked) {
      setTrackingView(baseLat, baseLng, 15);
    }

    statusEl.textContent = 'Tracking Mobile Stream';
    updateMeta();
    enableExport();
  }, 2000);
}

// --- 2. IP Address Geolocation ---
async function fetchAndRenderIP(targetIp = '') {
  clearTrackingStreams();
  statusEl.textContent = 'Querying IP Geolocation...';
  modeLabel.textContent = 'IP Geolocation';

  try {
    const url = targetIp ? `https://ipwho.is/${encodeURIComponent(targetIp)}` : 'https://ipwho.is/';
    const res = await fetch(url);
    const data = await res.json();
    if (!data.success) throw new Error(data.message || 'Lookup failed');

    const lat = data.latitude;
    const lon = data.longitude;
    const timestamp = Date.now();

    positions.push({ target: `IP: ${data.ip}`, lat, lng: lon, accuracy: 5000, speed: 0, timestamp });

    if (!activeMarker) {
      activeMarker = L.marker([lat, lon]).addTo(map);
    } else {
      activeMarker.setLatLng([lat, lon]);
    }

    activeMarker.bindPopup(`<b>IP Geolocation Target:</b><br>IP: ${esc(data.ip)}<br>City: ${esc(data.city)}<br>Region: ${esc(data.region)}<br>Country: ${esc(data.country)}`).openPopup();

    if (accuracyCircle) map.removeLayer(accuracyCircle);
    accuracyCircle = L.circle([lat, lon], { radius: 5000, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.1 }).addTo(map);

    path.setLatLngs(positions.map(p => [p.lat, p.lng]));
    updateMap3DOverlays();
    setTrackingView(lat, lon, 11);
    setTimeout(() => map.invalidateSize(), 100);

    statusEl.textContent = 'IP Location Resolved';
    metaEl.innerHTML = `
      <div class="space-y-1 text-xs font-mono">
        <p class="text-slate-400">Target IP: <span class="text-amber-400 font-bold">${esc(data.ip)}</span></p>
        <p class="text-slate-400">Location: <span class="text-slate-200">${esc(data.city)}, ${esc(data.country)}</span></p>
        <p class="text-slate-400">ISP Provider: <span class="text-slate-200">${esc(data.connection?.isp || 'Standard Network')}</span></p>
        <p class="text-slate-400">Coordinates: <span class="text-emerald-400">${lat}, ${lon}</span></p>
        <p class="text-amber-400 pt-1 text-[11px]">Note: IP geolocation resolves to ISP routing centers.</p>
      </div>
    `;
    enableExport();
  } catch (e) {
    statusEl.textContent = 'IP Lookup Failed: ' + e.message;
  }
}

// --- 3. Hardware GPS Device Fix ---
function startGPS() {
  clearTrackingStreams();
  if (!navigator.geolocation) {
    statusEl.textContent = 'Geolocation is not supported by your browser.';
    return;
  }

  watchId = navigator.geolocation.watchPosition((pos) => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const accuracy = pos.coords.accuracy ?? null;
    const speed = pos.coords.speed ?? null;
    const timestamp = pos.timestamp ?? Date.now();

    positions.push({ target: 'Hardware GPS Fix', lat, lng, accuracy, speed, timestamp });

    if (!activeMarker) {
      activeMarker = L.marker([lat, lng]).addTo(map).bindPopup('<b>Device Unit:</b><br>Live GPS Fix Active').openPopup();
    } else {
      activeMarker.setLatLng([lat, lng]);
    }

    if (accuracyCircle) map.removeLayer(accuracyCircle);
    if (accuracy != null) {
      accuracyCircle = L.circle([lat, lng], { radius: accuracy, color: '#38bdf8', fillColor: '#38bdf8', fillOpacity: 0.15 }).addTo(map);
    }

    path.setLatLngs(positions.map(p => [p.lat, p.lng]));
    updateMap3DOverlays();

    if (followChk.checked) {
      setTrackingView(lat, lng, Math.max(16, map.getZoom()));
    }

    statusEl.textContent = 'Active (Hardware GPS)';
    modeLabel.textContent = 'Device GPS';
    updateMeta();
    enableExport();
  }, (err) => {
    statusEl.textContent = 'GPS Error: ' + err.message;
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 12000 });

  startBtn.disabled = true;
  startBtn.className = "bg-slate-800 text-slate-500 font-medium py-2 px-3 rounded-lg text-xs border border-slate-700/50 cursor-not-allowed";
  stopBtn.disabled = false;
  stopBtn.className = "bg-rose-600 hover:bg-rose-500 text-white font-medium py-2 px-3 rounded-lg text-xs transition shadow cursor-pointer";
  statusEl.textContent = 'Acquiring GPS Fix...';
}

function stopGPS() {
  clearTrackingStreams();
  startBtn.disabled = false;
  startBtn.className = "bg-sky-600 hover:bg-sky-500 text-white font-medium py-2 px-3 rounded-lg text-xs transition shadow cursor-pointer";
  stopBtn.disabled = true;
  stopBtn.className = "bg-slate-800 text-slate-500 font-medium py-2 px-3 rounded-lg text-xs border border-slate-700/50 cursor-not-allowed";
  statusEl.textContent = 'Idle';
  modeLabel.textContent = 'Ready';
}

function enableExport() {
  exportBtn.disabled = false;
  exportBtn.className = "w-full bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium py-2.5 px-3 rounded-lg text-xs border border-slate-700 transition cursor-pointer flex items-center justify-center gap-2";
}

// --- Export Telemetry Log (.CSV) ---
function exportCSV() {
  if (!positions.length) return;
  const header = ['target', 'latitude', 'longitude', 'accuracy_m', 'speed_ms', 'speed_kmh', 'timestamp_iso'];
  const rows = positions.map(p => {
    const iso = new Date(p.timestamp).toISOString();
    const speedK = p.speed != null ? (p.speed * 3.6).toFixed(3) : '0';
    return [p.target, p.lat, p.lng, p.accuracy ?? '', p.speed ?? '', speedK, iso].join(',');
  });
  const csv = [header.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `geotrack_telemetry_${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- Wire Event Handlers ---
trackPhoneBtn.addEventListener('click', trackPhone);
phoneInput.addEventListener('keydown', e => { if (e.key === 'Enter') trackPhone(); });
ipBtn.addEventListener('click', () => fetchAndRenderIP(''));
customIpBtn.addEventListener('click', () => fetchAndRenderIP(ipInput.value.trim()));
ipInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchAndRenderIP(ipInput.value.trim()); });
startBtn.addEventListener('click', startGPS);
stopBtn.addEventListener('click', stopGPS);
exportBtn.addEventListener('click', exportCSV);
toggle3dBtn.addEventListener('click', () => setMapMode(!map3dEnabled));