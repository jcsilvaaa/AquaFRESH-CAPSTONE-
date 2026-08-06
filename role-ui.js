document.addEventListener("DOMContentLoaded", () => {
    const role      = localStorage.getItem("role");
    const roleLabel = document.getElementById("userRoleLabel");

    if (!role) return;

    /* ── Display name in topbar ── */
    if (roleLabel) {
        const roleMap = {
            superadmin : "Super Admin",
            admin      : "Admin",
            manager    : "Manager",
            inspector  : "Inspector",
            delivery   : "Delivery Staff",
            customer   : "Customer"
        };
        roleLabel.textContent = roleMap[role] || "User";
    }

    /* ── Hide Trends section for delivery role ── */
    if (role === "delivery") {
        const trendsSection = document.getElementById("trendsPanelSection");
        if (trendsSection) trendsSection.style.display = "none";
    }

    /* ── Redirect customer away from non-customer pages ──
       If a customer somehow lands on an admin/staff page,
       redirect them to their own dashboard.
    ── */
    if (role === "customer") {
        const allowedPages = ["CustomerDashboard.html", "Profile.html", "Login.html"];
        const currentPage  = window.location.pathname.split("/").pop();
        if (!allowedPages.includes(currentPage)) {
            window.location.href = "CustomerDashboard.html";
        }
    }
});