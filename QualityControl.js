import { db } from "./firebase.js";
import {
    collection,
    addDoc,
    getDocs,
    deleteDoc,
    updateDoc,
    doc,
    query,
    where,
    serverTimestamp,
    orderBy
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Read the logged-in user's full name directly from localStorage
const currentInspectorName = localStorage.getItem("userFullName") || "Unknown";

// Tracks whether we're editing an existing record (stores doc ID) or creating new
let editingRecordId = null;

// Current product category: "fish" | "shrimp"
let currentProductCategory = "fish";


// ==========================
// Criteria Config per type
// ==========================
const CRITERIA_CONFIG = {
    fish: [
        { name: "Eye Clarity",    weight: 0.30, label: "30%" },
        { name: "Gill Color",     weight: 0.25, label: "25%" },
        { name: "Odor",           weight: 0.25, label: "25%" },
        { name: "Body Firmness",  weight: 0.20, label: "20%" },
    ],
    shrimp: [
        { name: "Shell Condition", weight: 0.30, label: "30%" },
        { name: "Odor",            weight: 0.30, label: "30%" },
        { name: "Texture",         weight: 0.25, label: "25%" },
        { name: "Tail Appearance", weight: 0.15, label: "15%" },
    ]
};

const PRODUCT_OPTIONS = {
    fish:   ["Bangus", "Tilapia"],
    shrimp: ["Fresh Water Shrimp"]
};


// ==========================
// Auto-Generate Batch ID
// ==========================
async function generateBatchId() {
    try {
        const snapshot = await getDocs(collection(db, "inspections"));
        let maxNum = 0;
        snapshot.forEach(d => {
            const code  = d.data().batchCode || "";
            const match = code.match(/^B0-(\d+)$/i);
            if (match) {
                const num = parseInt(match[1], 10);
                if (num > maxNum) maxNum = num;
            }
        });
        return "B0-" + (maxNum + 1);
    } catch (e) {
        console.error("Could not generate batch ID:", e);
        return "B0-1";
    }
}


// ==========================
// Render Criteria Rows
// ==========================
function renderCriteriaRows(category) {
    const tbody = document.getElementById("new-inspection-tbody");
    tbody.innerHTML = "";
    CRITERIA_CONFIG[category].forEach(c => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><strong>${c.name}</strong></td>
            <td><span class="weight-badge">${c.label}</span></td>
            <td>
                <select class="criteria-select" data-criteria="${c.name}" data-weight="${c.weight}">
                    <option value="Excellent">Excellent</option>
                    <option value="Acceptable">Acceptable</option>
                    <option value="Rejected">Rejected</option>
                </select>
            </td>
            <td><input class="criteria-remarks" type="text" placeholder="Optional notes..."></td>
        `;
        tbody.appendChild(tr);
    });
    calculateScore();
}


// ==========================
// Render Product Type Options
// ==========================
function renderProductOptions(category) {
    const select = document.getElementById("product-type");
    select.innerHTML = '<option value="" disabled selected>Select Product</option>';
    PRODUCT_OPTIONS[category].forEach(p => {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = p;
        select.appendChild(opt);
    });
}


// ==========================
// Update Product Badge in Inspection Modal
// ==========================
function updateProductBadge(category) {
    const badge = document.getElementById("ni-product-badge");
    const label = document.getElementById("ni-product-badge-label");
    badge.className = "ni-product-badge " + category;
    if (category === "fish") {
        badge.querySelector("i").className = "fa-solid fa-fish";
        label.textContent = "Fish Inspection";
    } else {
        badge.querySelector("i").className = "fa-solid fa-shrimp";
        label.textContent = "Shrimp Inspection";
    }
}


// ==========================
// Helper: Collect Criteria Data
// ==========================
function getCriteriaData() {
    const rows = document.querySelectorAll("#new-inspection-tbody tr");
    return Array.from(rows).map(row => ({
        criteriaName: row.querySelector(".criteria-select").dataset.criteria,
        weight:       parseFloat(row.querySelector(".criteria-select").dataset.weight),
        assessment:   row.querySelector(".criteria-select").value,
        remarks:      row.querySelector(".criteria-remarks").value.trim() || ""
    }));
}


// ==========================
// Calculate Freshness Score
// Fish:   Score = (Eye×0.3)+(Gill×0.25)+(Odor×0.25)+(Firmness×0.2) × 20  → 0-100
// Shrimp: Score = (Shell×0.3)+(Odor×0.3)+(Texture×0.25)+(Tail×0.15) × 20 → 0-100
// Thresholds: 80-100 = Passed, 60-79 = With Issues, <60 = Rejected
// ==========================
function calculateScore() {
    const scoreMap = { "Excellent": 5, "Acceptable": 3, "Rejected": 1 };

    let weightedSum = 0;
    document.querySelectorAll(".criteria-select").forEach(sel => {
        const rawScore = scoreMap[sel.value] ?? 1;
        const weight   = parseFloat(sel.dataset.weight) || 0;
        weightedSum += rawScore * weight;
    });

    // Multiply by 20 to convert to 0–100 scale
    const finalScore = Math.min(100, Math.round(weightedSum * 20));

    let classification, statusClass, iconHTML;
    if (finalScore >= 80) {
        classification = "Passed";
        statusClass    = "success";
        iconHTML       = '<i class="fa-solid fa-check"></i> ';
    } else if (finalScore >= 60) {
        classification = "With Issues";
        statusClass    = "warning";
        iconHTML       = '<i class="fa-solid fa-triangle-exclamation"></i> ';
    } else {
        classification = "Rejected";
        statusClass    = "danger";
        iconHTML       = '<i class="fa-solid fa-circle-xmark"></i> ';
    }

    document.getElementById("live-score").textContent = finalScore;
    const classEl = document.getElementById("live-classification");
    classEl.innerHTML = iconHTML + classification;
    classEl.className = "status " + statusClass;

    return { finalScore, classification };
}


// ==========================
// Bind Live Score Calculation
// ==========================
document.addEventListener("change", e => {
    if (e.target.matches(".criteria-select")) {
        calculateScore();
    }
});

document.addEventListener("DOMContentLoaded", () => { calculateScore(); });


// ==========================
// Product Chooser Modal Logic
// ==========================
document.getElementById("btn-new-inspection")
    .addEventListener("click", () => {
        editingRecordId = null;
        document.getElementById("modal-product-chooser").classList.add("active");
        document.body.style.overflow = "hidden";
    });

async function openInspectionModal(category) {
    currentProductCategory = category;

    // Close chooser
    document.getElementById("modal-product-chooser").classList.remove("active");

    // Reset title & button
    document.getElementById("modal-inspection-title").innerHTML =
        '<i class="fa-solid fa-clipboard-list"></i> New Inspection Log';
    document.getElementById("save-inspection-btn").innerHTML =
        '<i class="fa-solid fa-floppy-disk"></i> Save Inspection Log';

    // Product badge
    updateProductBadge(category);

    // Product dropdown options
    renderProductOptions(category);

    // Criteria rows
    renderCriteriaRows(category);

    // Batch ID
    const batchInput    = document.getElementById("batch-code");
    batchInput.value    = "Generating...";
    batchInput.readOnly = true;
    batchInput.style.color      = "#64748B";
    batchInput.style.background = "#F8FAFC";
    batchInput.value = await generateBatchId();

    // Clear location
    document.getElementById("inspection-location").selectedIndex = 0;

    document.getElementById("modal-new-inspection").classList.add("active");
    document.body.style.overflow = "hidden";
}

document.getElementById("choose-fish").addEventListener("click",  () => openInspectionModal("fish"));
document.getElementById("choose-shrimp").addEventListener("click", () => openInspectionModal("shrimp"));

// "Change Type" button — toggles directly between fish and shrimp
document.getElementById("ni-change-type-btn").addEventListener("click", async () => {
    const newCategory = currentProductCategory === "fish" ? "shrimp" : "fish";
    currentProductCategory = newCategory;

    updateProductBadge(newCategory);
    renderProductOptions(newCategory);
    renderCriteriaRows(newCategory);

    // Reset location and regenerate batch ID
    document.getElementById("inspection-location").selectedIndex = 0;
    const batchInput = document.getElementById("batch-code");
    batchInput.value = "Generating...";
    batchInput.value = await generateBatchId();
});


// ==========================
// Open modal in EDIT mode
// ==========================
async function openEditModal(id, data) {
    editingRecordId = id;

    // Determine category from saved productType
    const shrimpProducts = ["Fresh Water Shrimp"];
    const category = shrimpProducts.includes(data.productType) ? "shrimp" : "fish";
    currentProductCategory = category;

    document.getElementById("modal-inspection-title").innerHTML =
        '<i class="fa-solid fa-pen-to-square"></i> Edit Inspection Log';
    document.getElementById("save-inspection-btn").innerHTML =
        '<i class="fa-solid fa-floppy-disk"></i> Save Changes';

    // Product badge + options
    updateProductBadge(category);
    renderProductOptions(category);

    // Batch ID
    const batchInput        = document.getElementById("batch-code");
    batchInput.value        = data.batchCode    || "";
    batchInput.readOnly     = true;
    batchInput.style.color  = "#64748B";
    batchInput.style.background = "#F8FAFC";

    document.getElementById("inspection-location").value = data.location || "";

    // Product select
    const productSelect = document.getElementById("product-type");
    productSelect.value = data.productType || "";

    // Render criteria rows for this category, then fill saved values
    renderCriteriaRows(category);
    const criteriaRows = document.querySelectorAll("#new-inspection-tbody tr");
    criteriaRows.forEach(row => {
        const name  = row.querySelector(".criteria-select").dataset.criteria;
        const match = (data.criteria || []).find(c => c.criteriaName === name);
        if (match) {
            row.querySelector(".criteria-select").value  = match.assessment || "Excellent";
            row.querySelector(".criteria-remarks").value = match.remarks    || "";
        }
    });

    calculateScore();

    document.getElementById("modal-new-inspection").classList.add("active");
    document.body.style.overflow = "hidden";
}


// ==========================
// Save / Update Inspection
// ==========================
document.getElementById("save-inspection-btn")
    .addEventListener("click", async () => {

        const batchCode   = document.getElementById("batch-code").value.trim();
        const productType = document.getElementById("product-type").value.trim();
        const location    = document.getElementById("inspection-location").value.trim();

        if (!batchCode || !productType || !location) {
            alert("Please fill in all required fields: Batch ID, Product Type, and Location.");
            return;
        }

        const criteria                     = getCriteriaData();
        const { finalScore, classification } = calculateScore();

        try {
            if (editingRecordId) {
                await updateDoc(doc(db, "inspections", editingRecordId), {
                    batchCode,
                    productType,
                    productCategory: currentProductCategory,
                    location,
                    criteria,
                    score:         finalScore,
                    overallStatus: classification
                });
                alert("Inspection updated successfully!");
            } else {
                const isRejected = classification === "Rejected";
                await addDoc(collection(db, "inspections"), {
                    batchCode,
                    productType,
                    productCategory:  currentProductCategory,
                    location,
                    inspectorName:    currentInspectorName,
                    criteria,
                    score:            finalScore,
                    overallStatus:    classification,
                    disposalStatus:   isRejected ? "auto-disposed" : "pending",
                    disposedAt:       isRejected ? serverTimestamp() : null,
                    createdAt:        serverTimestamp()
                });
                alert("Inspection saved successfully!");
            }

            editingRecordId = null;
            await resetInspectionForm();
            await loadInspectionsToday();
            await loadInspectionsByStatus();

        } catch (error) {
            console.error("Firestore error:", error);
            alert("Failed to save inspection. Check console for details.");
        }
    });


// ==========================
// Clear Form Button
// ==========================
document.getElementById("add-inspection-btn")
    .addEventListener("click", async () => {
        await resetInspectionForm();
    });


// ==========================
// Reset Form
// ==========================
async function resetInspectionForm() {
    editingRecordId = null;

    document.getElementById("inspection-location").selectedIndex = 0;
    renderProductOptions(currentProductCategory);
    renderCriteriaRows(currentProductCategory);

    calculateScore();

    document.getElementById("modal-inspection-title").innerHTML =
        '<i class="fa-solid fa-clipboard-list"></i> New Inspection Log';
    document.getElementById("save-inspection-btn").innerHTML =
        '<i class="fa-solid fa-floppy-disk"></i> Save Inspection Log';

    const batchInput        = document.getElementById("batch-code");
    batchInput.value        = "Generating...";
    batchInput.readOnly     = true;
    batchInput.style.color  = "#64748B";
    batchInput.style.background = "#F8FAFC";
    batchInput.value = await generateBatchId();
}


// ==========================
// Status Badge Helper
// ==========================
function getStatusBadgeHTML(status) {
    if (status === "Passed")
        return `<span class="status success"><i class="fa-solid fa-check"></i> Passed</span>`;
    if (status === "With Issues")
        return `<span class="status warning"><i class="fa-solid fa-triangle-exclamation"></i> With Issues</span>`;
    if (status === "Rejected")
        return `<span class="status danger"><i class="fa-solid fa-circle-xmark"></i> Rejected</span>`;
    return `<span>${status}</span>`;
}


// ==========================
// Format Timestamp Helper
// ==========================
function formatDate(timestamp) {
    if (!timestamp) return "—";
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleString("en-PH", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true
    });
}


// ==========================
// Load Today's Inspections
// ==========================
async function loadInspectionsToday() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    try {
        const q = query(
            collection(db, "inspections"),
            where("createdAt", ">=", today),
            orderBy("createdAt", "desc")
        );
        const snapshot  = await getDocs(q);
        const container = document.getElementById("inspections-today-body");
        const emptyEl   = document.getElementById("inspections-today-empty");
        container.innerHTML = "";

        if (snapshot.empty) {
            if (emptyEl) emptyEl.style.display = "block";
            document.getElementById("inspections-today-count").textContent = 0;
            return;
        }
        if (emptyEl) emptyEl.style.display = "none";

        snapshot.forEach(d => {
            const r = d.data();

            const statusKey = r.overallStatus === "Passed"      ? "passed"
                            : r.overallStatus === "With Issues" ? "issues"
                            : "rejected";

            const shrimpProducts = ["Fresh Water Shrimp"];
            const pillClass = shrimpProducts.includes(r.productType) ? "shrimp" : "fish";

            const badgeLabel = r.overallStatus === "With Issues" ? "With Issues" : r.overallStatus;

            const card = document.createElement("div");
            card.className = `insp-card ${statusKey}`;
            card.innerHTML = `
                <div class="insp-batch-col">
                    <div class="insp-batch-id">${r.batchCode ?? ""}</div>
                    <span class="insp-product-pill ${pillClass}">${r.productType ?? ""}</span>
                </div>
                <div class="insp-meta-col">
                    <div class="insp-meta-item">
                        <span class="insp-meta-label">Inspector</span>
                        <span class="insp-meta-val">${r.inspectorName ?? "—"}</span>
                    </div>
                    <div class="insp-meta-item">
                        <span class="insp-meta-label">Location</span>
                        <span class="insp-meta-val">${r.location ?? "—"}</span>
                    </div>
                    <div class="insp-meta-item">
                        <span class="insp-meta-label">Score</span>
                        <span class="insp-meta-val score-val">${r.score ?? "—"} <span style="font-weight:400;color:#64748B;font-size:0.78rem;">/ 100</span></span>
                    </div>
                </div>
                <div class="insp-date-col">${formatDate(r.createdAt)}</div>
                <span class="insp-badge ${statusKey}">
                    <span class="insp-badge-dot ${statusKey}"></span>
                    ${badgeLabel}
                </span>
            `;
            container.appendChild(card);
        });

        document.getElementById("inspections-today-count").textContent = snapshot.size;
    } catch (error) {
        console.error("Error loading today's inspections:", error);
    }
}


// ==========================
// Load Inspections By Status
// ==========================
async function loadInspectionsByStatus() {
    const statuses = [
        { bodyId: "passed-body",   countId: "passed-count",   status: "Passed"      },
        { bodyId: "issues-body",   countId: "issues-count",   status: "With Issues" },
        { bodyId: "rejected-body", countId: "rejected-count", status: "Rejected"    },
    ];

    for (const s of statuses) {
        try {
            const q = query(
                collection(db, "inspections"),
                where("overallStatus", "==", s.status)
            );
            const snapshot = await getDocs(q);
            const tbody    = document.getElementById(s.bodyId);
            tbody.innerHTML = "";

            snapshot.forEach(docSnap => {
                const r  = docSnap.data();
                const id = docSnap.id;
                const tr = document.createElement("tr");

                let detailCell = "";
                if (s.status === "Passed") {
                    const remarks  = (r.criteria || []).filter(c => c.remarks).map(c => c.remarks).join(", ");
                    const flagged  = (r.criteria || []).filter(c => c.assessment !== "Excellent").map(c => c.criteriaName).join(", ");
                    detailCell = remarks || flagged || "—";
                } else if (s.status === "With Issues") {
                    const flagged  = (r.criteria || []).filter(c => c.assessment === "Acceptable").map(c => c.criteriaName).join(", ");
                    const remarks  = (r.criteria || []).filter(c => c.remarks).map(c => c.remarks).join(", ");
                    detailCell = flagged ? `${flagged}${remarks ? " — " + remarks : ""}` : remarks || "—";
                } else if (s.status === "Rejected") {
                    const flagged  = (r.criteria || []).filter(c => c.assessment === "Rejected").map(c => c.criteriaName).join(", ");
                    const remarks  = (r.criteria || []).filter(c => c.remarks).map(c => c.remarks).join(", ");
                    detailCell = flagged ? `${flagged}${remarks ? " — " + remarks : ""}` : remarks || "—";
                }

                const safeData = encodeURIComponent(JSON.stringify({
                    batchCode:       r.batchCode       ?? "",
                    productType:     r.productType     ?? "",
                    productCategory: r.productCategory ?? "fish",
                    location:        r.location        ?? "",
                    overallStatus:   r.overallStatus   ?? "",
                    criteria:        r.criteria        ?? []
                }));

                tr.innerHTML = `
                    <td><strong>${r.batchCode    ?? ""}</strong></td>
                    <td>${r.inspectorName        ?? "—"}</td>
                    <td>${r.productType          ?? ""}</td>
                    <td>${r.location             ?? ""}</td>
                    <td>${detailCell}</td>
                    <td>${formatDate(r.createdAt)}</td>
                    <td class="text-right">${getStatusBadgeHTML(r.overallStatus)}</td>
                    <td>
                        <button class="edit-record-btn" data-id="${id}" data-record="${safeData}">
                            <i class="fa-solid fa-pen-to-square"></i> Edit
                        </button>
                    </td>
                `;
                tbody.appendChild(tr);
            });

            document.getElementById(s.countId).textContent = snapshot.size;
        } catch (error) {
            console.error(`Error loading ${s.status} inspections:`, error);
        }
    }

    attachEditListeners();
}


// ==========================
// Attach Edit Button Listeners
// ==========================
function attachEditListeners() {
    document.querySelectorAll(".edit-record-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const id   = btn.dataset.id;
            const data = JSON.parse(decodeURIComponent(btn.dataset.record));

            ["modal-passed", "modal-issues", "modal-rejected"].forEach(modalId => {
                document.getElementById(modalId)?.classList.remove("active");
            });

            openEditModal(id, data);
        });
    });
}


// ==========================
// Download Full QC Report (PDF — styled, multi-page, with charts)
// Page 1: Cover + Key Metrics + Status Distribution chart
// Page 2: Performance by Location (chart + table) + Performance by Product (table)
// Page 3: Top Failure Points (chart + table)
// Page 4+: Spoilage Report table
// Page N+: All Inspection Records table
// ==========================
document.getElementById("download-delivery-report-btn")
    ?.addEventListener("click", async () => {
        const btn = document.getElementById("download-delivery-report-btn");
        const originalHTML = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generating...';

        try {
            if (!window.jspdf || !window.jspdf.jsPDF) {
                throw new Error("PDF library (jsPDF) failed to load. Check your internet connection and reload the page.");
            }
            if (!window.jspdf.jsPDF.API || typeof window.jspdf.jsPDF.API.autoTable !== "function") {
                throw new Error("PDF table plugin (jsPDF-AutoTable) failed to load. Check your internet connection and reload the page.");
            }
            if (typeof Chart === "undefined") {
                throw new Error("Chart library (Chart.js) failed to load. Check your internet connection and reload the page.");
            }

            const q        = query(collection(db, "inspections"), orderBy("createdAt", "desc"));
            const snapshot = await getDocs(q);

            if (snapshot.empty) {
                alert("No inspection data found.");
                return;
            }

            const records = [];
            snapshot.forEach(d => records.push({ id: d.id, ...d.data() }));

            await buildQualityControlReportPDF(records);

        } catch (error) {
            console.error("Inspection report error:", error);
            alert(`Failed to generate inspection report.\n\n${error?.message || error}`);
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalHTML;
        }
    });


// ==========================
// Helper: render a Chart.js chart off-screen and return a PNG data URL
// ==========================
async function renderChartImage(config, cssWidth = 480, cssHeight = 220, scale = 2) {
    const canvas = document.createElement("canvas");
    canvas.width  = cssWidth * scale;
    canvas.height = cssHeight * scale;
    canvas.style.position = "fixed";
    canvas.style.left = "-9999px";
    canvas.style.top  = "-9999px";
    document.body.appendChild(canvas);

    const chart = new Chart(canvas.getContext("2d"), {
        ...config,
        options: {
            ...(config.options || {}),
            responsive: false,
            animation: false,
            devicePixelRatio: scale
        }
    });

    // Force a synchronous, animation-free render before reading pixels
    chart.update("none");
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const imgData = canvas.toDataURL("image/png", 1.0);
    chart.destroy();
    document.body.removeChild(canvas);
    return imgData;
}


// ==========================
// Report Builder — Full QC Report (PDF)
// Executive Dashboard Redesign (Power BI / Tableau / SAP Analytics Style)
// ==========================
async function buildQualityControlReportPDF(records) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "pt", format: "a4" });

    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const MARGIN = 36;

    // ---------- Executive Design System & Color Palette ----------
    const COLORS = {
        primary: "#1E3A5F",      // Navy Blue
        secondary: "#4A6FA5",    // Steel Blue
        accent: "#5BC0BE",       // Soft Cyan
        background: "#F8FAFC",   // Off White
        surface: "#FFFFFF",      // White Cards
        border: "#E5E7EB",       // Light Gray
        text: "#2F3E46",         // Charcoal
        muted: "#64748B",        // Gray

        success: "#2E8B57",      // Green (Passed)
        warning: "#D97706",      // Orange (With Issues)
        danger: "#C0392B"        // Red (Rejected)
    };

    // Helper to convert hex to RGB array for jsPDF
    const hexToRgb = (hex) => {
        const h = hex.replace("#", "");
        return [
            parseInt(h.substring(0, 2), 16),
            parseInt(h.substring(2, 4), 16),
            parseInt(h.substring(4, 6), 16)
        ];
    };

    const RGB = {
        primary: hexToRgb(COLORS.primary),
        secondary: hexToRgb(COLORS.secondary),
        accent: hexToRgb(COLORS.accent),
        background: hexToRgb(COLORS.background),
        surface: hexToRgb(COLORS.surface),
        border: hexToRgb(COLORS.border),
        text: hexToRgb(COLORS.text),
        muted: hexToRgb(COLORS.muted),
        success: hexToRgb(COLORS.success),
        warning: hexToRgb(COLORS.warning),
        danger: hexToRgb(COLORS.danger)
    };

    const HEADER_H    = 46;                  // Dark Navy Header Band
    const CONTENT_TOP = HEADER_H + 20;       // Content Start

    const fmtDate = (ts) => {
        if (!ts) return "—";
        const date = ts.toDate ? ts.toDate() : new Date(ts);
        return date.toLocaleString("en-PH", {
            month: "short", day: "numeric", year: "numeric",
            hour: "numeric", minute: "2-digit", hour12: true
        });
    };

    const reportGeneratedAt = new Date().toLocaleString("en-PH", {
        month: "long", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true
    });

    // ---------- Premium Executive Report Header ----------
    function drawHeader(title, subtitle) {
        // Dark Navy background
        doc.setFillColor(...RGB.primary);
        doc.rect(0, 0, pageW, HEADER_H, "F");

        // Thin Soft Cyan accent line underneath header band
        doc.setFillColor(...RGB.accent);
        doc.rect(0, HEADER_H, pageW, 2.5, "F");

        // Main Title (White)
        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(13);
        doc.text(title, MARGIN, subtitle ? 20 : 28);

        // Subtitle (Light Gray)
        if (subtitle) {
            doc.setFont("helvetica", "normal");
            doc.setFontSize(8);
            doc.setTextColor(226, 232, 240);
            doc.text(subtitle, MARGIN, 34);
        }
    }

    // ============================================================
    // AGGREGATE STATS & BUSINESS CALCULATIONS
    // ============================================================
    const total          = records.length;
    const passed         = records.filter(r => r.overallStatus === "Passed");
    const withIssues     = records.filter(r => r.overallStatus === "With Issues");
    const rejected       = records.filter(r => r.overallStatus === "Rejected");
    const disposedManual = withIssues.filter(r => r.disposalStatus === "disposed");

    const spoiledRecords = [...rejected, ...disposedManual];
    const spoilageRate   = total ? (spoiledRecords.length / total) * 100 : 0;
    const passRate       = total ? (passed.length / total) * 100 : 0;
    const avgScore       = total ? records.reduce((s, r) => s + (r.score || 0), 0) / total : 0;

    const byLocation = {};
    records.forEach(r => {
        const loc = r.location || "Unspecified";
        if (!byLocation[loc]) byLocation[loc] = { total: 0, passed: 0, issues: 0, rejected: 0, scoreSum: 0 };
        byLocation[loc].total++;
        byLocation[loc].scoreSum += (r.score || 0);
        if (r.overallStatus === "Passed") byLocation[loc].passed++;
        else if (r.overallStatus === "With Issues") byLocation[loc].issues++;
        else if (r.overallStatus === "Rejected") byLocation[loc].rejected++;
    });

    const byProduct = {};
    records.forEach(r => {
        const p = r.productType || "Unspecified";
        if (!byProduct[p]) byProduct[p] = { total: 0, passed: 0, issues: 0, rejected: 0, scoreSum: 0 };
        byProduct[p].total++;
        byProduct[p].scoreSum += (r.score || 0);
        if (r.overallStatus === "Passed") byProduct[p].passed++;
        else if (r.overallStatus === "With Issues") byProduct[p].issues++;
        else if (r.overallStatus === "Rejected") byProduct[p].rejected++;
    });

    const criteriaFailTally = {};
    records.forEach(r => {
        (r.criteria || []).forEach(c => {
            if (c.assessment === "Rejected" || c.assessment === "Acceptable") {
                if (!criteriaFailTally[c.criteriaName]) criteriaFailTally[c.criteriaName] = { rejected: 0, acceptable: 0 };
                if (c.assessment === "Rejected") criteriaFailTally[c.criteriaName].rejected++;
                else criteriaFailTally[c.criteriaName].acceptable++;
            }
        });
    });
    const sortedCriteria = Object.entries(criteriaFailTally).sort((a, b) => b[1].rejected - a[1].rejected);

    // ============================================================
    // CHARTS DESIGNED ACCORDING TO SPECIFICATION
    // ============================================================
    
    // Chart 1: Status Distribution (Passed: Green, With Issues: Orange, Rejected: Red)
    const statusChartImg = await renderChartImage({
        type: "doughnut",
        data: {
            labels: ["Passed", "With Issues", "Rejected"],
            datasets: [{
                data: [passed.length, withIssues.length, rejected.length],
                backgroundColor: [COLORS.success, COLORS.warning, COLORS.danger],
                borderWidth: 0
            }]
        },
        options: {
            plugins: {
                legend: { position: "right", labels: { font: { size: 11, family: "Helvetica" }, color: COLORS.text } },
                title: { display: true, text: "Overall Status Distribution", font: { size: 12, weight: "bold", family: "Helvetica" }, color: COLORS.primary }
            }
        }
    }, 480, 210);

    // Chart 2: Average Score by Location (Monochromatic Navy/Steel Shades)
    const locationLabels = Object.keys(byLocation);
    const locationScores = locationLabels.map(l => Number((byLocation[l].scoreSum / byLocation[l].total).toFixed(1)));
    const locationMonochromeShades = ["#1E3A5F", "#335C81", "#4A6FA5", "#6C8EBF", "#A9BCD0"];
    const locationBarColors = locationLabels.map((_, idx) => locationMonochromeShades[idx % locationMonochromeShades.length]);

    const locationChartImg = await renderChartImage({
        type: "bar",
        data: {
            labels: locationLabels,
            datasets: [{
                label: "Average Freshness Score",
                data: locationScores,
                backgroundColor: locationBarColors,
                borderRadius: 3
            }]
        },
        options: {
            plugins: {
                legend: { display: false },
                title: { display: true, text: "Average Freshness Score by Location", font: { size: 12, weight: "bold", family: "Helvetica" }, color: COLORS.primary }
            },
            scales: {
                y: { beginAtZero: true, max: 100, ticks: { font: { size: 9 }, color: COLORS.muted } },
                x: { ticks: { font: { size: 9 }, color: COLORS.text } }
            }
        }
    }, 480, 210);

    // Chart 3: Top Failure Points (Steel Blue shades, highlight top 1 in Red)
    const topFailures = sortedCriteria.slice(0, 8);
    const failureBarColors = topFailures.map((_, idx) => {
        if (idx === 0) return COLORS.danger; // Top failure highlighted in Red
        // Fading from Navy/Steel Blue to Light Blue
        const fadePalette = ["#1E3A5F", "#335C81", "#4A6FA5", "#5BC0BE", "#6C8EBF", "#8DA9C4", "#A9BCD0"];
        return fadePalette[(idx - 1) % fadePalette.length];
    });

    const failureChartImg = topFailures.length ? await renderChartImage({
        type: "bar",
        data: {
            labels: topFailures.map(([name]) => name),
            datasets: [{
                label: "Times Rejected",
                data: topFailures.map(([, t]) => t.rejected),
                backgroundColor: failureBarColors,
                borderRadius: 3
            }]
        },
        options: {
            indexAxis: "y",
            plugins: {
                legend: { display: false },
                title: { display: true, text: "Top Failure Points (Most Flagged Criteria)", font: { size: 12, weight: "bold", family: "Helvetica" }, color: COLORS.primary }
            },
            scales: {
                x: { beginAtZero: true, ticks: { stepSize: 1, font: { size: 9 }, color: COLORS.muted } },
                y: { ticks: { font: { size: 9 }, color: COLORS.text } }
            }
        }
    }, 480, 210) : null;

    const chartW = pageW - MARGIN * 2;
    const chartH = chartW * (210 / 480);

    // ============================================================
    // PAGE 1 — EXECUTIVE SUMMARY & KEY KPI CARDS
    // ============================================================
    drawHeader("AquaFRESH — Quality Control Executive Report", `Generated: ${reportGeneratedAt}  ·  Coverage: ${total} Total Inspection Logs`);

    // Section Header
    doc.setTextColor(...RGB.primary);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text("Executive Key Metrics", MARGIN, CONTENT_TOP);

    // Redesigned KPI Cards: White surface, thin colored left border, bold number, smaller gray label
    const kpiDefinitions = [
        ["Total Inspections", `${total}`, COLORS.primary],       // Blue border
        ["Passed Inspections", `${passed.length}`, COLORS.success],  // Green border
        ["With Issues", `${withIssues.length}`, COLORS.warning],     // Orange border
        ["Rejected Inspections", `${rejected.length}`, COLORS.danger], // Red border
        ["Pass Rate", `${passRate.toFixed(1)}%`, COLORS.success],    // Green border
        ["Spoilage Rate", `${spoilageRate.toFixed(1)}%`, COLORS.warning], // Orange border
        ["Avg Freshness Score", avgScore.toFixed(1), COLORS.accent],  // Soft Cyan border
        ["Spoiled / Discarded", `${spoiledRecords.length}`, COLORS.danger] // Red border
    ];

    const cardW = (pageW - MARGIN * 2 - 3 * 8) / 4;
    const cardH = 42;
    let cardX = MARGIN, cardY = CONTENT_TOP + 12;

    kpiDefinitions.forEach(([label, value, borderColorHex], i) => {
        if (i === 4) { cardX = MARGIN; cardY += cardH + 10; }

        // White card surface with light gray subtle border
        doc.setDrawColor(...RGB.border);
        doc.setFillColor(...RGB.surface);
        doc.roundedRect(cardX, cardY, cardW, cardH, 3, 3, "FD");

        // Thin colored left border accent
        const borderRgb = hexToRgb(borderColorHex);
        doc.setFillColor(...borderRgb);
        doc.rect(cardX, cardY, 3, cardH, "F");

        // Smaller gray label
        doc.setFontSize(7.5);
        doc.setTextColor(...RGB.muted);
        doc.setFont("helvetica", "normal");
        doc.text(label, cardX + 10, cardY + 15, { maxWidth: cardW - 16 });

        // Large bold number
        doc.setFontSize(14);
        doc.setTextColor(...RGB.text);
        doc.setFont("helvetica", "bold");
        doc.text(value, cardX + 10, cardY + 32);

        cardX += cardW + 8;
    });

    // Chart on Page 1
    const chartY = cardY + cardH + 18;
    doc.addImage(statusChartImg, "PNG", MARGIN, chartY, chartW, chartH);

    // ============================================================
    // PAGE 2 — PERFORMANCE BREAKDOWNS (LOCATION & PRODUCT)
    // ============================================================
    doc.addPage();
    drawHeader("Quality Performance Breakdown", "Analysis by Facility Location and Product Category");

    doc.addImage(locationChartImg, "PNG", MARGIN, CONTENT_TOP, chartW, chartH);

    // Table 1: Performance by Location
    doc.autoTable({
        startY: CONTENT_TOP + chartH + 14,
        margin: { left: MARGIN, right: MARGIN },
        head: [["Location Facility", "Total", "Passed", "With Issues", "Rejected", "Avg Score"]],
        body: Object.entries(byLocation).map(([loc, s]) => [
            loc, s.total, s.passed, s.issues, s.rejected, (s.scoreSum / s.total).toFixed(1)
        ]),
        theme: "grid",
        headStyles: { fillColor: RGB.primary, textColor: 255, fontStyle: "bold", halign: "center", fontSize: 8.5 },
        bodyStyles: { textColor: RGB.text, halign: "center", fontSize: 8.5, cellPadding: 5 },
        columnStyles: { 0: { halign: "left" } },
        alternateRowStyles: { fillColor: RGB.background },
        styles: { lineColor: RGB.border, lineWidth: 0.5 }
    });

    // Table 2: Performance by Product Type
    doc.autoTable({
        startY: doc.lastAutoTable.finalY + 16,
        margin: { left: MARGIN, right: MARGIN, top: CONTENT_TOP },
        head: [["Product Type", "Total", "Passed", "With Issues", "Rejected", "Avg Score"]],
        body: Object.entries(byProduct).map(([p, s]) => [
            p, s.total, s.passed, s.issues, s.rejected, (s.scoreSum / s.total).toFixed(1)
        ]),
        theme: "grid",
        headStyles: { fillColor: RGB.secondary, textColor: 255, fontStyle: "bold", halign: "center", fontSize: 8.5 },
        bodyStyles: { textColor: RGB.text, halign: "center", fontSize: 8.5, cellPadding: 5 },
        columnStyles: { 0: { halign: "left" } },
        alternateRowStyles: { fillColor: RGB.background },
        styles: { lineColor: RGB.border, lineWidth: 0.5 },
        didDrawPage: () => drawHeader("Quality Performance Breakdown (cont.)", "Analysis by Product Category")
    });

    // ============================================================
    // PAGE 3 — TOP FAILURE POINTS ANALYSIS
    // ============================================================
    doc.addPage();
    drawHeader("Quality Risk & Failure Analysis", "Top Flagged Inspection Criteria Across Facilities");

    let afterFailureChartY = CONTENT_TOP;
    if (failureChartImg) {
        doc.addImage(failureChartImg, "PNG", MARGIN, afterFailureChartY, chartW, chartH);
        afterFailureChartY += chartH + 14;
    } else {
        doc.setTextColor(...RGB.muted);
        doc.setFont("helvetica", "italic");
        doc.setFontSize(9);
        doc.text("No flagged or non-conforming criteria recorded.", MARGIN, afterFailureChartY + 14);
        afterFailureChartY += 28;
    }

    if (sortedCriteria.length) {
        doc.autoTable({
            startY: afterFailureChartY,
            margin: { left: MARGIN, right: MARGIN, top: CONTENT_TOP },
            head: [["Inspection Criteria", "Times Rejected", "Times Acceptable (Borderline)"]],
            body: sortedCriteria.map(([name, t]) => [name, t.rejected, t.acceptable]),
            theme: "grid",
            headStyles: { fillColor: RGB.primary, textColor: 255, fontStyle: "bold", halign: "center", fontSize: 8.5 },
            bodyStyles: { textColor: RGB.text, halign: "center", fontSize: 8.5, cellPadding: 5 },
            columnStyles: { 0: { halign: "left" } },
            alternateRowStyles: { fillColor: RGB.background },
            styles: { lineColor: RGB.border, lineWidth: 0.5 }
        });
    }

    // ============================================================
    // PAGE 4+ — SPOILAGE & DISPOSAL AUDIT LOG
    // ============================================================
    doc.addPage();
    const sortedSpoiled = [...spoiledRecords].sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

    doc.autoTable({
        startY: CONTENT_TOP,
        margin: { left: MARGIN, right: MARGIN, top: CONTENT_TOP },
        head: [["Batch ID", "Inspector", "Product", "Location", "Failed Criteria", "Remarks", "Score", "Disposal Status"]],
        body: sortedSpoiled.length
            ? sortedSpoiled.map(rec => {
                const isAutoDisposed = rec.overallStatus === "Rejected";
                const failedCriteria = (rec.criteria || [])
                    .filter(c => c.assessment === "Rejected" || c.assessment === "Acceptable")
                    .map(c => c.criteriaName).join(", ") || "—";
                const remarks = (rec.criteria || []).filter(c => c.remarks).map(c => c.remarks).join("; ") || "—";
                return [
                    rec.batchCode || "—", rec.inspectorName || "—", rec.productType || "—", rec.location || "—",
                    failedCriteria, remarks, rec.score ?? "—", isAutoDisposed ? "Auto-Disposed" : "Disposed"
                ];
              })
            : [["—", "—", "—", "—", "No spoiled or discarded batches recorded.", "—", "—", "—"]],
        theme: "grid",
        headStyles: { fillColor: RGB.primary, textColor: 255, fontStyle: "bold", halign: "center", fontSize: 8 },
        bodyStyles: { textColor: RGB.text, fontSize: 7.5, cellPadding: 4.5 },
        columnStyles: { 6: { halign: "center" }, 7: { halign: "center" } },
        alternateRowStyles: { fillColor: RGB.background },
        styles: { lineColor: RGB.border, lineWidth: 0.5 },
        didParseCell: (data) => {
            if (data.section === "body" && data.column.index === 7) {
                data.cell.styles.textColor = RGB.danger;
                data.cell.styles.fontStyle = "bold";
            }
        },
        didDrawPage: () => drawHeader("Spoilage & Waste Disposal Audit", "Detail Log of Non-Conforming & Discarded Batches")
    });

    doc.setTextColor(...RGB.muted);
    doc.setFont("helvetica", "italic");
    doc.setFontSize(8.5);
    doc.text(
        `Audit Summary: ${spoiledRecords.length} of ${total} total inspected batches were discarded (${spoilageRate.toFixed(1)}% spoilage rate).`,
        MARGIN, doc.lastAutoTable.finalY + 16
    );

    // ============================================================
    // PAGE N+ — ALL INSPECTION RECORDS
    // ============================================================
    doc.addPage();
    const statusColorMap = { "Passed": RGB.success, "With Issues": RGB.warning, "Rejected": RGB.danger };

    doc.autoTable({
        startY: CONTENT_TOP,
        margin: { left: MARGIN, right: MARGIN, top: CONTENT_TOP },
        head: [["Batch ID", "Inspector", "Location", "Category", "Product", "Criteria Assessment Details", "Score", "Status", "Disposal", "Date"]],
        body: records.map(rec => {
            const criteriaStr = (rec.criteria || [])
                .map(c => `${c.criteriaName}: ${c.assessment}${c.remarks ? ` (${c.remarks})` : ""}`)
                .join(" | ");
            const disposalLabel = rec.disposalStatus
                ? rec.disposalStatus.charAt(0).toUpperCase() + rec.disposalStatus.slice(1)
                : (rec.overallStatus === "Rejected" ? "Auto-Disposed" : "Pending");
            return [
                rec.batchCode || "—", rec.inspectorName || "—", rec.location || "—",
                rec.productCategory === "shrimp" ? "Shrimp" : "Fish", rec.productType || "—",
                criteriaStr || "—", rec.score ?? "—", rec.overallStatus || "—", disposalLabel, fmtDate(rec.createdAt)
            ];
        }),
        theme: "grid",
        headStyles: { fillColor: RGB.primary, textColor: 255, fontStyle: "bold", halign: "center", fontSize: 7.5 },
        bodyStyles: { textColor: RGB.text, fontSize: 7, cellPadding: 4 },
        columnStyles: {
            5: { cellWidth: 155 },
            6: { halign: "center" },
            7: { halign: "center" }
        },
        alternateRowStyles: { fillColor: RGB.background },
        styles: { lineColor: RGB.border, lineWidth: 0.5 },
        didParseCell: (data) => {
            if (data.section === "body" && data.column.index === 7) {
                const status = data.cell.raw;
                data.cell.styles.textColor = statusColorMap[status] || RGB.text;
                data.cell.styles.fontStyle = "bold";
            }
        },
        didDrawPage: () => drawHeader("Complete Inspection Registry", `Auditable Master Dataset (${records.length} Records)`)
    });

    // ---------- Footer on Every Page ----------
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);

        // Simple horizontal divider line
        doc.setDrawColor(...RGB.border);
        doc.line(MARGIN, pageH - 28, pageW - MARGIN, pageH - 28);

        // Gray footer text
        doc.setFontSize(7.5);
        doc.setTextColor(...RGB.muted);
        doc.setFont("helvetica", "normal");
        doc.text("AquaFRESH Quality Control Report", MARGIN, pageH - 16);
        doc.text(`Page ${i} of ${pageCount}`, pageW - MARGIN, pageH - 16, { align: "right" });
    }

    // ---------- Save Output File ----------
    const dateStr = new Date().toISOString().split("T")[0];
    doc.save(`AquaFRESH_QC_Report_${dateStr}.pdf`);
}


// ==========================
// Clear All Inspection Data
// ==========================
document.getElementById("clear-all-data-btn")
    .addEventListener("click", () => {
        document.getElementById("modal-clear-warning").classList.add("active");
        document.body.style.overflow = "hidden";
    });

document.getElementById("cancel-clear-btn")
    .addEventListener("click", () => {
        document.getElementById("modal-clear-warning").classList.remove("active");
        document.body.style.overflow = "";
    });

document.getElementById("confirm-clear-btn")
    .addEventListener("click", async () => {
        const confirmBtn = document.getElementById("confirm-clear-btn");
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';

        try {
            const snapshot  = await getDocs(collection(db, "inspections"));
            const deletions = snapshot.docs.map(d => deleteDoc(doc(db, "inspections", d.id)));
            await Promise.all(deletions);

            document.getElementById("modal-clear-warning").classList.remove("active");
            document.body.style.overflow = "";

            alert(`Successfully deleted ${snapshot.size} inspection record(s).`);
            await loadInspectionsToday();
            await loadInspectionsByStatus();

        } catch (error) {
            console.error("Error clearing inspection data:", error);
            alert("Failed to clear data. Check console for details.");
        } finally {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i> Yes, Delete All';
        }
    });


// ==========================
// Initial Load
// ==========================
window.addEventListener("DOMContentLoaded", async () => {
    await loadInspectionsToday();
    await loadInspectionsByStatus();

    // Auto-open modal if URL has ?modal=passed|issues|rejected
    const params   = new URLSearchParams(window.location.search);
    const modal    = params.get("modal");
    const action   = params.get("action");
    const modalMap = {
        "passed"   : "modal-passed",
        "issues"   : "modal-issues",
        "rejected" : "modal-rejected"
    };
    if (action === "new") {
        // Auto-open product chooser directly
        document.getElementById("modal-product-chooser")?.classList.add("active");
        document.body.style.overflow = "hidden";
    } else if (modal && modalMap[modal]) {
        const el = document.getElementById(modalMap[modal]);
        if (el) {
            el.classList.add("active");
            document.body.style.overflow = "hidden";
        }
    }
});


// ==========================
// For Disposal — Load & Mark
// Rejected = auto-disposed
// With Issues = dispose or continue
// ==========================
async function loadDisposalRecords() {
    const activeTab = document.querySelector(".disposal-tab.active")?.dataset?.dtab || "issues";

    try {
        const qIssues   = query(collection(db, "inspections"), where("overallStatus", "==", "With Issues"));
        const qRejected = query(collection(db, "inspections"), where("overallStatus", "==", "Rejected"));

        const [issuesSnap, rejectedSnap] = await Promise.all([
            getDocs(qIssues), getDocs(qRejected)
        ]);

        const issuesDocs   = [];
        const rejectedDocs = [];
        issuesSnap.forEach(d   => issuesDocs.push({ id: d.id, ...d.data() }));
        rejectedSnap.forEach(d => rejectedDocs.push({ id: d.id, ...d.data() }));

        // Badge = pending With Issues only (not yet disposed/continued)
        const pendingCount = issuesDocs.filter(d => !d.disposalStatus || d.disposalStatus === "pending").length;
        const badge      = document.getElementById("disposal-count-badge");
        const modalBadge = document.getElementById("modal-disposal-count");
        if (badge) {
            badge.textContent   = pendingCount;
            badge.style.display = pendingCount > 0 ? "flex" : "none";
        }
        if (modalBadge) modalBadge.textContent = pendingCount;

        // Build filtered list
        let filtered = [];
        const clearBtn = document.getElementById("clear-disposed-btn");

        if (activeTab === "issues") {
            // With Issues that are still pending
            filtered = issuesDocs.filter(d => !d.disposalStatus || d.disposalStatus === "pending");
            if (clearBtn) clearBtn.style.display = "none";
        } else if (activeTab === "disposed") {
            // Rejected (auto) + manually disposed With Issues — combined
            const manuallyDisposed = issuesDocs.filter(d => d.disposalStatus === "disposed");
            filtered = [...rejectedDocs, ...manuallyDisposed];
            if (clearBtn) clearBtn.style.display = filtered.length > 0 ? "inline-flex" : "none";
        }

        filtered.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));

        const tbody   = document.getElementById("disposal-body");
        const emptyEl = document.getElementById("disposal-empty");
        if (!tbody) return;
        tbody.innerHTML = "";

        if (filtered.length === 0) {
            if (emptyEl) emptyEl.style.display = "block";
            return;
        }
        if (emptyEl) emptyEl.style.display = "none";

        filtered.forEach(r => {
            const isRejected = r.overallStatus === "Rejected";
            const isDisposed = r.disposalStatus === "disposed";

            const detailCell = (r.criteria || [])
                .filter(c => c.assessment !== "Excellent")
                .map(c => c.criteriaName).join(", ") || "—";

            const statusBadge = isRejected
                ? `<span class="status disposed"><i class="fa-solid fa-ban"></i> Auto-Disposed</span>`
                : isDisposed
                ? `<span class="status disposed"><i class="fa-solid fa-check"></i> Disposed</span>`
                : `<span class="status warning"><i class="fa-solid fa-triangle-exclamation"></i> With Issues</span>`;

            const actionCell = (isRejected || isDisposed)
                ? `<span style="font-size:0.78rem;color:#64748B;">—</span>`
                : `<div style="display:flex;gap:6px;flex-wrap:wrap;">
                       <button class="mark-disposed-btn" data-id="${r.id}">
                           <i class="fa-solid fa-trash-can"></i> Dispose
                       </button>
                       <button class="mark-continue-btn" data-id="${r.id}">
                           <i class="fa-solid fa-arrow-rotate-right"></i> Continue
                       </button>
                   </div>`;

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><strong>${r.batchCode ?? "—"}</strong></td>
                <td>${r.inspectorName    ?? "—"}</td>
                <td>${r.productType      ?? "—"}</td>
                <td>${r.location         ?? "—"}</td>
                <td>${detailCell}</td>
                <td>${formatDate(r.createdAt)}</td>
                <td>${statusBadge}</td>
                <td>${actionCell}</td>
            `;
            tbody.appendChild(tr);
        });

        // Mark Disposed
        document.querySelectorAll(".mark-disposed-btn").forEach(btn => {
            btn.addEventListener("click", async () => {
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                try {
                    await updateDoc(doc(db, "inspections", btn.dataset.id), {
                        disposalStatus: "disposed",
                        disposedAt:     serverTimestamp()
                    });
                    await loadDisposalRecords();
                    await loadInspectionsByStatus();
                    await loadInspectionsToday();
                } catch (err) {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fa-solid fa-trash-can"></i> Dispose';
                }
            });
        });

        // Continue
        document.querySelectorAll(".mark-continue-btn").forEach(btn => {
            btn.addEventListener("click", async () => {
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                try {
                    await updateDoc(doc(db, "inspections", btn.dataset.id), {
                        disposalStatus: "continued",
                        continuedAt:    serverTimestamp()
                    });
                    await loadDisposalRecords();
                } catch (err) {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fa-solid fa-arrow-rotate-right"></i> Continue';
                }
            });
        });

    } catch (err) {
        console.error("Load disposal error:", err);
    }
}

// Clear disposed records
async function clearDisposedRecords() {
    if (!confirm("Remove all disposed records from the list? This cannot be undone.")) return;
    const btn = document.getElementById("clear-disposed-btn");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Clearing...'; }
    try {
        const allSnap = await getDocs(collection(db, "inspections"));
        const deletions = [];
        allSnap.forEach(d => {
            const data = d.data();
            if (
                data.overallStatus === "Rejected" ||
                data.disposalStatus === "disposed"
            ) {
                deletions.push(deleteDoc(doc(db, "inspections", d.id)));
            }
        });

        if (deletions.length === 0) {
            alert("No disposed records found to clear.");
            return;
        }

        await Promise.all(deletions);
        await loadDisposalRecords();
        await loadInspectionsByStatus();
        await loadInspectionsToday();
        alert(`Successfully cleared ${deletions.length} disposed record(s).`);
    } catch (err) {
        console.error("Clear disposed error:", err);
        alert("Failed to clear records. Check console for details.");
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-broom"></i> Clear Disposed Records'; }
    }
}

// Disposal tab switching & modal trigger
document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".disposal-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".disposal-tab").forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            loadDisposalRecords();
        });
    });
    document.getElementById("btn-for-disposal")?.addEventListener("click", loadDisposalRecords);
    document.getElementById("clear-disposed-btn")?.addEventListener("click", clearDisposedRecords);
    loadDisposalRecords();
});
