import { db } from "./firebase.js";
import { database } from "./firebase.js";
import {
  collection, addDoc, getDocs, doc, updateDoc, query, where, serverTimestamp, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    ref,
    onValue,
    query as dbQuery,
    orderByKey,
    limitToLast
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

/* =========================================
   MAP & DELIVERY STATE
========================================= */

let map;
let deliveryMarkers = {};
let deliveryRoutes  = {};
let watchId         = null;
let isNavigating    = false;

let driverLat = null;
let driverLng = null;

let storeMarkers    = [];
let storeRoute      = null;
let savedDeliveryId = null;

const deliveriesCol  = collection(db, "deliveries");
const usersCol       = collection(db, "users");
const inspectionsCol = collection(db, "inspections");

let selectedOrigin = { lat: null, lng: null, name: "" };
let selectedDest   = { lat: null, lng: null, name: "" };
let batchesMap     = {};

let followMode = true;

window.toggleFollowMode = function() {
    followMode = !followMode;
    const btn = document.getElementById('follow-toggle');
    if (btn) {
        btn.innerHTML = followMode
            ? `<i class="fa-solid fa-location-crosshairs"></i> Follow: ON`
            : `<i class="fa-solid fa-expand"></i> Follow: OFF`;
        btn.style.background = followMode ? '#0d9488' : '#64748b';
    }
};

/* =========================================
   ROUTE ALTERNATIVES STATE
   Tracks the fetched routes, which one the
   driver selected, and which delivery the
   panel is currently showing.
========================================= */

const ROUTE_COLORS = [
    { line: '#0d9488', colorClass: 'color-primary',   numClass: 'num-primary'   },
    { line: '#3b82f6', colorClass: 'color-secondary',  numClass: 'num-secondary' },
    { line: '#8b5cf6', colorClass: 'color-tertiary',   numClass: 'num-tertiary'  },
];

let altRoutes          = [];   // up to 3 LRM route objects
let selectedAltIndex   = 0;    // which card is selected (0 = first)
let altDeliveryId      = null; // which delivery the panel belongs to
let altPolylines       = [];   // drawn polylines for alternatives
let altFetchControl    = null; // temporary LRM control used only to fetch routes

/* =========================================
   CONSTANTS
========================================= */

const LOGS_PATH           = "AquaFresh_Logs";
const LIVE_POLL_INTERVAL  = 10_000;
const STORE_SEARCH_RADIUS = 5000;

/* =========================================
   ALERT SOUND
========================================= */

let audioCtx         = null;
let alarmSoundActive = false;

function getAudioContext() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
}

function doBeep(ctx) {
    const now = ctx.currentTime;
    [0, 0.2].forEach((offset) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, now + offset);
        gain.gain.setValueAtTime(0,    now + offset);
        gain.gain.linearRampToValueAtTime(0.6, now + offset + 0.01);
        gain.gain.linearRampToValueAtTime(0,   now + offset + 0.08);
        osc.start(now + offset);
        osc.stop(now  + offset + 0.1);
    });
}

function playAlertSound() {
    try {
        const ctx = getAudioContext();
        if (ctx.state === "suspended") {
            ctx.resume().then(() => doBeep(ctx)).catch(e => console.warn("Audio resume failed:", e));
        } else {
            doBeep(ctx);
        }
    } catch (err) { console.warn("Alert sound failed:", err); }
}

function handleAlarmSound(hasAlarms) {
    if (hasAlarms && !alarmSoundActive) { alarmSoundActive = true; playAlertSound(); }
    else if (!hasAlarms) { alarmSoundActive = false; }
}

function unlockAudio() {
    const unlock = () => {
        try { const ctx = getAudioContext(); if (ctx.state === "suspended") ctx.resume(); } catch (_) {}
    };
    document.addEventListener("click",      unlock, { once: true });
    document.addEventListener("keydown",    unlock, { once: true });
    document.addEventListener("touchstart", unlock, { once: true });
}

/* =========================================
   THRESHOLD CHECKS
========================================= */

function parseNumericValue(value) {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
        const m = value.match(/-?\d+(?:\.\d+)?/);
        return m ? parseFloat(m[0]) : Number.NaN;
    }
    return Number.NaN;
}

function getAlarmMessages(payload) {
    if (!payload) return [];
    const messages = [];
    const temp = parseNumericValue(payload.water_temp);
    const ph   = parseNumericValue(payload.ph_level);

    if (!Number.isNaN(temp)) {
        if (temp < 0) messages.push(`Water temperature dropped below 0°C (current: ${temp.toFixed(1)} °C)`);
        else if (temp > 4) messages.push(`Water temperature exceeded 4°C (current: ${temp.toFixed(1)} °C)`);
    }
    if (!Number.isNaN(ph)) {
        if (ph < 6.5) messages.push(`pH level dropped below 6.5 (current: ${ph.toFixed(2)})`);
        else if (ph > 7.5) messages.push(`pH level exceeded 7.5 (current: ${ph.toFixed(2)})`);
    }
    return messages;
}

/* =========================================
   THRESHOLD ALERT BANNER
========================================= */

function renderMapAlarmBanner(messages, timestamp) {
    const banner = document.getElementById("mapAlarmBanner");
    const list   = document.getElementById("mapAlarmMessages");
    const tsEl   = document.getElementById("mapAlarmTimestamp");

    if (!banner || !list) return;

    if (!messages || messages.length === 0) {
        banner.hidden = true;
        list.innerHTML = "";
        return;
    }

    list.innerHTML = messages.map(m => `<li>${m}</li>`).join("");

    if (tsEl && timestamp) {
        const d = new Date(typeof timestamp === "number"
            ? (timestamp < 1e12 ? timestamp * 1000 : timestamp)
            : timestamp);
        tsEl.textContent = isNaN(d.getTime()) ? "" : `Last updated ${d.toLocaleString([], {
            month: "short", day: "numeric",
            hour: "2-digit", minute: "2-digit", second: "2-digit"
        })}`;
    }

    banner.hidden = false;
}

/* =========================================
   NEAREST STORE FINDER
========================================= */

let lastStoreFetchLat = null;
let lastStoreFetchLng = null;
let storeFetchActive  = false;

async function findNearestStores(lat, lng) {
    if (lastStoreFetchLat !== null) {
        const dist = getDistanceMeters(lat, lng, lastStoreFetchLat, lastStoreFetchLng);
        if (dist < 200 && storeFetchActive) return;
    }

    lastStoreFetchLat = lat;
    lastStoreFetchLng = lng;
    storeFetchActive  = true;

    const radius = STORE_SEARCH_RADIUS;
    const overpassQuery = `
        [out:json][timeout:15];
        (
          node["shop"="convenience"](around:${radius},${lat},${lng});
          node["shop"="supermarket"](around:${radius},${lat},${lng});
          node["shop"="ice_cream"](around:${radius},${lat},${lng});
          node["shop"="frozen_food"](around:${radius},${lat},${lng});
          node["amenity"="ice_cream"](around:${radius},${lat},${lng});
          node["vending"="ice"](around:${radius},${lat},${lng});
        );
        out body;
    `;

    try {
        updateStoreStatus("Searching for nearby stores…", "loading");

        const res  = await fetch("https://overpass-api.de/api/interpreter", {
            method : "POST",
            body   : overpassQuery
        });
        const data = await res.json();
        const stores = data.elements || [];

        clearStoreMarkers();

        if (stores.length === 0) {
            updateStoreStatus("No nearby stores found within 5 km.", "empty");
            hideStorePanel();
            return;
        }

        const sorted = stores
            .map(s => ({ ...s, distance: getDistanceMeters(lat, lng, s.lat, s.lon) }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 10);

        plotStoreMarkers(sorted, lat, lng);
        renderStoreList(sorted);
        updateStoreStatus(`Found ${sorted.length} store(s) within 5 km`, "ok");

    } catch (err) {
        console.error("Overpass API error:", err);
        updateStoreStatus("Could not load nearby stores. Check connection.", "error");
    }
}

function clearStoreMarkers() {
    storeMarkers.forEach(m => map.removeLayer(m));
    storeMarkers = [];
}

function plotStoreMarkers(stores, fromLat, fromLng) {
    const storeIcon = L.divIcon({
        className: "store-marker-icon",
        html: `<div class="store-marker"><i class="fa-solid fa-store"></i></div>`,
        iconSize:  [34, 34],
        iconAnchor:[17, 17]
    });

    stores.forEach((store, idx) => {
        const name   = store.tags?.name || "Unnamed Store";
        const type   = getStoreTypeLabel(store.tags);
        const distKm = (store.distance / 1000).toFixed(1);

        const marker = L.marker([store.lat, store.lon], { icon: storeIcon })
            .addTo(map)
            .bindPopup(`
                <div class="store-popup">
                    <div class="store-popup-name">${idx + 1}. ${name}</div>
                    <div class="store-popup-type">${type}</div>
                    <div class="store-popup-dist"><i class="fa-solid fa-location-dot"></i> ${distKm} km away</div>
                    <button
                        class="store-popup-directions"
                        onclick="navigateToStore(${store.lat}, ${store.lon}, '${name.replace(/'/g, "\\'")}')">
                        <i class="fa-solid fa-diamond-turn-right"></i> Get Directions
                    </button>
                </div>
            `, { maxWidth: 220 });

        storeMarkers.push(marker);
    });
}

function renderStoreList(stores) {
    const panel = document.getElementById("nearbyStoresPanel");
    const list  = document.getElementById("nearbyStoresList");
    if (!panel || !list) return;

    list.innerHTML = stores.map((store, idx) => {
        const name   = store.tags?.name || "Unnamed Store";
        const type   = getStoreTypeLabel(store.tags);
        const distKm = (store.distance / 1000).toFixed(1);

        return `
        <div class="store-list-item" onclick="focusStore(${store.lat}, ${store.lon})">
            <div class="store-list-num">${idx + 1}</div>
            <div class="store-list-info">
                <div class="store-list-name">${name}</div>
                <div class="store-list-meta">${type} · ${distKm} km away</div>
            </div>
            <i class="fa-solid fa-chevron-right store-list-arrow"></i>
        </div>`;
    }).join("");

    panel.hidden = false;
}

function hideStorePanel() {
    const panel = document.getElementById("nearbyStoresPanel");
    if (panel) panel.hidden = true;
}

function clearStoresAndHidePanel() {
    clearStoreMarkers();
    hideStorePanel();
    storeFetchActive  = false;
    lastStoreFetchLat = null;
    lastStoreFetchLng = null;
    updateStoreStatus("", "");
}

window.onFindStoresClicked = function () {
    if (!currentlyEnRoute) {
        showStoreBtnFeedback("Start your delivery first to find nearby stores.", "empty");
        return;
    }
    if (driverLat === null || driverLng === null) {
        showStoreBtnFeedback("Waiting for GPS signal… try again in a moment.", "loading");
        return;
    }
    document.getElementById("delivery-map")?.scrollIntoView({ behavior: "smooth", block: "center" });
    findNearestStores(driverLat, driverLng);
};

function showStoreBtnFeedback(message, type) {
    updateStoreStatus(message, type);
    document.getElementById("storeSearchStatus")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

window.focusStore = function(lat, lng) {
    if (map) map.setView([lat, lng], 17);
    storeMarkers.forEach(m => {
        const pos = m.getLatLng();
        if (Math.abs(pos.lat - lat) < 0.0001 && Math.abs(pos.lng - lng) < 0.0001) {
            m.openPopup();
        }
    });
};

window.navigateToStore = function(storeLat, storeLng, storeName) {
    if (driverLat === null || driverLng === null) {
        alert("GPS position not available yet. Please wait a moment and try again.");
        return;
    }
    map.closePopup();
    Object.keys(deliveryRoutes).forEach(id => {
        const route = deliveryRoutes[id];
        if (route) { map.removeControl(route); savedDeliveryId = id; }
    });
    if (storeRoute) { map.removeControl(storeRoute); storeRoute = null; }
    storeRoute = L.Routing.control({
        waypoints: [ L.latLng(driverLat, driverLng), L.latLng(storeLat, storeLng) ],
        addWaypoints      : false,
        routeWhileDragging: false,
        fitSelectedRoutes : true,
        show              : false,
        lineOptions: { styles: [{ color: '#0ea5e9', opacity: 1, weight: 6 }] },
        createMarker: () => null
    }).addTo(map);
    storeRoute.on('routesfound', function(e) {
        const route     = e.routes[0];
        const distKm    = (route.summary.totalDistance / 1000).toFixed(1);
        const minutes   = Math.round(route.summary.totalTime / 60);
        const statusBox = document.getElementById('map-status');
        if (statusBox) {
            statusBox.innerHTML = `
                <i class="fa-solid fa-store" style="color:#0ea5e9;"></i>
                <b>Detour to ${storeName}:</b> ${distKm} km · ~${minutes} min
                &nbsp;
                <button class="back-to-delivery-btn" onclick="backToDeliveryRoute()">
                    <i class="fa-solid fa-rotate-left"></i> Back to Delivery Route
                </button>`;
        }
    });
    updateStoreStatus(`Routing to ${storeName}…`, "loading");
};

window.backToDeliveryRoute = function() {
    if (storeRoute) { map.removeControl(storeRoute); storeRoute = null; }
    if (savedDeliveryId && deliveryRoutes[savedDeliveryId]) {
        deliveryRoutes[savedDeliveryId].addTo(map);
    }
    savedDeliveryId = null;
    const statusBox = document.getElementById('map-status');
    if (statusBox) {
        statusBox.innerHTML = `<i class="fa-solid fa-location-crosshairs" style="color:#059669;"></i> Navigation Mode Active`;
    }
    updateStoreStatus("", "");
};

function getStoreTypeLabel(tags) {
    if (!tags) return "Store";
    if (tags.shop === "convenience")  return "Convenience Store";
    if (tags.shop === "supermarket")  return "Supermarket";
    if (tags.shop === "ice_cream")    return "Ice Cream / Ice Shop";
    if (tags.shop === "frozen_food")  return "Frozen Food Store";
    if (tags.amenity === "ice_cream") return "Ice Cream Shop";
    if (tags.vending === "ice")       return "Ice Vending Machine";
    return "Store";
}

function updateStoreStatus(message, type) {
    const el = document.getElementById("storeSearchStatus");
    if (!el) return;
    const colors = { loading: "#0ea5e9", ok: "#16a34a", empty: "#94a3b8", error: "#dc2626", "": "#94a3b8" };
    const icons  = { loading: `<i class="fa-solid fa-spinner fa-spin"></i>`, ok: `<i class="fa-solid fa-check-circle"></i>`, empty: `<i class="fa-solid fa-inbox"></i>`, error: `<i class="fa-solid fa-triangle-exclamation"></i>`, "": "" };
    el.style.color   = colors[type] || "#94a3b8";
    el.innerHTML     = message ? `${icons[type] || ""} ${message}` : "";
    el.style.display = message ? "flex" : "none";
}

function getDistanceMeters(lat1, lng1, lat2, lng2) {
    const R    = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2
               + Math.cos(lat1 * Math.PI / 180)
               * Math.cos(lat2 * Math.PI / 180)
               * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* =========================================
   SENSOR WATCHER
========================================= */

let currentlyEnRoute = false;

function startSensorWatch() {
    watchSensor();
    setInterval(watchSensor, LIVE_POLL_INTERVAL);
}

function watchSensor() {
    const latestQuery = dbQuery(
        ref(database, LOGS_PATH),
        orderByKey(),
        limitToLast(1)
    );
    onValue(latestQuery, (snapshot) => {
        if (!snapshot.exists()) return;
        let payload = null;
        snapshot.forEach((child) => { payload = child.val(); });
        const messages  = getAlarmMessages(payload);
        const hasAlarms = messages.length > 0;
        const timestamp = payload?.timestamp ?? Date.now();
        renderMapAlarmBanner(messages, timestamp);
        handleAlarmSound(hasAlarms);
        if (!hasAlarms && storeFetchActive) clearStoresAndHidePanel();
    }, (error) => { console.warn("Sensor watch error on TransportDelivery:", error); });
}

/* =========================================
   INIT
========================================= */

document.addEventListener("DOMContentLoaded", initPage);

async function initPage() {
    const role = localStorage.getItem("role");
    unlockAudio();

    await loadBatches();

    if (["superadmin", "admin", "manager"].includes(role)) {
        const triggerWrap = document.getElementById("createDeliveryWrapper");
        if (triggerWrap) triggerWrap.style.display = "block";
        loadDrivers();
        loadCustomers();
        setupLocationAutocomplete();
        document.getElementById("btn-new-delivery")?.addEventListener("click", async () => {
            const preview = document.getElementById("deliveryCodeDisplay");
            if (preview) { preview.value = "Generating..."; preview.value = await generateDeliveryCode(); }
        });
    }

    initMap();
    listenToDeliveries();
    startSensorWatch();
}

/* =========================================
   AUTO-GENERATE DELIVERY CODE
========================================= */

async function generateDeliveryCode() {
    try {
        const snapshot = await getDocs(deliveriesCol);
        let maxNum = 0;
        snapshot.forEach(d => {
            const code  = d.data().deliveryCode || "";
            const match = code.match(/^D-(\d+)$/i);
            if (match) {
                const num = parseInt(match[1], 10);
                if (num > maxNum) maxNum = num;
            }
        });
        return "D-" + String(maxNum + 1).padStart(2, "0");
    } catch (e) {
        console.error("Could not generate delivery code:", e);
        return "D-01";
    }
}

/* =========================================
   MAP INITIALIZATION
========================================= */

function initMap() {
    map = L.map('delivery-map').setView([14.5995, 120.9842], 12);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    document.getElementById('map-status').innerText =
        "Map loaded. Awaiting active deliveries.";
}

/* =========================================
   LOCATION AUTOCOMPLETE
========================================= */

function setupLocationAutocomplete() {
    const originInput = document.getElementById("origin");
    const destInput   = document.getElementById("destination");
    originInput.addEventListener("input", (e) => handleSearch(e.target.value, "origin"));
    destInput.addEventListener("input",   (e) => handleSearch(e.target.value, "destination"));
    document.addEventListener("click", (e) => {
        if (e.target.id !== "origin")      document.getElementById("origin-suggestions").style.display = "none";
        if (e.target.id !== "destination") document.getElementById("dest-suggestions").style.display   = "none";
    });
}

let searchTimeout;
async function handleSearch(queryText, type) {
    clearTimeout(searchTimeout);
    const suggestionBox = document.getElementById(type === "origin" ? "origin-suggestions" : "dest-suggestions");
    if (queryText.length < 3) { suggestionBox.style.display = "none"; return; }
    searchTimeout = setTimeout(async () => {
        try {
            const res     = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${queryText}&limit=5&countrycodes=ph`);
            const results = await res.json();
            suggestionBox.innerHTML = "";
            if (results.length > 0) {
                suggestionBox.style.display = "block";
                results.forEach(place => {
                    const div     = document.createElement("div");
                    div.className = "autocomplete-item";
                    div.innerText = place.display_name;
                    div.onclick   = () => selectLocation(place, type);
                    suggestionBox.appendChild(div);
                });
            } else {
                suggestionBox.style.display = "none";
            }
        } catch (err) { console.error("Geocoding error", err); }
    }, 500);
}

function selectLocation(place, type) {
    if (type === "origin") {
        document.getElementById("origin").value = place.display_name;
        selectedOrigin = { lat: parseFloat(place.lat), lng: parseFloat(place.lon), name: place.display_name };
        document.getElementById("origin-suggestions").style.display = "none";
    } else {
        document.getElementById("destination").value = place.display_name;
        selectedDest = { lat: parseFloat(place.lat), lng: parseFloat(place.lon), name: place.display_name };
        document.getElementById("dest-suggestions").style.display = "none";
    }
    if (selectedOrigin.lat && selectedDest.lat) {
        autoCalculateETA();
    }
}

/* =========================================
   AUTO-CALCULATE ETA VIA OSRM
========================================= */

async function autoCalculateETA() {
    const etaInput = document.getElementById("eta");
    const etaHint  = document.getElementById("eta-hint");

    if (!etaInput) return;

    etaInput.value       = "";
    etaInput.placeholder = "Calculating route…";
    if (etaHint) etaHint.textContent = "⏳ Fetching route estimate…";

    try {
        const url = `https://router.project-osrm.org/route/v1/driving/` +
                    `${selectedOrigin.lng},${selectedOrigin.lat};` +
                    `${selectedDest.lng},${selectedDest.lat}` +
                    `?overview=false`;

        const res  = await fetch(url);
        const data = await res.json();

        if (data.code !== "Ok" || !data.routes || data.routes.length === 0) {
            etaInput.placeholder = "Could not calculate — enter manually";
            if (etaHint) etaHint.textContent = "⚠️ Route not found. Please set ETA manually.";
            return;
        }

        const seconds = data.routes[0].duration;
        const distKm  = (data.routes[0].distance / 1000).toFixed(1);
        const hours   = Math.floor(seconds / 3600);
        const minutes = Math.round((seconds % 3600) / 60);
        const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes} min`;

        const BUFFER_MINUTES = 15;
        const etaDate = new Date(Date.now() + seconds * 1000 + BUFFER_MINUTES * 60 * 1000);

        const pad = n => String(n).padStart(2, "0");
        const formatted = `${etaDate.getFullYear()}-${pad(etaDate.getMonth()+1)}-${pad(etaDate.getDate())}` +
                          `T${pad(etaDate.getHours())}:${pad(etaDate.getMinutes())}`;

        etaInput.value       = formatted;
        etaInput.placeholder = "Estimated Arrival";
        if (etaHint) {
            etaHint.textContent = `🛣️ ${distKm} km · ~${timeStr} drive (+15 min buffer). You can still adjust manually.`;
        }

    } catch (err) {
        console.error("OSRM ETA error:", err);
        etaInput.placeholder = "Could not calculate — enter manually";
        if (etaHint) etaHint.textContent = "⚠️ Could not reach routing service. Please set ETA manually.";
    }
}

/* =========================================
   LOAD BATCHES
========================================= */

async function loadBatches() {
    const select = document.getElementById("batchSelect");
    if (select) select.innerHTML = `<option value="">Select Batch</option>`;

    try {
        const passedSnap = await getDocs(query(inspectionsCol, where("overallStatus", "==", "Passed")));

        if (passedSnap.empty) {
            if (select) select.innerHTML += `<option value="" disabled>No passed batches available</option>`;
            return;
        }

        passedSnap.forEach(docSnap => {
            batchesMap[docSnap.id] = docSnap.data().batchCode || docSnap.id;
        });

        const deliveriesSnap = await getDocs(deliveriesCol);
        const usedBatchIds   = new Set();
        deliveriesSnap.forEach(d => {
            if (d.data().batchId) usedBatchIds.add(d.data().batchId);
        });

        let availableCount = 0;
        passedSnap.forEach(docSnap => {
            if (usedBatchIds.has(docSnap.id)) return;
            availableCount++;
            if (select) {
                select.innerHTML += `<option value="${docSnap.id}">${batchesMap[docSnap.id]}</option>`;
            }
        });

        if (availableCount === 0 && select) {
            select.innerHTML += `<option value="" disabled>All passed batches are already scheduled</option>`;
        }
    } catch (err) { console.error("Error loading batches:", err); }
}

async function loadDrivers() {
    const q        = query(usersCol, where("role", "==", "delivery"), where("status", "==", "active"));
    const snapshot = await getDocs(q);
    const select   = document.getElementById("driverSelect");
    select.innerHTML = `<option value="">Assign Driver</option>`;
    snapshot.forEach(docSnap => {
        select.innerHTML += `<option value="${docSnap.id}">${docSnap.data().fullName}</option>`;
    });
}

async function loadCustomers() {
    const q        = query(usersCol, where("role", "==", "customer"), where("status", "==", "active"));
    const snapshot = await getDocs(q);
    const select   = document.getElementById("customerSelect");
    if (!select) return;
    select.innerHTML = `<option value="">No Customer (Internal)</option>`;
    snapshot.forEach(docSnap => {
        const d = docSnap.data();
        select.innerHTML += `<option value="${docSnap.id}">${d.fullName} — ${d.deliveryAddress || d.address || ""}</option>`;
    });
}

/* =========================================
   CREATE DELIVERY
========================================= */

window.createDelivery = async function () {
    const batchId  = document.getElementById("batchSelect").value;
    const driverId = document.getElementById("driverSelect").value;
    const truck    = document.getElementById("truckSelect").value;
    const eta      = document.getElementById("eta").value;
    const customerId = document.getElementById("customerSelect")?.value || "";

    if (!batchId || !driverId || !truck || !selectedOrigin.lat || !selectedDest.lat) {
        alert("Please fill all fields, select a truck, and pick valid locations from the dropdown.");
        return;
    }

    const deliveryCode = document.getElementById("deliveryCodeDisplay").value || await generateDeliveryCode();
    const driverSnap   = await getDocs(query(usersCol, where("__name__", "==", driverId)));
    let driverName     = "";
    driverSnap.forEach(d => driverName = d.data().fullName);

    const batchCode = batchesMap[batchId] || batchId;

    await addDoc(deliveriesCol, {
        deliveryCode,
        batchId,
        batchCode,
        driverId,
        driverName,
        truck,
        eta,
        customerId,
        origin:      selectedOrigin.name,
        originLat:   selectedOrigin.lat,
        originLng:   selectedOrigin.lng,
        destination: selectedDest.name,
        destLat:     selectedDest.lat,
        destLng:     selectedDest.lng,
        status:      "pending",
        createdAt:   serverTimestamp(),
        currentLat:  selectedOrigin.lat,
        currentLng:  selectedOrigin.lng,
        avgTemp:     null
    });

    alert(`Delivery ${deliveryCode} created successfully!`);
    document.getElementById("origin").value      = "";
    document.getElementById("destination").value = "";
    document.getElementById("truckSelect").value = "";
    document.getElementById("deliveryCodeDisplay").value = "";
    selectedOrigin = { lat: null, lng: null, name: "" };
    selectedDest   = { lat: null, lng: null, name: "" };
    await loadBatches();
    if (window.closeModal) window.closeModal("modal-new-delivery");
};

/* =========================================
   ROUTE ALTERNATIVES
   Shows up to 3 route cards below the map
   for a pending delivery. Delivery role only.
   The driver selects a route, then presses
   "Start Delivery" which uses the chosen one.
========================================= */

function showRouteAlternatives(deliveryId, oLat, oLng, dLat, dLng) {
    const role = localStorage.getItem("role");
    if (role !== "delivery") return;

    // Don't re-render if already showing for this delivery
    if (altDeliveryId === deliveryId && altRoutes.length > 0) return;

    altDeliveryId    = deliveryId;
    altRoutes        = [];
    selectedAltIndex = 0;

    const panel = document.getElementById("route-alternatives-panel");
    const cards = document.getElementById("route-alt-cards");
    if (!panel || !cards) return;

    panel.style.display = "block";
    cards.innerHTML = `
        <div class="route-alt-loading">
            <i class="fa-solid fa-spinner fa-spin"></i>
            Calculating available routes…
        </div>`;

    // Clean up any previous fetch control
    clearAltFetchControl();

    // Use a hidden LRM control purely to fetch the route alternatives
    altFetchControl = L.Routing.control({
        waypoints: [
            L.latLng(oLat, oLng),
            L.latLng(dLat, dLng)
        ],
        addWaypoints:       false,
        routeWhileDragging: false,
        fitSelectedRoutes:  true,
        show:               false,
        showAlternatives:   true,
        lineOptions: {
            styles: [{ color: ROUTE_COLORS[0].line, opacity: 1, weight: 5 }]
        },
        altLineOptions: {
            styles: [
                { color: 'black',                  opacity: 0.15, weight: 9   },
                { color: 'white',                  opacity: 0.8,  weight: 6   },
                { color: ROUTE_COLORS[1].line,     opacity: 0.85, weight: 4.5 }
            ]
        },
        createMarker: () => null
    }).addTo(map);

    altFetchControl.on('routesfound', function(e) {
        // Cap at 3 alternatives
        altRoutes = e.routes.slice(0, 3);

        // Draw all route lines on the map so driver can preview them
        clearAltPolylines();
        altRoutes.forEach((route, idx) => {
            const color = ROUTE_COLORS[idx] || ROUTE_COLORS[0];
            const opacity = idx === 0 ? 1 : 0.45;
            const weight  = idx === 0 ? 6 : 4;
            const poly = L.polyline(route.coordinates, {
                color:   color.line,
                weight,
                opacity,
                dashArray: idx === 0 ? null : '6, 8'
            }).addTo(map);
            altPolylines.push(poly);
        });

        // Fit map to show all routes
        if (altPolylines.length > 0) {
            const group = L.featureGroup(altPolylines);
            map.fitBounds(group.getBounds(), { padding: [30, 30] });
        }

        renderRouteCards(altRoutes, deliveryId);

        // Update status bar with first route info
        updateStatusBarForRoute(0);
    });

    altFetchControl.on('routingerror', function() {
        cards.innerHTML = `
            <div class="route-alt-loading" style="color:#dc2626;">
                <i class="fa-solid fa-triangle-exclamation"></i>
                Could not load route alternatives. Check your connection.
            </div>`;
    });
}

function clearAltFetchControl() {
    if (altFetchControl) {
        try { map.removeControl(altFetchControl); } catch (_) {}
        altFetchControl = null;
    }
}

function clearAltPolylines() {
    altPolylines.forEach(p => { try { map.removeLayer(p); } catch (_) {} });
    altPolylines = [];
}

function hideRouteAlternatives() {
    const panel = document.getElementById("route-alternatives-panel");
    if (panel) panel.style.display = "none";
    clearAltFetchControl();
    clearAltPolylines();
    altRoutes        = [];
    altDeliveryId    = null;
    selectedAltIndex = 0;
}

function renderRouteCards(routes, deliveryId) {
    const cards = document.getElementById("route-alt-cards");
    if (!cards) return;

    // Find fastest and shortest for badge labelling
    const minTime = Math.min(...routes.map(r => r.summary.totalTime));
    const minDist = Math.min(...routes.map(r => r.summary.totalDistance));

    cards.innerHTML = routes.map((route, idx) => {
        const color   = ROUTE_COLORS[idx] || ROUTE_COLORS[0];
        const distKm  = (route.summary.totalDistance / 1000).toFixed(1);
        const secs    = route.summary.totalTime;
        const hrs     = Math.floor(secs / 3600);
        const mins    = Math.round((secs % 3600) / 60);
        const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins} min`;

        // Use the first segment of the LRM route name if available
        const routeName = route.name
            ? route.name.split(',')[0].trim()
            : `Route ${idx + 1}`;

        let badges = '';
        if (route.summary.totalTime === minTime && routes.length > 1) {
            badges += `<span class="route-alt-badge fastest"><i class="fa-solid fa-bolt"></i> Fastest</span>`;
        }
        if (route.summary.totalDistance === minDist && routes.length > 1) {
            badges += `<span class="route-alt-badge shortest"><i class="fa-solid fa-minimize"></i> Shortest</span>`;
        }

        const isSelected = idx === selectedAltIndex;

        return `
        <div class="route-alt-card ${isSelected ? 'selected' : ''}"
             data-route-idx="${idx}"
             onclick="selectRouteAlternative(${idx}, '${deliveryId}')">
            <div class="route-alt-color ${color.colorClass}"></div>
            <div class="route-alt-num ${color.numClass}">${idx + 1}</div>
            <div class="route-alt-info">
                <div class="route-alt-name">${routeName}${badges}</div>
                <div class="route-alt-meta">
                    <span class="route-alt-stat">
                        <i class="fa-solid fa-road"></i> ${distKm} km
                    </span>
                    <span class="route-alt-stat">
                        <i class="fa-solid fa-clock"></i> ~${timeStr}
                    </span>
                </div>
            </div>
            <div class="route-alt-check"><i class="fa-solid fa-check"></i></div>
        </div>`;
    }).join('');
}

// Called when driver taps a route card
window.selectRouteAlternative = function(idx, deliveryId) {
    if (idx < 0 || idx >= altRoutes.length) return;

    selectedAltIndex = idx;

    // Update card selected state
    document.querySelectorAll('.route-alt-card').forEach((card, i) => {
        card.classList.toggle('selected', i === idx);
    });

    // Redraw polylines: selected route solid + full opacity, others faded
    altPolylines.forEach((poly, i) => {
        poly.setStyle({
            opacity:   i === idx ? 1    : 0.3,
            weight:    i === idx ? 6    : 3,
            dashArray: i === idx ? null : '6, 8'
        });
        if (i === idx) poly.bringToFront();
    });

    updateStatusBarForRoute(idx);
};

function updateStatusBarForRoute(idx) {
    if (!altRoutes[idx]) return;
    const route   = altRoutes[idx];
    const color   = ROUTE_COLORS[idx] || ROUTE_COLORS[0];
    const distKm  = (route.summary.totalDistance / 1000).toFixed(1);
    const secs    = route.summary.totalTime;
    const hrs     = Math.floor(secs / 3600);
    const mins    = Math.round((secs % 3600) / 60);
    const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins} min`;
    const statusBox = document.getElementById('map-status');
    if (statusBox) {
        statusBox.innerHTML = `
            <i class="fa-solid fa-route" style="color:${color.line};"></i>
            <b>Route ${idx + 1} selected:</b> ${distKm} km · ~${timeStr}
            <span style="font-size:11px;color:#94a3b8;margin-left:8px;">Press Start Delivery to begin navigation</span>`;
    }
}

/* =========================================
   REAL-TIME DELIVERIES LISTENER
========================================= */

function listenToDeliveries() {
    const role   = localStorage.getItem("role");
    const userId = localStorage.getItem("userId");

    let q = query(deliveriesCol);
    if (role === "delivery") {
        q = query(deliveriesCol, where("driverId", "==", userId));
    }

    const truckIcon = L.divIcon({
        className: 'custom-truck-icon',
        html:      "<div class='truck-marker'><i class='fa-solid fa-truck'></i></div>",
        iconSize:  [36, 36],
        iconAnchor:[18, 18]
    });

    onSnapshot(q, (snapshot) => {
        const allBody       = document.getElementById("all-deliveries-body");
        const pendingBody   = document.getElementById("pending-body");
        const enrouteBody   = document.getElementById("enroute-body");
        const deliveredBody = document.getElementById("delivered-body");
        const delayedBody   = document.getElementById("delayed-body");

        allBody.innerHTML       = "";
        pendingBody.innerHTML   = "";
        enrouteBody.innerHTML   = "";
        deliveredBody.innerHTML = "";
        delayedBody.innerHTML   = "";

        let counts = { pending: 0, enroute: 0, delivered: 0, delayed: 0, received: 0 };

        let docsArray = [];
        snapshot.forEach(docSnap => docsArray.push({ id: docSnap.id, ...docSnap.data() }));
        docsArray.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));

        currentlyEnRoute = docsArray.some(d => d.status === "en_route");

        // Auto-mark delayed: en_route deliveries more than 20 mins past ETA
        const now      = Date.now();
        const GRACE_MS = 20 * 60 * 1000;
        docsArray.forEach(async d => {
            if (d.status === "en_route" && d.eta) {
                const etaMs = new Date(d.eta).getTime();
                if (!isNaN(etaMs) && now > etaMs + GRACE_MS) {
                    try {
                        await updateDoc(doc(db, "deliveries", d.id), { status: "delayed" });
                    } catch (e) { console.warn("Could not auto-mark delayed:", e); }
                }
            }
        });

        // Track whether the delivery role user has a pending delivery
        // to decide whether to show/hide the route alternatives panel
        let hasPendingDelivery = false;

        docsArray.forEach(d => {
            const id = d.id;

            if (d.status === "delivered" || d.status === "received") {
                // Clean up map layers for completed deliveries
                if (deliveryMarkers[id]) { map.removeLayer(deliveryMarkers[id]); delete deliveryMarkers[id]; }
                if (deliveryRoutes[id])  { map.removeControl(deliveryRoutes[id]); delete deliveryRoutes[id]; }
            } else {
                // Draw route on map for non-delivered deliveries
                if (d.originLat && d.destLat && !deliveryRoutes[id]) {

                    if (role === "delivery" && d.status === "pending") {
                        // ── DELIVERY ROLE + PENDING ──
                        // Show route alternatives panel instead of a fixed LRM route.
                        // The polylines are drawn inside showRouteAlternatives().
                        hasPendingDelivery = true;
                        showRouteAlternatives(
                            id,
                            d.currentLat || d.originLat,
                            d.currentLng || d.originLng,
                            d.destLat,
                            d.destLng
                        );
                        // Store a placeholder so we don't re-trigger on next snapshot
                        deliveryRoutes[id] = { _placeholder: true, setWaypoints: () => {} };

                    } else {
                        // ── ALL OTHER ROLES / EN ROUTE / DELAYED ──
                        // Standard LRM route with alternatives visible on map
                        deliveryRoutes[id] = L.Routing.control({
                            waypoints: [
                                L.latLng(d.currentLat || d.originLat, d.currentLng || d.originLng),
                                L.latLng(d.destLat, d.destLng)
                            ],
                            addWaypoints:       false,
                            routeWhileDragging: false,
                            fitSelectedRoutes:  true,
                            show:               true,
                            showAlternatives:   true,
                            altLineOptions: {
                                styles: [
                                    { color: 'black',   opacity: 0.15, weight: 9   },
                                    { color: 'white',   opacity: 0.8,  weight: 6   },
                                    { color: '#64748b', opacity: 0.9,  weight: 4.5 }
                                ]
                            },
                            lineOptions: { styles: [{ color: '#0d9488', opacity: 1, weight: 6 }] },
                            createMarker: () => null
                        }).addTo(map);

                            deliveryRoutes[id].on('routesfound', function(e) {
                            if (!e.routes || !e.routes.length) return;

                            const route = e.routes[0];

                            const distanceKm = (route.summary.totalDistance / 1000).toFixed(1);
                            const minutes = Math.round(route.summary.totalTime / 60);

                            const statusBox = document.getElementById('map-status');
                            if (statusBox) {
                                statusBox.innerHTML = `
                                    <i class="fa-solid fa-route" style="color:#0f766e;"></i>
                                    <b>Route:</b> ${distanceKm} km | 
                                    Est. Time: <span style="color:#0f766e;font-weight:700;">${minutes} min</span>
                                `;
                            }
                        });
                    }
                }

                const urlParams = new URLSearchParams(window.location.search);
                if (urlParams.get('focus') === id && !isNavigating) {
                    map.setView([d.currentLat || d.originLat, d.currentLng || d.originLng], 14);
                }

                if (d.currentLat && d.currentLng) {
                    if (!deliveryMarkers[id]) {
                        deliveryMarkers[id] = L.marker([d.currentLat, d.currentLng], { icon: truckIcon })
                            .addTo(map)
                            .bindPopup(`<b>${d.deliveryCode}</b><br>Status: ${d.status.replace("_", " ")}`);
                    } else {
                        deliveryMarkers[id].setLatLng([d.currentLat, d.currentLng]);
                        deliveryMarkers[id].getPopup().setContent(`<b>${d.deliveryCode}</b><br>Status: ${d.status.replace("_", " ")}`);
                    }
                }

                // Resume GPS tracking for en_route / delayed deliveries
                if (role === "delivery" && (d.status === "en_route" || d.status === "delayed") && !isNavigating) {
                    startTracking(id, d.destLat, d.destLng);
                }
            }

            // Build action buttons
            let actionButton = "";
            if (role === "delivery") {
                if (d.status === "pending")
                    actionButton = `<button class="start-btn" onclick="updateStatus('${id}', 'en_route', ${d.destLat}, ${d.destLng})">Start Delivery</button>`;
                if (d.status === "en_route" || d.status === "delayed")
                    actionButton = `<button class="deliver-btn" onclick="updateStatus('${id}', 'delivered')">Mark Delivered</button>`;
            } else {
                actionButton = `<span class="status-${d.status}">${d.status.replace("_", " ")}</span>`;
            }

            const shortOrigin   = d.origin      ? d.origin.split(',')[0]      : "-";
            const shortDest     = d.destination ? d.destination.split(',')[0] : "-";
            const truckName     = d.truck        || "-";
            const formattedDate = d.eta          ? new Date(d.eta).toLocaleString() : "-";
            const deliveredDate = d.deliveredAt  ? d.deliveredAt.toDate().toLocaleString() : "-";

            const displayBatch = d.batchCode || batchesMap[d.batchId] || d.batchId || "-";

            if (d.status !== "delivered" && d.status !== "received") {
                allBody.innerHTML += `
                <tr>
                    <td><strong>${d.deliveryCode}</strong></td>
                    <td>${displayBatch}</td>
                    <td>${d.driverName || "-"}</td>
                    <td>${truckName}</td>
                    <td>${shortOrigin}</td>
                    <td>${shortDest}</td>
                    <td>${formattedDate}</td>
                    <td>${actionButton}</td>
                </tr>`;
            }

            if (d.status === "pending") {
                counts.pending++;
                pendingBody.innerHTML += `<tr><td><strong>${d.deliveryCode}</strong></td><td>${displayBatch}</td><td>${d.driverName || "-"}</td><td>${truckName}</td><td>${shortOrigin}</td><td>${shortDest}</td><td>${formattedDate}</td><td>${actionButton}</td></tr>`;
            } else if (d.status === "en_route") {
                counts.enroute++;
                enrouteBody.innerHTML += `<tr><td><strong>${d.deliveryCode}</strong></td><td>${displayBatch}</td><td>${d.driverName || "-"}</td><td>${truckName}</td><td>${shortOrigin}</td><td>${shortDest}</td><td>${formattedDate}</td><td>${actionButton}</td></tr>`;
            } else if (d.status === "delivered") {
                counts.delivered++;
                deliveredBody.innerHTML += `<tr><td><strong>${d.deliveryCode}</strong></td><td>${displayBatch}</td><td>${d.driverName || "-"}</td><td>${truckName}</td><td>${shortOrigin}</td><td>${shortDest}</td><td>${deliveredDate}</td><td><span class="status-delivered">Delivered</span></td></tr>`;
            } else if (d.status === "received") {   // ← ADD THIS BLOCK
                counts.delivered++;   // counts toward delivered total, not a separate count
                deliveredBody.innerHTML += `<tr><td><strong>${d.deliveryCode}</strong></td><td>${displayBatch}</td><td>${d.driverName || "-"}</td><td>${truckName}</td><td>${shortOrigin}</td><td>${shortDest}</td><td>${deliveredDate}</td><td><span class="status-delivered">Received ✓</span></td></tr>`;
            } else {
                counts.delayed++;
                delayedBody.innerHTML += `<tr><td><strong>${d.deliveryCode}</strong></td><td>${displayBatch}</td><td>${d.driverName || "-"}</td><td>${truckName}</td><td>${shortOrigin}</td><td>${shortDest}</td><td>${formattedDate}</td><td>${actionButton}</td></tr>`;
            }
        });

        // Hide alternatives panel if the delivery role user has no pending deliveries
        if (role === "delivery" && !hasPendingDelivery) {
            hideRouteAlternatives();
        }

        document.getElementById("pending-count").textContent   = counts.pending;
        document.getElementById("enroute-count").textContent   = counts.enroute;
        document.getElementById("delivered-count").textContent = counts.delivered;
        document.getElementById("delayed-count").textContent   = counts.delayed;

        document.getElementById("modal-pending-count").textContent   = counts.pending;
        document.getElementById("modal-enroute-count").textContent   = counts.enroute;
        document.getElementById("modal-delivered-count").textContent = counts.delivered;
        document.getElementById("modal-delayed-count").textContent   = counts.delayed;
    });
}

/* =========================================
   UPDATE STATUS & GPS TRACKING
========================================= */

window.updateStatus = async function (id, status, destLat = null, destLng = null) {
    const updateData = { status };

    if (status === "en_route") {
        updateData.startedAt = serverTimestamp();

        // Hide the route alternatives panel — driver has committed to a route
        hideRouteAlternatives();

        // Clean up the placeholder entry so the real LRM control can be created
        if (deliveryRoutes[id]?._placeholder) {
            delete deliveryRoutes[id];
        }

        // If the driver selected a non-default route, draw it as a proper LRM
        // control so GPS tracking can update waypoints via setWaypoints()
        if (altRoutes.length > 0 && selectedAltIndex < altRoutes.length) {
            const chosenColor = ROUTE_COLORS[selectedAltIndex] || ROUTE_COLORS[0];
            // The route is already drawn as a polyline from showRouteAlternatives.
            // For GPS tracking we need a real LRM control with setWaypoints support.
            deliveryRoutes[id] = L.Routing.control({
                waypoints: [
                    L.latLng(destLat ? altRoutes[selectedAltIndex].coordinates[0].lat : altRoutes[0].coordinates[0].lat,
                             destLat ? altRoutes[selectedAltIndex].coordinates[0].lng : altRoutes[0].coordinates[0].lng),
                    L.latLng(destLat, destLng)
                ],
                addWaypoints:       false,
                routeWhileDragging: false,
                fitSelectedRoutes:  false,
                show:               false,
                lineOptions: { styles: [{ color: chosenColor.line, opacity: 1, weight: 6 }] },
                createMarker: () => null
            }).addTo(map);
        }

        startTracking(id, destLat, destLng);
    }

    if (status === "delivered") {
        updateData.deliveredAt = serverTimestamp();
        stopTracking();
        clearStoresAndHidePanel();
        hideRouteAlternatives();
        await loadBatches();
    }

    await updateDoc(doc(db, "deliveries", id), updateData);
};

function startTracking(deliveryId, destLat, destLng) {
    if (!navigator.geolocation) {
        alert("Geolocation is not supported by your browser.");
        return;
    }
    navigator.geolocation.getCurrentPosition(position => {
        isNavigating = true;
        document.getElementById('map-status').innerHTML =
            `<i class="fa-solid fa-location-crosshairs" style="color:#059669;"></i> Navigation Mode Active`;

        watchId = navigator.geolocation.watchPosition(async pos => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;

            driverLat = lat;
            driverLng = lng;

            // Only auto-center if user is not interacting
            if (followMode) {
            map.setView([lat, lng], map.getZoom());
            }
            if (deliveryMarkers[deliveryId]) deliveryMarkers[deliveryId].setLatLng([lat, lng]);
            if (deliveryRoutes[deliveryId] && destLat && destLng &&
                typeof deliveryRoutes[deliveryId].setWaypoints === "function") {
                deliveryRoutes[deliveryId].setWaypoints([
                    L.latLng(lat, lng),
                    L.latLng(destLat, destLng)
                ]);
            }
            await updateDoc(doc(db, "deliveries", deliveryId), { currentLat: lat, currentLng: lng });

        }, error => {
            console.error(error);
            document.getElementById('map-status').innerText = "GPS Error: Please enable location services.";
        }, { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 });

    }, error => {
        alert("Location permission denied. Please enable location access for this site.");
        console.error(error);
    });
}

function stopTracking() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        isNavigating  = false;
        driverLat     = null;
        driverLng     = null;
        document.getElementById('map-status').innerText = "Tracking stopped. Delivery completed.";
        map.setZoom(12);
    }
}