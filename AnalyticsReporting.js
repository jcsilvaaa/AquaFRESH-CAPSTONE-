import { database } from "./firebase.js";
import { db } from "./firebase.js";
import {
    ref,
    onValue,
    query,
    orderByKey,
    limitToLast,
    get
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import {
    collection,
    getDocs,
    query as fsQuery,
    orderBy
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const inspectionsCol = collection(db, "inspections");
const deliveriesCol  = collection(db, "deliveries");

/* =========================================
   CONSTANTS
========================================= */

const MAX_LIVE_POINTS    = 30;
const MAX_HISTORY_POINTS = 50;
const HISTORY_DAYS       = 7;
const LOGS_ROOT          = "AquaFresh_Logs"; // parent node — each device writes its own child under this

/* =========================================
   TANK / DEVICE MAP
   ---------------------------------------
   IMPORTANT: this is the fix for the bug where sensor
   readings weren't showing up. The ESP32 firmware pushes
   data to:
       /AquaFresh_Logs/<DEVICE_ID>/<pushId>
   NOT directly to /AquaFresh_Logs. Every tank in the UI
   must be mapped to the exact DEVICE_ID flashed onto that
   board (see #define DEVICE_ID in the .ino file).

   To add a 3rd device later, flash the board with
   DEVICE_ID "Device_3" and add a "tank3": "Device_3" line
   here (plus matching HTML ids — see notes below).
========================================= */

const TANKS = {
    tank1: "Device_1",
    tank2: "Device_2"
};

function logsPathFor(tankId) {
    const deviceId = TANKS[tankId];
    return `${LOGS_ROOT}/${deviceId}`;
}

/* =========================================
   ROLE
========================================= */

const CURRENT_ROLE = localStorage.getItem("role") || "";

/* =========================================
   ALERT SOUND — delivery role only
========================================= */

let audioCtx         = null;
let alarmSoundActive = false;

function getAudioContext() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
}

function playAlertSound() {
    if (CURRENT_ROLE !== "delivery") return;
    try {
        const ctx = getAudioContext();
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
    } catch (err) { console.warn("Alert sound failed:", err); }
}

function handleAlarmSound(hasAlarms) {
    if (hasAlarms && !alarmSoundActive) { alarmSoundActive = true; playAlertSound(); }
    else if (!hasAlarms) { alarmSoundActive = false; }
}

function unlockAudio() {
    if (CURRENT_ROLE !== "delivery") return;
    const unlock = () => {
        try { const ctx = getAudioContext(); if (ctx.state === "suspended") ctx.resume(); } catch (_) {}
    };
    document.addEventListener("click",      unlock, { once: true });
    document.addEventListener("keydown",    unlock, { once: true });
    document.addEventListener("touchstart", unlock, { once: true });
}

/* =========================================
   METRIC CONFIGS (drive the detail/trends panel
   for whichever tank is currently open)
========================================= */

const metricConfigs = {
    temperature: {
        firebaseKey      : "water_temp",
        label            : "Water Temperature (°C)",
        valueElement     : "temperature-current",
        timestampElement : "temperature-updated",
        chartId          : "temperatureChart",
        unit             : "°C",
        decimals         : 1,
        color            : "#0f766e"   // was #0ea5e9
    },
    ph: {
        firebaseKey      : "ph_level",
        label            : "pH Level",
        valueElement     : "ph-current",
        timestampElement : "ph-updated",
        chartId          : "phChart",
        unit             : "",
        decimals         : 2,
        color            : "#0f766e"   // was #10b981
    },
    humidity: {
        firebaseKey      : "humidity",
        label            : "Humidity (%)",
        valueElement     : "humidity-current",
        timestampElement : "humidity-updated",
        chartId          : "humidityChart",
        unit             : "%",
        decimals         : 1,
        color            : "#0f766e"   // was #f97316
    }
};

/* =========================================
   THRESHOLD CHECKS
========================================= */

const metricThresholdChecks = {
    temperature(value, config) {
        if (Number.isNaN(value)) return null;
        if (value < 0) return { metric: "temperature", message: `Water temperature dropped below 0°C (current: ${formatValueForAlert(value, config)})` };
        if (value > 4) return { metric: "temperature", message: `Water temperature exceeded 4°C (current: ${formatValueForAlert(value, config)})` };
        return null;
    },
    ph(value, config) {
        if (Number.isNaN(value)) return null;
        if (value < 6.5) return { metric: "ph", message: `pH level dropped below 6.5 (current: ${formatValueForAlert(value, config)})` };
        if (value > 7.5) return { metric: "ph", message: `pH level exceeded 7.5 (current: ${formatValueForAlert(value, config)})` };
        return null;
    },
};

function isTankAlert(temp, ph) {
    return (!Number.isNaN(temp) && (temp < 0 || temp > 4)) ||
           (!Number.isNaN(ph)   && (ph   < 6.5 || ph > 7.5));
}

/* =========================================
   CHART INSTANCES
========================================= */

const liveCharts    = {};
const historyCharts = {};

/* =========================================
   STATE
========================================= */

// per-tank last-known snapshot, kept up to date at all times (both tanks,
// regardless of which one is open) so the selection screen + top "View
// Tanks" card + alarm sound are always accurate.
const tankState = {}; // { tank1: { temp, ph, humidity, isAlert, timestamp, online }, tank2: {...} }

// which tank's detail/trends panel is currently open (null = selection screen)
let currentTankId = null;

// --- Avg Delay display format state (revision: employee-selectable format) ---
let lastAvgDelayMins = 0;      // raw minutes, kept so we can re-format on toggle without refetching
let delayFormatIsHM  = false;  // false = plain minutes, true = "1h 30m" style

/* =========================================
   INIT
========================================= */

document.addEventListener("DOMContentLoaded", () => {
    unlockAudio();
    initLiveCharts();
    injectHistorySections();
    watchAllTanks();          // realtime listeners for BOTH devices, always on
    loadFreshnessTrends();
    loadDeliveryPerformance();
    initDelayFormatToggle();  // revision: avg delay minutes <-> hours/minutes toggle
});

/* =========================================
   REALTIME LISTENERS — ONE PER DEVICE
   Always running, independent of which tank
   the user currently has open. Drives:
     - per-tank connection badge
     - per-tank selection card + modal row
     - the aggregate "View Tanks" summary card
     - the alarm sound (fires for either tank)
   If this tank is the one currently open, it
   ALSO drives the live charts / current value
   cards / alarm banner in the trends panel.
========================================= */

function watchAllTanks() {
    Object.keys(TANKS).forEach((tankId) => {
        const latestQuery = query(ref(database, logsPathFor(tankId)), orderByKey(), limitToLast(1));

        onValue(latestQuery, (snap) => {
            if (!snap.exists()) {
                tankState[tankId] = { temp: NaN, ph: NaN, humidity: NaN, isAlert: false, timestamp: null, online: false };
                renderTankConnection(tankId, false);
                renderTankRows(tankId, null, null);
                if (tankId === currentTankId) showNoDataMessage("No logs found for this tank.");
                recomputeAggregateState();
                return;
            }

            let payload = null;
            snap.forEach((child) => { payload = child.val(); });

            if (!payload || typeof payload !== "object") {
                if (tankId === currentTankId) showNoDataMessage("Latest log entry is empty.");
                return;
            }

            const payloadTimestamp = extractTimestampFromPayload(payload);
            const tsDate           = normalizeTimestampValue(payloadTimestamp ?? Date.now());
            const ageMs             = Date.now() - tsDate.getTime();
            const online            = ageMs < IOT_OFFLINE_THRESHOLD_MS;

            const temp     = parseNumericValue(payload.water_temp);
            const ph       = parseNumericValue(payload.ph_level);
            const humidity = parseNumericValue(payload.humidity);
            const alert    = isTankAlert(temp, ph);

            tankState[tankId] = { temp, ph, humidity, isAlert: alert, timestamp: tsDate, online };

            renderTankConnection(tankId, online);
            renderTankRows(tankId, payload, tsDate);
            recomputeAggregateState();

            // If this tank's detail panel is the one currently open, also
            // update the live metric cards / charts / alarm banner.
            if (tankId === currentTankId) {
                const triggeredAlarms = [];
                Object.entries(metricConfigs).forEach(([metric, config]) => {
                    const rawValue     = payload[config.firebaseKey];
                    const numericValue = updateMetricDisplay(metric, rawValue, payloadTimestamp);
                    const alarmInfo    = evaluateMetricThreshold(metric, numericValue);
                    setMetricAlertState(metric, alarmInfo, numericValue);
                    if (alarmInfo) triggeredAlarms.push(alarmInfo);
                });
                renderAlarmBanner(triggeredAlarms, payloadTimestamp);
            }
        }, (error) => {
            console.error(`Failed to read live data for ${tankId} (${TANKS[tankId]}):`, error);
        });
    });
}

const IOT_OFFLINE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

function recomputeAggregateState() {
    const known      = Object.values(tankState);
    const alertTanks = known.filter((t) => t.isAlert);
    updateViewTanksCard(alertTanks.length > 0, alertTanks.length);
    handleAlarmSound(alertTanks.length > 0);
}

/* =========================================
   VIEW TANKS CARD
========================================= */

function updateViewTanksCard(isAlert, alertCount) {
    const card     = document.getElementById("viewTanksCard");
    const icon     = document.getElementById("viewTanksIcon");
    const glyph    = document.getElementById("viewTanksIconGlyph");
    const title    = document.getElementById("viewTanksTitle");
    const subtitle = document.getElementById("viewTanksSubtitle");

    if (!card) return;

    if (isAlert) {
        card.className    = "view-tanks-card red";
        icon.className    = "card-icon";
        glyph.className   = "fa-solid fa-circle-exclamation";
        title.textContent = alertCount > 1 ? `${alertCount} Tanks in Alert` : "Attention Required";
        subtitle.textContent = "One or more tanks exceeded safe thresholds";
    } else {
        card.className    = "view-tanks-card green";
        icon.className    = "card-icon";
        glyph.className   = "fa-solid fa-check";
        title.textContent = "All Tanks Normal";
        subtitle.textContent = "All tanks within safe thresholds";
    }
}

/* =========================================
   PER-TANK CONNECTION BADGE
   Expects an element with id "<tankId>-connection",
   e.g. "tank1-connection", "tank2-connection".
========================================= */

function renderTankConnection(tankId, isOnline) {
    const cell = document.getElementById(`${tankId}-connection`);
    if (!cell) return;
    cell.innerHTML = isOnline
        ? `<span class="connection-badge online"><i class="fa-solid fa-circle-dot"></i> Online</span>`
        : `<span class="connection-badge offline"><i class="fa-solid fa-circle-xmark"></i> Offline</span>`;
}

/* =========================================
   PER-TANK ROWS — modal table + selection card
   Expects ids following the "<tankId>-*" / "card-<tankId>-*"
   pattern (see HTML checklist notes).
========================================= */

function renderTankRows(tankId, payload, tsDate) {
    const temp     = payload ? parseNumericValue(payload.water_temp) : NaN;
    const ph       = payload ? parseNumericValue(payload.ph_level)   : NaN;
    const humidity = payload ? parseNumericValue(payload.humidity)   : NaN;

    const timestamp = tsDate ? tsDate.toLocaleString([], {
        month: "short", day: "numeric", year: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
    }) : "--";
    const timeString = tsDate ? tsDate.toLocaleTimeString([], {
        hour: "2-digit", minute: "2-digit", second: "2-digit"
    }) : "--";

    const isAlert = isTankAlert(temp, ph);

    const statusHTML = isAlert
        ? `<span class="status alert"><i class="fa-solid fa-circle-exclamation"></i> Threshold Alert</span>`
        : `<span class="status good"><i class="fa-solid fa-check"></i> Threshold Normal</span>`;

    // Modal table row
    const tempEl   = document.getElementById(`${tankId}-temp`);
    const phEl     = document.getElementById(`${tankId}-ph`);
    const humEl    = document.getElementById(`${tankId}-humidity`);
    const statusEl = document.getElementById(`${tankId}-status`);
    const timeEl   = document.getElementById(`${tankId}-time`);

    if (tempEl)   tempEl.innerHTML   = `<i class="fa-solid fa-temperature-half"></i> ${Number.isNaN(temp)    ? "--" : temp.toFixed(1)    + "°C"}`;
    if (phEl)     phEl.innerHTML     = `<i class="fa-solid fa-droplet"></i> ${Number.isNaN(ph)       ? "--" : ph.toFixed(2)}`;
    if (humEl)    humEl.innerHTML    = `<i class="fa-solid fa-cloud"></i> ${Number.isNaN(humidity)   ? "--" : humidity.toFixed(1)  + "%"}`;
    if (statusEl) statusEl.innerHTML = statusHTML;
    if (timeEl)   timeEl.textContent = timestamp;

    // Selection screen card
    const tempCard = document.getElementById(`card-${tankId}-temp`);
    const phCard   = document.getElementById(`card-${tankId}-ph`);
    const humCard  = document.getElementById(`card-${tankId}-hum`);
    const timeCard = document.getElementById(`card-${tankId}-time`);
    const card     = document.getElementById(`select-${tankId}`);
    const status   = document.getElementById(`${tankId}-selection-status`);

    if (tempCard) tempCard.innerHTML = `<i class="fa-solid fa-temperature-half" style="color:#0ea5e9;"></i> ${Number.isNaN(temp) ? "--" : temp.toFixed(1) + "°C"}`;
    if (phCard)   phCard.innerHTML   = `<i class="fa-solid fa-droplet" style="color:#10b981;"></i> ${Number.isNaN(ph) ? "--" : ph.toFixed(2)}`;
    if (humCard)  humCard.innerHTML  = `<i class="fa-solid fa-cloud" style="color:#f97316;"></i> ${Number.isNaN(humidity) ? "--" : humidity.toFixed(1) + "%"}`;
    if (timeCard) timeCard.textContent = timeString;

    if (card && status) {
        if (isAlert) {
            card.style.borderColor = "#ef4444";
            status.className       = "status alert";
            status.innerHTML       = `<i class="fa-solid fa-circle-exclamation"></i> THRESHOLD ALERT`;
        } else {
            card.style.borderColor = "#10b981";
            status.className       = "status good";
            status.innerHTML       = `<i class="fa-solid fa-check"></i> ONLINE`;
        }
    }
}

/* =========================================
   LIVE CHARTS (trends panel — shows whichever
   tank is currently open)
========================================= */

function initLiveCharts() {
    if (typeof Chart === "undefined") { console.warn("Chart.js not available."); return; }

    Object.entries(metricConfigs).forEach(([metric, config]) => {
        const canvas = document.getElementById(config.chartId);
        if (!canvas) return;

        const decimals = typeof config.decimals === "number" ? config.decimals : 2;

        liveCharts[metric] = new Chart(canvas, {
            type: "line",
            data: {
                labels  : [],
                datasets: [{
                    label               : config.label,
                    data                : [],
                    borderColor         : config.color,
                    backgroundColor     : `${config.color}33`,
                    borderWidth         : 2,
                    tension             : 0.35,
                    fill                : true,
                    pointRadius         : 3,
                    pointBackgroundColor: "#ffffff"
                }]
            },
            options: {
                responsive         : true,
                maintainAspectRatio: false,
                animation          : { duration: 0 },
                scales: {
                    x: { ticks: { color: "#475569" }, grid: { display: false } },
                    y: {
                        ticks      : { color: "#475569" },
                        beginAtZero: metric === "humidity",
                        grid       : { color: "rgba(148,163,184,0.2)" }
                    }
                },
                plugins: {
                    legend : { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const v = ctx.parsed.y;
                                if (typeof v !== "number" || Number.isNaN(v)) return "";
                                return `${v.toFixed(decimals)}${config.unit ? ` ${config.unit}` : ""}`;
                            }
                        }
                    }
                }
            }
        });
    });
}

function resetLiveCharts() {
    Object.values(liveCharts).forEach((chart) => {
        chart.data.labels = [];
        chart.data.datasets[0].data = [];
        chart.update("none");
    });
}

/* =========================================
   UPDATE METRIC DISPLAY (trends panel)
========================================= */

function updateMetricDisplay(metric, rawValue, lastUpdatedMeta) {
    const config = metricConfigs[metric];
    if (!config) return Number.NaN;

    if (rawValue === null || typeof rawValue === "undefined") {
        setTextContent(config.valueElement,    "--");
        setTextContent(config.timestampElement, "Awaiting data");
        return Number.NaN;
    }

    const effectiveTimestamp = lastUpdatedMeta ?? Date.now();

    setTextContent(config.valueElement,    formatDisplayValue(config, rawValue));
    setTextContent(config.timestampElement, `Updated ${formatTimestamp(effectiveTimestamp)}`);

    const numericValue = parseNumericValue(rawValue);
    if (!Number.isNaN(numericValue)) addLiveChartPoint(metric, numericValue);
    return numericValue;
}

function showNoDataMessage(message = "No live data available.") {
    Object.entries(metricConfigs).forEach(([metric, config]) => {
        setTextContent(config.valueElement,    "--");
        setTextContent(config.timestampElement, message);
    });
    resetLiveCharts();
}

function addLiveChartPoint(metric, value) {
    const chart = liveCharts[metric];
    if (!chart) return;
    const timestamp = formatTimestamp(Date.now(), true);
    chart.data.labels.push(timestamp);
    chart.data.datasets[0].data.push(value);
    if (chart.data.labels.length > MAX_LIVE_POINTS) { chart.data.labels.shift(); chart.data.datasets[0].data.shift(); }
    chart.update("none");
}

/* =========================================
   THRESHOLD + ALERT STATE (trends panel metric cards)
========================================= */

function evaluateMetricThreshold(metric, numericValue) {
    const config = metricConfigs[metric];
    const check  = metricThresholdChecks[metric];
    if (!config || !check) return null;
    return check(numericValue, config);
}

function setMetricAlertState(metric, alarmInfo, numericValue) {
    const config = metricConfigs[metric];
    if (!config) return;
    const valueElement = document.getElementById(config.valueElement);
    if (!valueElement) return;
    const card = valueElement.closest(".metric-value-card");
    if (!card) return;
    card.classList.remove("alarm", "optimal");
    if (Number.isNaN(numericValue)) return;
    if (alarmInfo) card.classList.add("alarm"); else card.classList.add("optimal");
}

/* =========================================
   ALARM BANNER (trends panel — current tank only)
========================================= */

function renderAlarmBanner(alarms, payloadTimestamp) {
    const banner      = document.getElementById("alarmBanner");
    const list        = document.getElementById("alarmMessages");
    const timestampEl = document.getElementById("alarmTimestamp");
    if (!banner || !list) return;

    if (!alarms || alarms.length === 0) {
        list.innerHTML = "";
        if (timestampEl) timestampEl.textContent = "All readings are within safe thresholds.";
        banner.hidden = true;
        return;
    }

    list.innerHTML = "";
    alarms.forEach((alarm) => {
        const item = document.createElement("li");
        item.textContent = alarm.message;
        list.appendChild(item);
    });

    if (timestampEl) {
        const src = payloadTimestamp ?? Date.now();
        timestampEl.textContent = `Last updated ${formatTimestamp(src)}`;
    }
    banner.hidden = false;
}

/* =========================================
   HISTORY — DOM INJECTION
   (shared panel — reloaded per selected tank)
========================================= */

const historyMeta = {
    temperature: { containerId: "temp",     title: "Temperature History", icon: "fa-temperature-half", chartId: "tempHistoryChart",     tableId: "tempHistoryTable",     badgeId: "tempHistoryBadge",     color: "#0f766e", unit: "°C", decimals: 1, firebaseKey: "water_temp" },
    ph:          { containerId: "ph",       title: "pH Level History",    icon: "fa-droplet",          chartId: "phHistoryChart",       tableId: "phHistoryTable",       badgeId: "phHistoryBadge",       color: "#0f766e", unit: "",   decimals: 2, firebaseKey: "ph_level"  },
    humidity:    { containerId: "humidity", title: "Humidity History",    icon: "fa-cloud",            chartId: "humidityHistoryChart", tableId: "humidityHistoryTable", badgeId: "humidityHistoryBadge", color: "#0f766e", unit: "%",  decimals: 1, firebaseKey: "humidity"  }
};

function injectHistorySections() {
    Object.values(historyMeta).forEach((m) => {
        const parent = document.getElementById(m.containerId);
        if (!parent) return;

        const section     = document.createElement("div");
        section.className = "history-section";
        section.id        = `${m.containerId}-history-section`;

        section.innerHTML = `
            <div class="history-section-header">
                <span class="history-section-title">
                    <i class="fa-solid ${m.icon}"></i> ${m.title}
                    <span class="history-range-label">· Last 7 Days</span>
                </span>
                <span class="history-badge badge-loading" id="${m.badgeId}">
                    <i class="fa-solid fa-spinner fa-spin"></i> Loading…
                </span>
            </div>
            <div class="history-chart-wrapper">
                <canvas id="${m.chartId}" aria-label="${m.title} chart"></canvas>
            </div>
            <div class="history-table-scroll">
                <table class="history-table">
                    <thead>
                        <tr>
                            <th class="history-row-num">#</th>
                            <th><i class="fa-solid fa-calendar-day"></i> Date</th>
                            <th><i class="fa-solid fa-clock"></i> Time</th>
                            <th><i class="fa-solid ${m.icon}"></i> Reading</th>
                            <th><i class="fa-solid fa-circle-dot"></i> Status</th>
                        </tr>
                    </thead>
                    <tbody id="${m.tableId}">
                        <tr><td colspan="5" class="history-empty"><i class="fa-solid fa-spinner fa-spin"></i> Loading history…</td></tr>
                    </tbody>
                </table>
            </div>`;

        parent.appendChild(section);
    });
}

/* =========================================
   HISTORY — LOAD FROM FIREBASE (per tank)
========================================= */

async function loadAllHistory(tankId) {
    if (!tankId) return;

    Object.values(historyMeta).forEach((m) => setBadge(m.badgeId, "loading", "Loading…"));

    const cutoff   = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
    const snapshot = await get(
        query(ref(database, logsPathFor(tankId)), orderByKey(), limitToLast(1000))
    ).catch((err) => { console.error(`History fetch failed for ${tankId}:`, err); return null; });

    // Bail out silently if the user switched tanks while this was loading
    if (tankId !== currentTankId) return;

    if (!snapshot || !snapshot.exists()) {
        Object.values(historyMeta).forEach((m) => setBadge(m.badgeId, "empty", "No data"));
        Object.values(historyCharts).forEach((chart) => chart && chart.destroy());
        Object.entries(historyMeta).forEach(([, m]) => renderHistoryTable(m, []));
        return;
    }

    const allRows = [];
    snapshot.forEach((child) => {
        const val = child.val();
        if (!val) return;
        const ts = normalizeTimestampValue(extractTimestampFromPayload(val) ?? Date.now());
        if (ts.getTime() < cutoff) return;
        allRows.push({ ts, val });
    });

    allRows.sort((a, b) => a.ts - b.ts);

    // Deduplicate — keep only one entry per unique timestamp, cap at 500
    const seen       = new Set();
    const uniqueRows = allRows.filter(r => {
        const key = r.ts.getTime();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(-500); // keep the most recent 500 unique entries

    Object.entries(historyMeta).forEach(([, m]) => {
        const rows = uniqueRows
            .map((r) => ({ ts: r.ts, value: parseNumericValue(r.val[m.firebaseKey]) }))
            .filter((r) => !Number.isNaN(r.value));

        renderHistoryChart(m, rows);
        renderHistoryTable(m, rows);
        setBadge(m.badgeId, rows.length ? "ok" : "empty", rows.length ? `${rows.length} latest records` : "No data");
    });
}

/* =========================================
   HISTORY CHART
========================================= */

function renderHistoryChart(m, rows) {
    const canvas = document.getElementById(m.chartId);
    if (!canvas || typeof Chart === "undefined") return;

    const sampled  = subsample(rows, MAX_HISTORY_POINTS);
    const decimals = m.decimals ?? 1;

    if (historyCharts[m.chartId]) {
        historyCharts[m.chartId].destroy();
        historyCharts[m.chartId] = null;
    }

    historyCharts[m.chartId] = new Chart(canvas, {
        type: "line",
        data: {
            labels  : sampled.map((r) => formatTimestamp(r.ts, true)),
            datasets: [{
                label               : m.title,
                data                : sampled.map((r) => r.value),
                borderColor         : m.color,
                backgroundColor     : `${m.color}22`,
                borderWidth         : 1.5,
                tension             : 0.35,
                fill                : true,
                pointRadius         : sampled.length > 30 ? 1 : 3,
                pointBackgroundColor: "#ffffff"
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
            scales: {
                x: { ticks: { color: "#94a3b8", maxRotation: 45, autoSkip: true, maxTicksLimit: 10 }, grid: { display: false } },
                y: { ticks: { color: "#94a3b8" }, beginAtZero: m.firebaseKey === "humidity", grid: { color: "rgba(148,163,184,0.15)" } }
            },
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y.toFixed(decimals)}${m.unit ? ` ${m.unit}` : ""}` } } }
        }
    });
}

/* =========================================
   HISTORY TABLE
========================================= */

function renderHistoryTable(m, rows) {
    const tbody = document.getElementById(m.tableId);
    if (!tbody) return;

    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="history-empty">No records found for the last 7 days.</td></tr>`;
        return;
    }

    const decimals = m.decimals ?? 1;
    tbody.innerHTML = [...rows].reverse().map((r, idx) => {
        const date    = r.ts.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
        const time    = r.ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const reading = `${r.value.toFixed(decimals)}${m.unit ? ` ${m.unit}` : ""}`;
        return `
        <tr>
            <td class="history-row-num">${idx + 1}</td>
            <td class="history-row-time">${date}</td>
            <td class="history-row-time">${time}</td>
            <td class="history-row-value">${reading}</td>
            <td>${getRowStatus(m.firebaseKey, r.value)}</td>
        </tr>`;
    }).join("");
}

function getRowStatus(firebaseKey, value) {
    let isAlert = false;
    if (firebaseKey === "water_temp") isAlert = value < 0 || value > 4;
    else if (firebaseKey === "ph_level") isAlert = value < 6.5 || value > 7.5;
    return isAlert
        ? `<span class="history-status-badge alert-badge"><i class="fa-solid fa-circle-exclamation"></i> Alert</span>`
        : `<span class="history-status-badge ok-badge"><i class="fa-solid fa-check"></i> Optimal</span>`;
}

/* =========================================
   BADGE / SUBSAMPLE / HELPERS
========================================= */

function setBadge(id, type, text) {
    const el = document.getElementById(id);
    if (!el) return;
    const classes = { loading: "badge-loading", ok: "badge-ok", empty: "badge-empty", error: "badge-error" };
    const icons   = { loading: `<i class="fa-solid fa-spinner fa-spin"></i>`, ok: `<i class="fa-solid fa-check-circle"></i>`, empty: `<i class="fa-solid fa-inbox"></i>`, error: `<i class="fa-solid fa-triangle-exclamation"></i>` };
    el.className  = `history-badge ${classes[type] || "badge-empty"}`;
    el.innerHTML  = `${icons[type] || ""} ${text}`;
}

function subsample(arr, maxPoints) {
    if (arr.length <= maxPoints) return arr;
    const step = arr.length / maxPoints;
    return Array.from({ length: maxPoints }, (_, i) => arr[Math.round(i * step)]);
}

function formatValueForAlert(value, config) {
    if (typeof value !== "number" || Number.isNaN(value)) return "--";
    const formatted = value.toFixed(typeof config.decimals === "number" ? config.decimals : 2);
    return config.unit ? `${formatted} ${config.unit}` : formatted;
}

function formatDisplayValue(config, rawValue) {
    if (typeof rawValue === "string" && rawValue.trim().length) return rawValue;
    const n = Number(rawValue);
    if (Number.isNaN(n)) return "--";
    const formatted = n.toFixed(typeof config.decimals === "number" ? config.decimals : 1);
    return config.unit ? `${formatted} ${config.unit}` : formatted;
}

function parseNumericValue(value) {
    if (typeof value === "number") return value;
    if (typeof value === "string") { const m = value.match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : Number.NaN; }
    return Number.NaN;
}

function formatTimestamp(value, short = false) {
    const date = normalizeTimestampValue(value);
    return date.toLocaleTimeString([], short
        ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
        : { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function setTextContent(elementId, text) {
    const el = document.getElementById(elementId);
    if (el) el.textContent = text;
}

function extractTimestampFromPayload(payload) {
    if (!payload || typeof payload !== "object") return null;
    for (const field of ["timestamp","Timestamp","createdAt","created_at","updatedAt","updated_at","time","loggedAt","logged_at"]) {
        if (payload[field]) return payload[field];
    }
    return null;
}

function normalizeTimestampValue(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === "number") {
        const d = new Date(value < 1e12 ? value * 1000 : value);
        if (!Number.isNaN(d.getTime())) return d;
    }
    if (typeof value === "string") {
        const n = Number(value);
        if (!Number.isNaN(n)) return normalizeTimestampValue(n);
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d;
    }
    console.warn("normalizeTimestampValue: unrecognized value, defaulting to now ->", value);
    return new Date();
}

/* =========================================
   FRESHNESS TRENDS (Firestore, global — not tied
   to a specific tank/device)
========================================= */

let freshnessStackedChart = null;

async function loadFreshnessTrends() {
    if (typeof Chart === "undefined") return;

    try {
        const snap = await getDocs(fsQuery(
            inspectionsCol,
            orderBy("createdAt", "asc")
        ));

        const dayLabels = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            dayLabels.push(d.toLocaleDateString([], { month: "short", day: "numeric" }));
        }

        const dailyPassed   = new Array(7).fill(0);
        const dailyIssues   = new Array(7).fill(0);
        const dailyRejected = new Array(7).fill(0);

        let totalPassed = 0, totalIssues = 0, totalRejected = 0;

        const today  = new Date();
        today.setHours(23, 59, 59, 999);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 6);
        cutoff.setHours(0, 0, 0, 0);

        if (!snap.empty) {
            snap.forEach(docSnap => {
            const data   = docSnap.data();
            const status = data.overallStatus || "";

            const ts = data.createdAt?.toDate ? data.createdAt.toDate() : null;
            if (!ts || ts < cutoff || ts > today) return;   // restrict to last 7 days only

            const diffDays = Math.floor((today - ts) / (1000 * 60 * 60 * 24));
            const idx      = 6 - diffDays;
            if (idx < 0 || idx > 6) return;

            if (status === "Passed")           { totalPassed++;   dailyPassed[idx]++;   }
            else if (status === "With Issues") { totalIssues++;   dailyIssues[idx]++;   }
            else if (status === "Rejected")    { totalRejected++; dailyRejected[idx]++; }
            });
        }

        const total = (totalPassed + totalIssues + totalRejected) || 1;
        const pct   = (n) => Math.round((n / total) * 100) + "%";

        const freshEl    = document.getElementById("fresh-pct");
        const moderateEl = document.getElementById("moderate-pct");
        const spoiledEl  = document.getElementById("spoiled-pct");
        if (freshEl)    freshEl.textContent    = pct(totalPassed);
        if (moderateEl) moderateEl.textContent = pct(totalIssues);
        if (spoiledEl)  spoiledEl.textContent  = pct(totalRejected);

        const canvas = document.getElementById("freshnessStackedChart");
        if (!canvas) return;

        if (freshnessStackedChart) {
            freshnessStackedChart.destroy();
            freshnessStackedChart = null;
        }

        freshnessStackedChart = new Chart(canvas, {
            type: "bar",
            data: {
                labels: dayLabels,
                datasets: [
                    {
                        label          : "Fresh (Passed)",
                        data           : dailyPassed,
                        backgroundColor: "#86efac",
                        borderColor    : "#16a34a",
                        borderWidth    : 1.5,
                        borderRadius   : { topLeft: 0, topRight: 0, bottomLeft: 4, bottomRight: 4 },
                        borderSkipped  : "bottom"
                    },
                    {
                        label          : "With Issues",
                        data           : dailyIssues,
                        backgroundColor: "#fde047",
                        borderColor    : "#ca8a04",
                        borderWidth    : 1.5,
                        borderRadius   : 0,
                        borderSkipped  : false
                    },
                    {
                        label          : "Rejected",
                        data           : dailyRejected,
                        backgroundColor: "#fca5a5",
                        borderColor    : "#dc2626",
                        borderWidth    : 1.5,
                        borderRadius   : { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
                        borderSkipped  : "bottom"
                    }
                ]
            },
            options: {
                responsive         : true,
                maintainAspectRatio: false,
                animation          : { duration: 400 },
                scales: {
                    x: {
                        stacked: true,
                        ticks  : { color: "#475569", font: { size: 11 } },
                        grid   : { display: false }
                    },
                    y: {
                        stacked    : true,
                        beginAtZero: true,
                        ticks      : { color: "#475569", stepSize: 1, precision: 0 },
                        grid       : { color: "rgba(148,163,184,0.15)" }
                    }
                },
                plugins: {
                    legend: {
                        display : true,
                        position: "top",
                        labels  : {
                            usePointStyle: true,
                            pointStyle   : "rectRounded",
                            color        : "#475569",
                            font         : { size: 12 }
                        }
                    },
                    tooltip: {
                        mode     : "index",
                        intersect: false,
                        callbacks: {
                            label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y} inspection${ctx.parsed.y !== 1 ? "s" : ""}`
                        }
                    }
                }
            }
        });

    } catch (err) {
        console.error("Freshness trends error:", err);
    }
}

/* =========================================
   DELIVERY PERFORMANCE TRENDS (Firestore, global)
   REVISION: switched from a line chart to a stacked
   bar chart — the crossing lines looked like a confusing "bell curve" 
   for what is really daily count data (on-time vs late deliveries).
   Style now matches the Freshness Trends bar chart
   above it for visual consistency.
========================================= */

let deliveryPerformanceChart = null;

async function loadDeliveryPerformance() {
    if (typeof Chart === "undefined") return;

    try {
        const snap = await getDocs(fsQuery(
            deliveriesCol,
            orderBy("createdAt", "asc")
        ));

        const dayLabels = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            dayLabels.push(d.toLocaleDateString([], { month: "short", day: "numeric" }));
        }

        const today  = new Date();
        today.setHours(23, 59, 59, 999);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 6);
        cutoff.setHours(0, 0, 0, 0);

        const dailyOnTime = new Array(7).fill(0);
        const dailyLate   = new Array(7).fill(0);

        let totalDelivered = 0;
        let totalOnTime    = 0;
        let totalLate      = 0;
        let totalDelayMins = 0;
        let delayCount     = 0;

        if (!snap.empty) {
            snap.forEach(docSnap => {
                const d = docSnap.data();

                if (d.status !== "delivered" && d.status !== "received") return;
                if (!d.deliveredAt || !d.eta) return;

                const etaMs       = new Date(d.eta).getTime();
                const deliveredMs = d.deliveredAt.toDate
                    ? d.deliveredAt.toDate().getTime()
                    : new Date(d.deliveredAt).getTime();

                if (isNaN(etaMs) || isNaN(deliveredMs)) return;

                const deliveredDate = d.deliveredAt.toDate ? d.deliveredAt.toDate() : new Date(d.deliveredAt);
                if (deliveredDate < cutoff || deliveredDate > today) return;   // restrict to last 7 days only

                totalDelivered++;

                const GRACE_MS   = 20 * 60 * 1000;
                const isLate     = deliveredMs > etaMs + GRACE_MS;
                const delayMins  = Math.round((deliveredMs - etaMs - GRACE_MS) / 60000);

                if (isLate) {
                    totalLate++;
                    if (delayMins > 0) {
                        totalDelayMins += delayMins;
                        delayCount++;
                    }
                } else {
                    totalOnTime++;
                }

                const diffDays = Math.floor((today - deliveredDate) / (1000 * 60 * 60 * 24));
                const idx      = 6 - diffDays;
                if (idx < 0 || idx > 6) return;

                if (isLate) dailyLate[idx]++;
                else        dailyOnTime[idx]++;
                            });
                        }

        // TEMP DEBUG — remove once bad test data is cleaned up
        // const debugDelays = [];
        // snap.forEach(docSnap => {
        //    const d = docSnap.data();
        //    if (d.status !== "delivered" && d.status !== "received") return;
        //    if (!d.deliveredAt || !d.eta) return;
        //    const etaMs       = new Date(d.eta).getTime();
        //    const deliveredMs = d.deliveredAt.toDate ? d.deliveredAt.toDate().getTime() : new Date(d.deliveredAt).getTime();
        //    if (isNaN(etaMs) || isNaN(deliveredMs)) return;
        //    const delayMins = Math.round((deliveredMs - etaMs) / 60000);
        //    debugDelays.push({ id: docSnap.id, eta: d.eta, deliveredAt: deliveredMs ? new Date(deliveredMs).toString() : null, delayMins });
        //});
        //debugDelays.sort((a, b) => b.delayMins - a.delayMins);
        //console.table(debugDelays.slice(0, 10)); // top 10 worst offenders

        const onTimePct    = totalDelivered > 0 ? Math.round((totalOnTime / totalDelivered) * 100) : 0;
        const avgDelayMins = delayCount > 0 ? Math.round(totalDelayMins / delayCount) : 0;

        const ontimeEl = document.getElementById("delivery-ontime-pct");
        const lateEl   = document.getElementById("delivery-late-count");

        if (ontimeEl) ontimeEl.textContent = `${onTimePct}%`;
        if (lateEl)   lateEl.textContent   = `${totalLate}`;

        // REVISION: avg delay is now stored raw and rendered through
        // renderAvgDelay() so the user's chosen format (minutes vs h/m)
        // is respected without needing to refetch from Firestore.
        lastAvgDelayMins = avgDelayMins;
        renderAvgDelay();

        const canvas = document.getElementById("deliveryPerformanceChart");
        if (!canvas) return;

        if (deliveryPerformanceChart) {
            deliveryPerformanceChart.destroy();
            deliveryPerformanceChart = null;
        }

        deliveryPerformanceChart = new Chart(canvas, {
            type: "bar",
            data: {
                labels  : dayLabels,
                datasets: [
                    {
                        label          : "On-Time",
                        data           : dailyOnTime,
                        backgroundColor: "#86efac",
                        borderColor    : "#16a34a",
                        borderWidth    : 1.5,
                        borderRadius   : { topLeft: 0, topRight: 0, bottomLeft: 4, bottomRight: 4 },
                        borderSkipped  : "bottom"
                    },
                    {
                        label          : "Late / Delayed",
                        data           : dailyLate,
                        backgroundColor: "#fca5a5",
                        borderColor    : "#dc2626",
                        borderWidth    : 1.5,
                        borderRadius   : { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
                        borderSkipped  : "bottom"
                    }
                ]
            },
            options: {
                responsive         : true,
                maintainAspectRatio: false,
                animation          : { duration: 400 },
                scales: {
                    x: {
                        stacked: true,
                        ticks  : { color: "#475569", font: { size: 11 } },
                        grid   : { display: false }
                    },
                    y: {
                        stacked    : true,
                        beginAtZero: true,
                        ticks      : { color: "#475569", stepSize: 1, precision: 0 },
                        grid       : { color: "rgba(148,163,184,0.15)" }
                    }
                },
                plugins: {
                    legend: {
                        display : true,
                        position: "top",
                        labels  : {
                            usePointStyle: true,
                            pointStyle   : "rectRounded",
                            color        : "#475569",
                            font         : { size: 12 }
                        }
                    },
                    tooltip: {
                        mode     : "index",
                        intersect: false,
                        callbacks: {
                            label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y} deliver${ctx.parsed.y !== 1 ? "ies" : "y"}`
                        }
                    }
                }
            }
        });

    } catch (err) {
        console.error("Delivery performance error:", err);
    }
}

/* =========================================
   AVG DELAY FORMAT TOGGLE (revision)
   Lets the employee switch the Avg Delay card
   between plain minutes and "1h 30m" style,
   instead of always showing a large raw minute
   count that's hard to mentally convert.
========================================= */

function formatDelayMinutes(totalMins, asHoursMinutes) {
    if (!totalMins || totalMins <= 0) {
        return asHoursMinutes ? { value: "0m", unit: "no delay" } : { value: "0", unit: "minutes late" };
    }
    if (!asHoursMinutes) {
        return { value: `${totalMins}`, unit: "minutes late" };
    }
    const hours = Math.floor(totalMins / 60);
    const mins  = totalMins % 60;
    const value = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    return { value, unit: "average delay" };
}

function renderAvgDelay() {
    const { value, unit } = formatDelayMinutes(lastAvgDelayMins, delayFormatIsHM);
    const valueEl = document.getElementById("delivery-avg-delay");
    const unitEl  = document.getElementById("delivery-avg-delay-unit");
    if (valueEl) valueEl.textContent = value;
    if (unitEl)  unitEl.textContent  = unit;
}

function initDelayFormatToggle() {
    const toggleBtn = document.getElementById("delayFormatToggle");
    const toggleLbl = document.getElementById("delayFormatLabel");
    if (!toggleBtn) return; // HTML not updated yet — safe no-op
    toggleBtn.addEventListener("click", () => {
        delayFormatIsHM = !delayFormatIsHM;
        if (toggleLbl) toggleLbl.textContent = delayFormatIsHM ? "Show as minutes" : "Show as h/m";
        renderAvgDelay();
    });
}

/* =========================================
   TANK SELECTION & DYNAMIC UI
========================================= */

window.selectTank = function(tankId) {
    if (!TANKS[tankId]) {
        console.warn(`selectTank: unknown tankId "${tankId}". Known tanks:`, Object.keys(TANKS));
        return;
    }

    currentTankId = tankId;

    document.getElementById("selectionPanel").style.display = "none";
    const trends = document.getElementById("trendsPanelSection");
    trends.style.display = "block";
    trends.scrollIntoView({ behavior: "smooth" });

    resetLiveCharts();
    showNoDataMessage("Loading live data…");
    loadAllHistory(tankId);

    Object.values(liveCharts).forEach(chart => chart.resize());
    if (freshnessStackedChart)    freshnessStackedChart.resize();
    if (deliveryPerformanceChart) deliveryPerformanceChart.resize();
};

window.backToSelection = function() {
    currentTankId = null;
    document.getElementById("selectionPanel").style.display = "block";
    document.getElementById("trendsPanelSection").style.display = "none";
};