import { db } from "./firebase.js";
import {
    collection, getDocs, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

let allDocs = [];

document.addEventListener("DOMContentLoaded", async () => {
    await loadInspectorDashboard();

    // Bind search & sort controls
    document.getElementById("insp-search")?.addEventListener("input", renderTable);
    document.getElementById("insp-sort-status")?.addEventListener("change", renderTable);
    document.getElementById("insp-sort-date")?.addEventListener("change", renderTable);
});

/* =========================================
   LOAD DATA
========================================= */
async function loadInspectorDashboard() {
    try {
        const q        = query(collection(db, "inspections"), orderBy("createdAt", "desc"));
        const snapshot = await getDocs(q);

        allDocs = [];
        snapshot.forEach(docSnap => {
            const d = docSnap.data();
            if (d.createdAt?.toDate) allDocs.push({ id: docSnap.id, ...d });
        });

        renderTable();
        renderAttention();

    } catch (err) {
        console.error("Inspector Dashboard error:", err);
    }
}

/* =========================================
   RENDER TODAY TABLE (with search/sort)
========================================= */
function renderTable() {
    const tbody     = document.getElementById("today-body");
    const search    = (document.getElementById("insp-search")?.value    || "").toLowerCase();
    const status    =  document.getElementById("insp-sort-status")?.value || "";
    const sortDir   =  document.getElementById("insp-sort-date")?.value   || "desc";

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Filter to today only first
    let filtered = allDocs.filter(d => {
        const date = d.createdAt.toDate();
        return date >= today;
    });

    // Update today count badges (header + tab)
    document.getElementById("today-count-badge").textContent = filtered.length;
    const tabBadge = document.getElementById("tab-today-badge");
    if (tabBadge) tabBadge.textContent = filtered.length;

    // Apply search
    if (search) {
        filtered = filtered.filter(d =>
            (d.batchCode    || "").toLowerCase().includes(search) ||
            (d.productType  || "").toLowerCase().includes(search) ||
            (d.location     || "").toLowerCase().includes(search)
        );
    }

    // Apply status filter
    if (status) {
        filtered = filtered.filter(d => d.overallStatus === status);
    }

    // Apply sort
    filtered.sort((a, b) => {
        const aTime = a.createdAt.toDate().getTime();
        const bTime = b.createdAt.toDate().getTime();
        return sortDir === "asc" ? aTime - bTime : bTime - aTime;
    });

    tbody.innerHTML = "";

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:28px;color:#94a3b8;">No inspections found.</td></tr>`;
        return;
    }

    filtered.forEach(d => {
        const time = formatDate(d.createdAt);
        const statusClass = d.overallStatus === "Passed"     ? "status success"
                          : d.overallStatus === "With Issues" ? "status warning"
                          : "status danger";
        const icon = d.overallStatus === "Passed"     ? "fa-check"
                   : d.overallStatus === "With Issues" ? "fa-triangle-exclamation"
                   : "fa-circle-xmark";
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><strong>${d.batchCode || "—"}</strong></td>
            <td>${d.productType || "—"}</td>
            <td>${d.location || "—"}</td>
            <td><span class="${statusClass}"><i class="fa-solid ${icon}"></i> ${d.overallStatus}</span></td>
            <td>${time}</td>
        `;
        tbody.appendChild(tr);
    });
}

/* =========================================
   NEEDS ATTENTION
========================================= */
function renderAttention() {
    const list = document.getElementById("pending-inspections");
    if (!list) return;

    const attention = allDocs.filter(d =>
        d.overallStatus === "With Issues" || d.overallStatus === "Rejected"
    );

    // Update attention tab badge
    const badge = document.getElementById("na-count-badge");
    if (badge) {
        badge.textContent   = attention.length;
        badge.style.display = attention.length > 0 ? "flex" : "none";
    }

    // Highlight the attention tab if there are items
    const attTab = document.querySelector('.insp-tab[data-tab="attention"]');
    if (attTab) attTab.classList.toggle("has-alerts", attention.length > 0);

    list.innerHTML = "";

    if (attention.length === 0) {
        list.innerHTML = `
            <li style="text-align:center;padding:32px 0;color:#94a3b8;font-size:0.88rem;">
                <i class="fa-solid fa-circle-check" style="color:#16a34a;font-size:1.6rem;display:block;margin-bottom:8px;"></i>
                All clear — no issues or rejections.
            </li>`;
        return;
    }

    attention.forEach(d => {
        const isIssue    = d.overallStatus === "With Issues";
        const statusClass = isIssue ? "warning" : "danger";

        const criteriaFlagged = (d.criteria || [])
            .filter(c => c.assessment !== "Excellent")
            .map(c => c.criteriaName)
            .join(", ") || "—";

        const li = document.createElement("li");
        li.innerHTML = `
            <div class="task-card">
                <div>
                    <strong>${d.batchCode || "—"}</strong>
                    <div class="task-sub">${d.productType || "—"} · ${d.location || "—"}</div>
                    <div class="task-criteria">Flagged: ${criteriaFlagged}</div>
                </div>
                <span class="task-status ${statusClass}">${d.overallStatus}</span>
            </div>
        `;
        list.appendChild(li);
    });
}

/* =========================================
   HELPERS
========================================= */
function formatDate(timestamp) {
    if (!timestamp?.toDate) return "—";
    return timestamp.toDate().toLocaleString("en-PH", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true
    });
}