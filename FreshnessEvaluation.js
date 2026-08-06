import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

document.addEventListener("DOMContentLoaded", loadFreshnessData);

async function loadFreshnessData() {

  try {

    const q = query(
      collection(db, "inspections"),
      orderBy("createdAt", "desc")
    );

    const snapshot = await getDocs(q);

    const tbody      = document.getElementById("all-freshness-body");
    const freshBody  = document.getElementById("fresh-body");
    const issuesBody = document.getElementById("issues-body");
    const spoiledBody = document.getElementById("spoiled-body");

    if (tbody)      tbody.innerHTML      = "";
    if (freshBody)  freshBody.innerHTML  = "";
    if (issuesBody) issuesBody.innerHTML = "";
    if (spoiledBody) spoiledBody.innerHTML = "";

    let freshCount   = 0;
    let issuesCount  = 0;
    let spoiledCount = 0;

    if (snapshot.empty) {
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="4">No inspection data available</td></tr>`;
      }
      return;
    }

    snapshot.forEach(docSnap => {

      const d    = docSnap.data();
      const time = formatDate(d.createdAt);

      let statusHTML = "";
      let category   = "";

      if (d.overallStatus === "Passed") {
        statusHTML = `<span class="status fresh"><i class="fa-solid fa-check"></i> Fresh</span>`;
        category   = "fresh";
        freshCount++;
      }
      else if (d.overallStatus === "With Issues") {
        statusHTML = `<span class="status moderate"><i class="fa-solid fa-triangle-exclamation"></i> With Issues</span>`;
        category   = "issues";
        issuesCount++;
      }
      else {
        statusHTML = `<span class="status spoiled"><i class="fa-solid fa-circle-exclamation"></i> Spoiled</span>`;
        category   = "spoiled";
        spoiledCount++;
      }

      /* ── 4-column row — Batch ID, Location, Status, Last Updated ── */
      const row = `
        <tr
          data-batch="${(d.batchCode ?? "").toLowerCase()}"
          data-status="${d.overallStatus}"
        >
          <td><strong>${d.batchCode ?? "-"}</strong></td>
          <td>${d.location ?? "-"}</td>
          <td>${statusHTML}</td>
          <td>${time}</td>
        </tr>
      `;

      if (tbody)      tbody.innerHTML      += row;
      if (category === "fresh"   && freshBody)   freshBody.innerHTML   += row;
      if (category === "issues"  && issuesBody)  issuesBody.innerHTML  += row;
      if (category === "spoiled" && spoiledBody) spoiledBody.innerHTML += row;

    });

    document.getElementById("fresh-count").textContent   = freshCount;
    document.getElementById("issues-count").textContent  = issuesCount;
    document.getElementById("spoiled-count").textContent = spoiledCount;

    if (freshBody   && !freshBody.innerHTML)   freshBody.innerHTML   = `<tr><td colspan="4">No fresh records</td></tr>`;
    if (issuesBody  && !issuesBody.innerHTML)  issuesBody.innerHTML  = `<tr><td colspan="4">No issues records</td></tr>`;
    if (spoiledBody && !spoiledBody.innerHTML) spoiledBody.innerHTML = `<tr><td colspan="4">No spoiled records</td></tr>`;

  }
  catch (error) {
    console.error("Error loading freshness data:", error);
    const tbody = document.getElementById("all-freshness-body");
    if (tbody) tbody.innerHTML = `<tr><td colspan="4">Error loading data</td></tr>`;
  }

}

/* ================= SEARCH + FILTER ================= */

document.addEventListener("DOMContentLoaded", () => {

  const filterBtn   = document.getElementById("filterBtn");
  const dropdown    = document.getElementById("filterDropdown");
  const searchInput = document.getElementById("searchBatch");

  filterBtn?.addEventListener("click", () => {
    dropdown.classList.toggle("active");
  });

  searchInput?.addEventListener("input", applyFilters);

  document.getElementById("applyFilter")?.addEventListener("click", () => {
    applyFilters();
    dropdown.classList.remove("active");
  });

  document.getElementById("clearFilter")?.addEventListener("click", () => {
    document.getElementById("filterStatus").value = "";
    searchInput.value = "";
    applyFilters();
  });

});

function applyFilters() {

  const search = document.getElementById("searchBatch").value.toLowerCase();
  const status = document.getElementById("filterStatus").value;

  document.querySelectorAll("#all-freshness-body tr").forEach(row => {
    const rowBatch  = row.dataset.batch  || "";
    const rowStatus = row.dataset.status || "";
    const matchSearch = !search || rowBatch.includes(search);
    const matchStatus = !status || rowStatus === status;
    row.style.display = (matchSearch && matchStatus) ? "" : "none";
  });

}

/* ================= DATE FORMAT ================= */

function formatDate(timestamp) {
  if (!timestamp || !timestamp.toDate) return "--";
  return timestamp.toDate().toLocaleString("en-PH", {
    month  : "short",
    day    : "numeric",
    year   : "numeric",
    hour   : "numeric",
    minute : "2-digit",
    hour12 : true
  });
}