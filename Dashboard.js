import { db } from "./firebase.js";
import {
  collection, onSnapshot, getDocs, query, where
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

let batchesMap = {};

document.addEventListener("DOMContentLoaded", async () => {
    setupTabs();
    await loadBatches();
    try { listenToRecentActivity(); } catch (e) { console.error(e); }
    try { listenToQualityControl(); } catch (e) { console.error(e); }
    try { listenToTransport(); } catch (e) { console.error(e); }
});

async function loadBatches() {
    try {
        const snap = await getDocs(collection(db, "inspections"));
        snap.forEach(docSnap => {
            const b = docSnap.data();
            batchesMap[docSnap.id] = b.batchCode || docSnap.id;
        });
    } catch (e) { console.error("Failed to load batches dictionary", e); }
}

function setupTabs() {
    // Tab switching handled inline in Dashboard.html
}

function getStatusBadgeHTML(statusStr) {
    if (!statusStr) return "";
    let norm = statusStr.toLowerCase().replace(/_/g, ' ');
    let colorClass = 'status-default';
    if (norm.includes('pending'))                                    colorClass = 'status-pending';
    else if (norm.includes('route'))                                 colorClass = 'status-enroute';
    else if (norm.includes('delivered') || norm.includes('passed')) colorClass = 'status-success';
    else if (norm.includes('received'))                              colorClass = 'status-received';
    else if (norm.includes('delayed')   || norm.includes('rejected')) colorClass = 'status-danger';
    else if (norm.includes('issue'))                                 colorClass = 'status-warning';
    const displayStr = statusStr.replace("_", " ");
    return `<div class="status-pill ${colorClass}"><span class="status-dot"></span><span>${displayStr}</span></div>`;
}

let allActivities = [];

function renderActivities() {
    const tbody        = document.getElementById("recent-activity-body");
    const search       = (document.getElementById("recent-search")?.value        || "").toLowerCase();
    const moduleFilter =  document.getElementById("recent-filter-module")?.value || "";
    const statusFilter =  document.getElementById("recent-sort-status")?.value   || "";
    const sortDir      =  document.getElementById("recent-sort-date")?.value     || "desc";

    let filtered = allActivities.filter(a => {
        // Search filter
        const matchSearch = !search ||
            a.module.toLowerCase().includes(search) ||
            a.detail.toLowerCase().includes(search);

        // Module filter — "qc" matches inspection type, "transport" matches delivery type
        const matchModule = !moduleFilter ||
            (moduleFilter === "qc"        && a.type === "inspection") ||
            (moduleFilter === "transport" && a.type === "delivery" && a.module !== "Customer") ||
            (moduleFilter === "customer"  && a.module === "Customer");

        // Status filter
        const matchStatus = !statusFilter ||
            (a.status || "").toLowerCase() === statusFilter.toLowerCase();

        return matchSearch && matchModule && matchStatus;
    });

    filtered.sort((a, b) => sortDir === "asc" ? a.time - b.time : b.time - a.time);

    tbody.innerHTML = "";
    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-center empty-row">No matching activity.</td></tr>`;
        return;
    }
    filtered.slice(0, 20).forEach(act => {
        const tr = document.createElement('tr');
        tr.onclick = () => { window.location.href = act.link; };
        tr.innerHTML = `
            <td>${act.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
            <td><strong>${act.module}</strong></td>
            <td>${act.detail}</td>
            <td>${getStatusBadgeHTML(act.status)}</td>
        `;
        tbody.appendChild(tr);
    });
}

function listenToRecentActivity() {
    // Bind all filter/sort controls including the new module filter
    ["recent-search", "recent-filter-module", "recent-sort-status", "recent-sort-date"].forEach(id => {
        document.getElementById(id)?.addEventListener("input",  renderActivities);
        document.getElementById(id)?.addEventListener("change", renderActivities);
    });

    onSnapshot(collection(db, "inspections"), (snap) => {
        allActivities = allActivities.filter(a => a.type !== "inspection");
        snap.forEach(doc => {
            const d = doc.data();
            if (d.createdAt) {
                const displayBatch = batchesMap[d.batchId] || d.batchCode || d.batchId || "-";
                allActivities.push({
                    type:   "inspection",
                    time:   d.createdAt.toDate(),
                    module: "QC Inspection",
                    detail: `Batch ${displayBatch} inspected`,
                    status: d.overallStatus,
                    link:   "QualityControl.html"
                });
            }
        });
        renderActivities();
    });

        onSnapshot(collection(db, "deliveries"), (snap) => {
        allActivities = allActivities.filter(a => a.type !== "delivery");
        snap.forEach(doc => {
            const d = doc.data();
            if (d.createdAt) {
                // Transport activity — exclude received (that belongs to customer)
                if (d.status !== "received") {
                    allActivities.push({
                        type:   "delivery",
                        time:   d.createdAt.toDate(),
                        module: "Transport",
                        detail: `Delivery ${d.deliveryCode} — ${d.status?.replace("_", " ")}`,
                        status: d.status,
                        link:   "TransportDelivery.html"
                    });
                }
                // Customer receipt activity — only when received
                if (d.status === "received" && d.receivedAt) {
                    allActivities.push({
                        type:   "delivery",
                        time:   d.receivedAt.toDate(),
                        module: "Customer",
                        detail: `Delivery ${d.deliveryCode} — receipt confirmed`,
                        status: "received",
                        link:   "TransportDelivery.html"
                    });
                }
            }
        });
        renderActivities();
    });
}

let allQCDocs = [];

function buildQCRows(list, tbodyId) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center empty-row">No records.</td></tr>`;
        return;
    }
    tbody.innerHTML = "";
    list.forEach(d => {
        const displayBatch = d.batchCode || batchesMap[d.batchId] || d.batchId || "—";
        const dateStr = d.createdAt?.toDate
            ? d.createdAt.toDate().toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
            : "—";
        const modalParam = d.overallStatus === "Passed"      ? "passed"
                         : d.overallStatus === "With Issues" ? "issues"
                         : d.overallStatus === "Rejected"    ? "rejected" : "";
        const tr = document.createElement('tr');
        tr.style.cursor = "pointer";
        tr.onclick = () => { window.location.href = `QualityControl.html${modalParam ? "?modal=" + modalParam : ""}`; };
        tr.innerHTML = `
            <td><strong>${displayBatch}</strong></td>
            <td>${d.inspectorName || "—"}</td>
            <td>${d.productType   || "—"}</td>
            <td>${d.location      || "—"}</td>
            <td>${dateStr}</td>
            <td>${getStatusBadgeHTML(d.overallStatus)}</td>
        `;
        tbody.appendChild(tr);
    });
}

function renderQC() {
    const search   = (document.getElementById("qc-search")?.value         || "").toLowerCase();
    const location =  document.getElementById("qc-filter-location")?.value || "";
    const sortDir  =  document.getElementById("qc-sort-date")?.value       || "desc";

    let filtered = allQCDocs.filter(d => {
        const batch     = (d.batchCode || batchesMap[d.batchId] || d.batchId || "").toLowerCase();
        const inspector = (d.inspectorName || "").toLowerCase();
        const matchSearch   = !search   || batch.includes(search) || inspector.includes(search);
        const matchLocation = !location || d.location === location;
        return matchSearch && matchLocation;
    });

    filtered.sort((a, b) => sortDir === "asc"
        ? (a.createdAt?.toMillis() || 0) - (b.createdAt?.toMillis() || 0)
        : (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));

    const passed   = filtered.filter(d => d.overallStatus === "Passed");
    const issues   = filtered.filter(d => d.overallStatus === "With Issues");
    const rejected = filtered.filter(d => d.overallStatus === "Rejected");

    document.getElementById("dash-passed-count").textContent   = passed.length;
    document.getElementById("dash-issues-count").textContent   = issues.length;
    document.getElementById("dash-rejected-count").textContent = rejected.length;

    buildQCRows(passed,   "qc-passed-body");
    buildQCRows(issues,   "qc-issues-body");
    buildQCRows(rejected, "qc-rejected-body");
}

function listenToQualityControl() {
    ["qc-search", "qc-filter-location", "qc-sort-date"].forEach(id => {
        document.getElementById(id)?.addEventListener("input",  renderQC);
        document.getElementById(id)?.addEventListener("change", renderQC);
    });
    onSnapshot(collection(db, "inspections"), (snapshot) => {
        allQCDocs = [];
        snapshot.forEach(d => allQCDocs.push({ id: d.id, ...d.data() }));
        renderQC();
    });
}

let allDeliveryDocs = [];

function buildDeliveryRows(list, tbodyId, dateField, modalParam) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center empty-row">No records.</td></tr>`;
        return;
    }
    tbody.innerHTML = "";
    list.forEach(d => {
        const shortOrigin  = d.origin      ? d.origin.split(',')[0]      : "—";
        const shortDest    = d.destination ? d.destination.split(',')[0] : "—";
        const displayBatch = batchesMap[d.batchId] || d.batchCode || d.batchId || "—";
        const dateVal      = dateField === "deliveredAt"
            ? (d.deliveredAt?.toDate ? d.deliveredAt.toDate().toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "—")
            : (d.eta ? new Date(d.eta).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "—");
        const tr = document.createElement('tr');
        tr.style.cursor = "pointer";
        const rowModal = modalParam || (d.status === "pending" ? "pending" : d.status === "en_route" ? "enroute" : modalParam);
        tr.onclick = () => { window.location.href = `TransportDelivery.html?modal=${rowModal}`; };
        tr.innerHTML = `
            <td><strong>${d.deliveryCode}</strong></td>
            <td>${displayBatch}</td>
            <td>${d.truck       || "—"}</td>
            <td>${d.driverName  || "—"}</td>
            <td>${shortOrigin}</td>
            <td>${shortDest}</td>
            <td>${dateVal}</td>
            <td>${getStatusBadgeHTML(d.status)}</td>
        `;
        tbody.appendChild(tr);
    });
}

function renderTransport() {
    const search  = (document.getElementById("transport-search")?.value  || "").toLowerCase();
    const sortDir =  document.getElementById("transport-sort-date")?.value || "desc";

    let filtered = allDeliveryDocs.filter(d => {
        const batch  = (batchesMap[d.batchId] || d.batchCode || d.batchId || "").toLowerCase();
        const driver = (d.driverName   || "").toLowerCase();
        const code   = (d.deliveryCode || "").toLowerCase();
        return !search || batch.includes(search) || driver.includes(search) || code.includes(search);
    });

    filtered.sort((a, b) => sortDir === "asc"
        ? (a.createdAt?.toMillis() || 0) - (b.createdAt?.toMillis() || 0)
        : (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));

    const active    = filtered.filter(d => d.status === "pending" || d.status === "en_route");
    const delayed   = filtered.filter(d => d.status === "delayed");
    const delivered = filtered.filter(d => d.status === "delivered" || d.status === "received");

    document.getElementById("dash-active-count").textContent    = active.length;
    document.getElementById("dash-delayed-count").textContent   = delayed.length;
    document.getElementById("dash-delivered-count").textContent = delivered.length;

    buildDeliveryRows(active,    "transport-active-body",    "eta",         null);
    buildDeliveryRows(delayed,   "transport-delayed-body",   "eta",         "delayed");
    buildDeliveryRows(delivered, "transport-delivered-body", "deliveredAt", "delivered");
}

function listenToTransport() {
    ["transport-search", "transport-sort-date"].forEach(id => {
        document.getElementById(id)?.addEventListener("input",  renderTransport);
        document.getElementById(id)?.addEventListener("change", renderTransport);
    });
    onSnapshot(collection(db, "deliveries"), (snapshot) => {
        allDeliveryDocs = [];
        snapshot.forEach(d => allDeliveryDocs.push({ id: d.id, ...d.data() }));
        renderTransport();
    });
}