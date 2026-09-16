// Ẩn/hiện thanh bên (sidebar) dạng drawer trên di động.
// Trên desktop, sidebar luôn hiển thị nên các thao tác dưới đây không có tác dụng gì (CSS đã ẩn nút bấm).
const sidebar = document.querySelector(".sidebar");
const backdrop = document.getElementById("sidebarBackdrop");
const openBtn = document.getElementById("sidebarToggleBtn");
const closeBtn = document.getElementById("sidebarCloseBtn");

function openSidebar() {
  sidebar?.classList.add("open");
  backdrop?.classList.add("show");
  openBtn?.setAttribute("aria-expanded", "true");
}

function closeSidebar() {
  sidebar?.classList.remove("open");
  backdrop?.classList.remove("show");
  openBtn?.setAttribute("aria-expanded", "false");
}

openBtn?.addEventListener("click", () => {
  sidebar?.classList.contains("open") ? closeSidebar() : openSidebar();
});
closeBtn?.addEventListener("click", closeSidebar);
backdrop?.addEventListener("click", closeSidebar);

// Đóng lại ngay khi chọn một mục điều hướng trong sidebar
sidebar?.addEventListener("click", (e) => {
  if (e.target.closest("[data-page]")) closeSidebar();
});

// Đóng lại nếu người dùng xoay ngang/mở rộng cửa sổ qua breakpoint desktop
window.addEventListener("resize", () => {
  if (window.innerWidth > 860) closeSidebar();
});
