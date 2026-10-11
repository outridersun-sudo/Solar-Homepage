
document.addEventListener("DOMContentLoaded", () => {
  const path = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".nav a").forEach(a => {
    const href = a.getAttribute("href");
    if (href === path) a.classList.add("active");
  });

  const q = document.querySelector("#searchInput");
  if (q) {
    q.addEventListener("input", () => {
      const keyword = q.value.trim().toLowerCase();
      document.querySelectorAll("[data-search]").forEach(row => {
        row.style.display = row.dataset.search.toLowerCase().includes(keyword) ? "" : "none";
      });
    });
  }
});
