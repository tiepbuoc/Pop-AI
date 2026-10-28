let mode = "login"; // "login" | "register"

const authTab = document.getElementById("authTab");
const authForm = document.getElementById("authForm");
const consentBox = document.getElementById("consentBox");
const submitBtn = document.getElementById("submitBtn");
const authError = document.getElementById("authError");
const statusMsg = document.getElementById("statusMsg");

consentBox.addEventListener("change", () => {
  submitBtn.disabled = !consentBox.checked;
});

authTab.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  [...authTab.children].forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  mode = btn.dataset.mode;
  submitBtn.textContent = mode === "register" ? "Tạo tài khoản" : "Đăng nhập";
  document.getElementById("password").autocomplete = mode === "register" ? "new-password" : "current-password";
  authError.textContent = "";
});

authForm.addEventListener("submit", (e) => {
  e.preventDefault();
  authError.textContent = "";
  submitBtn.disabled = true;

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const consent = consentBox.checked;

  chrome.runtime.sendMessage(
    { type: mode === "register" ? "REGISTER" : "LOGIN", email, password, consent },
    (res) => {
      submitBtn.disabled = !consentBox.checked;
      if (!res || !res.ok) {
        authError.textContent = (res && res.error) || "Có lỗi xảy ra, vui lòng thử lại.";
        return;
      }
      refreshView();
    }
  );
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "LOGOUT" }, () => refreshView());
});

// refresh = true: nền sẽ đọc lại mức chỉnh tay từ máy chủ (số nhập tay trong nhật ký web) trước khi trả số.
function refreshView(refresh = true) {
  chrome.runtime.sendMessage({ type: "GET_STATUS", refresh }, (res) => {
    if (res && res.loggedIn) {
      document.getElementById("loggedOutView").style.display = "none";
      document.getElementById("loggedInView").style.display = "block";
      document.getElementById("accountEmail").textContent = res.email || res.displayName || "";
      document.getElementById("todayMin").textContent = res.todayMinutes;
    } else {
      document.getElementById("loggedOutView").style.display = "block";
      document.getElementById("loggedInView").style.display = "none";
      statusMsg.textContent = "";
    }
  });
}

refreshView();

// Popup đang mở: cập nhật số phút mỗi 5 giây (không tốn truy vấn), và đọc lại từ máy chủ mỗi 30 giây
// để số nhập tay vừa lưu trên web cũng hiện lên.
let popupTicks = 0;
setInterval(() => {
  popupTicks++;
  refreshView(popupTicks % 6 === 0);
}, 5000);
