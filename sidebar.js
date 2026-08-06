document.addEventListener("DOMContentLoaded", () => {

    // ── Menu button (hamburger) ───────────────────────────────────────
    // This MUST be set up regardless of role, so the sidebar works
    // on every page even if role hasn't loaded yet.
    // ─────────────────────────────────────────────────────────────────
    const navToggle = document.getElementById("nav-toggle");
    const menuBtn   = document.querySelector(".menu-btn");

    if (menuBtn && navToggle) {
        menuBtn.addEventListener("click", (e) => {
            if (window.innerWidth > 768) {
                // Desktop: prevent label toggling checkbox, use collapsed class instead
                e.preventDefault();
                navToggle.checked = false;
                document.querySelector(".sidebar")?.classList.toggle("collapsed");
                document.querySelector(".topbar")?.classList.toggle("collapsed");
                document.querySelector(".content")?.classList.toggle("collapsed");
            }
            // Mobile: do NOT preventDefault — let label toggle checkbox naturally
        });
    }

    // Close sidebar when a nav link is tapped on mobile
    document.querySelectorAll(".menu li a").forEach(link => {
        link.addEventListener("click", () => {
            if (window.innerWidth <= 768 && navToggle) {
                navToggle.checked = false;
            }
        });
    });

    // ── Role-based nav visibility ─────────────────────────────────────
    const role = localStorage.getItem("role");
    if (!role) return;

    document.querySelectorAll(".menu li[data-role]").forEach(item => {
        const allowedRoles = item.dataset.role.split(" ");
        if (allowedRoles.includes(role)) {
            item.style.display = "block";
        }
    });
});