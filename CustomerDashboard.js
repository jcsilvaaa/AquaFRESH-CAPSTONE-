import { db } from "./firebase.js";
import {
    collection, query, where, onSnapshot,
    doc, updateDoc, serverTimestamp, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const deliveriesCol = collection(db, "deliveries");

let pendingConfirmId   = null;
let pendingConfirmCode = null;
let allOrders          = [];

/* =========================================
   INIT
========================================= */
document.addEventListener("DOMContentLoaded", async () => {
    const role   = localStorage.getItem("role");
    const userId = localStorage.getItem("userId");

    if (role !== "customer") {
        window.location.href = "Login.html";
        return;
    }

    // Show customer name
    if (userId) {
        try {
            const userSnap = await getDoc(doc(db, "users", userId));
            if (userSnap.exists()) {
                const name = userSnap.data().fullName || "Customer";
                const label = document.getElementById("userRoleLabel");
                if (label) label.textContent = name.split(" ")[0];
            }
        } catch (e) { console.warn("Could not load user name:", e); }
    }

    setupReceiptModal();
    listenToOrders(userId);
});

/* =========================================
   LISTEN TO ORDERS
========================================= */
function listenToOrders(userId) {
    const q = query(deliveriesCol, where("customerId", "==", userId));

    onSnapshot(q, (snapshot) => {
        allOrders = [];
        snapshot.forEach(docSnap => allOrders.push({ id: docSnap.id, ...docSnap.data() }));
        allOrders.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));

        const pending   = allOrders.filter(o => o.status === "pending");
        const enroute   = allOrders.filter(o => o.status === "en_route");
        const delayed   = allOrders.filter(o => o.status === "delayed");
        const delivered = allOrders.filter(o => o.status === "delivered");
        const received  = allOrders.filter(o => o.status === "received");
        const active    = allOrders.filter(o => ["pending", "en_route", "delayed"].includes(o.status));
        const history   = allOrders.filter(o => ["delivered", "received"].includes(o.status));

        // Update summary counts
        document.getElementById("cust-pending-count").textContent   = pending.length;
        document.getElementById("cust-enroute-count").textContent   = enroute.length;
        document.getElementById("cust-delivered-count").textContent = delivered.length + received.length;
        document.getElementById("cust-delayed-count").textContent   = delayed.length;

        // Update modal badge counts
        document.getElementById("modal-pending-count").textContent   = pending.length;
        document.getElementById("modal-enroute-count").textContent   = enroute.length;
        document.getElementById("modal-delivered-count").textContent = delivered.length + received.length;
        document.getElementById("modal-delayed-count").textContent   = delayed.length;

        // Render order cards on page
        renderOrderCards("active-orders-list",  active,  false);
        renderOrderCards("history-orders-list", history, true);

        // Render modal tables
        renderModalTable("modal-pending-body",   pending,   "pending");
        renderModalTable("modal-enroute-body",   enroute,   "en_route");
        renderModalTable("modal-delivered-body", [...delivered, ...received], "delivered");
        renderModalTable("modal-delayed-body",   delayed,   "delayed");
    });
}

/* =========================================
   RENDER ORDER CARDS (main page)
========================================= */
function renderOrderCards(containerId, orders, isHistory) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (orders.length === 0) {
        container.innerHTML = `
            <div class="cust-empty-state">
                <i class="fa-solid fa-inbox"></i>
                <p>${isHistory ? "No completed orders yet." : "No active orders right now."}</p>
            </div>`;
        return;
    }

    container.innerHTML = orders.map(o => buildOrderCard(o)).join("");
}

function buildOrderCard(order) {
    const statusLabel = {
        pending:   "Pending",
        en_route:  "On the Way",
        delayed:   "Delayed",
        delivered: "Delivered",
        received:  "Received"
    }[order.status] || order.status;

    const statusIcon = {
        pending:   "fa-clock",
        en_route:  "fa-truck",
        delayed:   "fa-triangle-exclamation",
        delivered: "fa-circle-check",
        received:  "fa-circle-check"
    }[order.status] || "fa-circle";

    const shortOrigin = order.origin      ? order.origin.split(",")[0]      : "—";
    const shortDest   = order.destination ? order.destination.split(",")[0] : "—";
    const etaStr      = order.eta
        ? new Date(order.eta).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
        : "—";

    const progressHTML = buildProgress(order.status);

    let actions = `<button class="cust-btn-details" onclick="window.openOrderDetailById('${order.id}')">
        <i class="fa-solid fa-eye"></i> View Details
    </button>`;

    if (order.status === "delivered") {
        actions += `<button class="cust-btn-receive" onclick="promptConfirmReceipt('${order.id}', '${order.deliveryCode}')">
            <i class="fa-solid fa-box-open"></i> Order Received
        </button>`;
    }
    if (order.status === "received") {
        actions += `<span class="received-badge"><i class="fa-solid fa-circle-check"></i> Receipt Confirmed</span>`;
    }

    return `
    <div class="cust-order-card status-${order.status}">
        <div class="cust-order-top">
            <div>
                <div class="cust-order-code">${order.deliveryCode || "—"}</div>
                <div class="cust-order-batch">Batch: ${order.batchCode || order.batchId || "—"}</div>
            </div>
            <span class="cust-status-pill ${order.status}">
                <i class="fa-solid ${statusIcon}"></i> ${statusLabel}
            </span>
        </div>
        ${progressHTML}
        <div class="cust-order-meta">
            <div class="cust-order-meta-item">
                <span class="cust-meta-label">From</span>
                <span class="cust-meta-val">${shortOrigin}</span>
            </div>
            <div class="cust-order-meta-item">
                <span class="cust-meta-label">To</span>
                <span class="cust-meta-val">${shortDest}</span>
            </div>
            <div class="cust-order-meta-item">
                <span class="cust-meta-label">ETA</span>
                <span class="cust-meta-val">${etaStr}</span>
            </div>
            <div class="cust-order-meta-item">
                <span class="cust-meta-label">Driver</span>
                <span class="cust-meta-val">${order.driverName || "—"}</span>
            </div>
        </div>
        <div class="cust-order-actions">${actions}</div>
    </div>`;
}

function buildProgress(status) {
    const steps = [
        { key: "pending",   label: "Placed"    },
        { key: "en_route",  label: "On the Way" },
        { key: "delivered", label: "Delivered"  },
        { key: "received",  label: "Received"   }
    ];
    const statusOrder = ["pending", "en_route", "delivered", "received"];
    const normalised  = status === "delayed" ? "en_route" : status;
    const currentIdx  = statusOrder.indexOf(normalised);

    let html = `<div class="cust-progress">`;
    steps.forEach((step, idx) => {
        const stepIdx   = statusOrder.indexOf(step.key);
        const isDone    = stepIdx < currentIdx;
        const isCurrent = stepIdx === currentIdx;
        html += `
        <div class="cust-progress-step">
            <div class="cust-progress-dot ${isDone ? 'done' : isCurrent ? 'current' : ''}">
                ${isDone ? '<i class="fa-solid fa-check"></i>' : idx + 1}
            </div>
            <span class="cust-progress-label ${isDone ? 'done' : isCurrent ? 'current' : ''}">${step.label}</span>
        </div>`;
        if (idx < steps.length - 1) {
            html += `<div class="cust-progress-line ${isDone ? 'done' : ''}"></div>`;
        }
    });
    return html + `</div>`;
}

/* =========================================
   RENDER MODAL TABLES
========================================= */
function renderModalTable(tbodyId, orders, type) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;

    if (orders.length === 0) {
        const colCount = type === "delivered" ? 6 : type === "pending" ? 6 : 7;
        tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center;padding:24px;color:#94a3b8;">No records found.</td></tr>`;
        return;
    }

    tbody.innerHTML = orders.map(d => {
        const shortOrigin = d.origin      ? d.origin.split(",")[0]      : "—";
        const shortDest   = d.destination ? d.destination.split(",")[0] : "—";
        const etaStr      = d.eta
            ? new Date(d.eta).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
            : "—";
        const deliveredStr = d.deliveredAt
            ? d.deliveredAt.toDate().toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
            : "—";

        const receiveBtn = d.status === "delivered"
            ? `<button class="cust-btn-receive" style="padding:6px 12px;font-size:0.78rem;" onclick="promptConfirmReceipt('${d.id}','${d.deliveryCode}');closeModal('modal-delivered');">
                <i class="fa-solid fa-box-open"></i> Received
               </button>`
            : d.status === "received"
            ? `<span class="received-badge" style="font-size:0.78rem;"><i class="fa-solid fa-circle-check"></i> Confirmed</span>`
            : "";

        if (type === "pending") {
            return `<tr>
                <td><strong>${d.deliveryCode}</strong></td>
                <td>${d.batchCode || d.batchId || "—"}</td>
                <td>${shortOrigin}</td>
                <td>${shortDest}</td>
                <td>${etaStr}</td>
                <td><span class="status-pending">Pending</span></td>
            </tr>`;
        }
        if (type === "delivered") {
            return `<tr>
                <td><strong>${d.deliveryCode}</strong></td>
                <td>${d.batchCode || d.batchId || "—"}</td>
                <td>${shortOrigin}</td>
                <td>${shortDest}</td>
                <td>${deliveredStr}</td>
                <td>${receiveBtn}</td>
            </tr>`;
        }
        // en_route or delayed
        return `<tr>
            <td><strong>${d.deliveryCode}</strong></td>
            <td>${d.batchCode || d.batchId || "—"}</td>
            <td>${shortOrigin}</td>
            <td>${shortDest}</td>
            <td>${etaStr}</td>
            <td>${d.driverName || "—"}</td>
            <td><span class="status-${d.status}">${d.status.replace("_"," ")}</span></td>
        </tr>`;
    }).join("");
}

/* =========================================
   ORDER DETAIL MODAL
========================================= */
window.openOrderDetailById = async function(orderId) {
    window.openModal("modal-order-detail");
    const body = document.getElementById("order-detail-body");
    body.innerHTML = `<div style="text-align:center;padding:32px;color:#94a3b8;"><i class="fa-solid fa-spinner fa-spin" style="font-size:1.5rem;"></i></div>`;

    try {
        const snap = await getDoc(doc(db, "deliveries", orderId));
        if (!snap.exists()) { body.innerHTML = "<p>Order not found.</p>"; return; }
        const d = snap.data();

        const fmt = (ts) => ts?.toDate
            ? ts.toDate().toLocaleString("en-PH", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
            : "—";
        const etaStr = d.eta ? new Date(d.eta).toLocaleString("en-PH", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }) : "—";

        body.innerHTML = `
        <div class="cust-detail-section">
            <div class="cust-detail-title">Order Info</div>
            <div class="cust-detail-row"><span class="cust-detail-key">Delivery Code</span><span class="cust-detail-val">${d.deliveryCode || "—"}</span></div>
            <div class="cust-detail-row"><span class="cust-detail-key">Batch</span><span class="cust-detail-val">${d.batchCode || d.batchId || "—"}</span></div>
            <div class="cust-detail-row"><span class="cust-detail-key">Status</span><span class="cust-detail-val">${d.status?.replace("_"," ") || "—"}</span></div>
            <div class="cust-detail-row"><span class="cust-detail-key">Order Date</span><span class="cust-detail-val">${fmt(d.createdAt)}</span></div>
        </div>
        <div class="cust-detail-section">
            <div class="cust-detail-title">Delivery Info</div>
            <div class="cust-detail-row"><span class="cust-detail-key">From</span><span class="cust-detail-val">${d.origin || "—"}</span></div>
            <div class="cust-detail-row"><span class="cust-detail-key">To</span><span class="cust-detail-val">${d.destination || "—"}</span></div>
            <div class="cust-detail-row"><span class="cust-detail-key">Driver</span><span class="cust-detail-val">${d.driverName || "—"}</span></div>
            <div class="cust-detail-row"><span class="cust-detail-key">Truck</span><span class="cust-detail-val">${d.truck || "—"}</span></div>
            <div class="cust-detail-row"><span class="cust-detail-key">ETA</span><span class="cust-detail-val">${etaStr}</span></div>
        </div>
        ${d.deliveredAt ? `
        <div class="cust-detail-section">
            <div class="cust-detail-title">Completion</div>
            <div class="cust-detail-row"><span class="cust-detail-key">Delivered At</span><span class="cust-detail-val">${fmt(d.deliveredAt)}</span></div>
            ${d.receivedAt ? `<div class="cust-detail-row"><span class="cust-detail-key">Receipt Confirmed</span><span class="cust-detail-val">${fmt(d.receivedAt)}</span></div>` : ""}
        </div>` : ""}
        ${d.status === "delivered" ? `
        <div style="margin-top:20px;text-align:center;">
            <button class="cust-btn-receive" style="font-size:0.9rem;padding:10px 24px;" onclick="promptConfirmReceipt('${orderId}','${d.deliveryCode}');closeModal('modal-order-detail');">
                <i class="fa-solid fa-box-open"></i> Confirm Order Received
            </button>
        </div>` : ""}`;

    } catch (e) {
        console.error(e);
        body.innerHTML = `<p style="color:#dc2626;text-align:center;padding:24px;">Failed to load order details.</p>`;
    }
};

/* =========================================
   CONFIRM RECEIPT
========================================= */
window.promptConfirmReceipt = function(orderId, deliveryCode) {
    pendingConfirmId   = orderId;
    pendingConfirmCode = deliveryCode;
    document.getElementById("confirm-delivery-code").textContent = deliveryCode;
    window.openModal("modal-confirm-receipt");
};

function setupReceiptModal() {
    document.getElementById("cancel-receipt-btn")?.addEventListener("click", () => {
        window.closeModal("modal-confirm-receipt");
    });

    document.getElementById("confirm-receipt-btn")?.addEventListener("click", async () => {
        if (!pendingConfirmId) return;
        const btn = document.getElementById("confirm-receipt-btn");
        btn.disabled = true;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Confirming…`;

        try {
            await updateDoc(doc(db, "deliveries", pendingConfirmId), {
                status:     "received",
                receivedAt: serverTimestamp()
            });
            window.closeModal("modal-confirm-receipt");
            pendingConfirmId   = null;
            pendingConfirmCode = null;
        } catch (e) {
            console.error(e);
            btn.disabled = false;
            btn.innerHTML = `<i class="fa-solid fa-check"></i> Yes, I Received It`;
            alert("Something went wrong. Please try again.");
        }
    });
}