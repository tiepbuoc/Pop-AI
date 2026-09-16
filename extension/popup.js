const consentBox = document.getElementById("consentBox");
const loginBtn = document.getElementById("loginBtn");
const statusMsg = document.getElementById("statusMsg");

consentBox.addEventListener("change", () => {
  loginBtn.disabled = !consentBox.checked;
});

loginBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "OPEN_LOGIN_PAGE" }, () => {
    statusMsg.textContent = "Đã mở trang đăng nhập ở tab mới. Đăng nhập xong ở đó, rồi mở lại biểu tượng tiện ích này để tiếp tục.";
  });
});

document.getElementById("logoutBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "LOGOUT" }, () => refreshView());
});

function refreshView() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
    if (res && res.loggedIn) {
      document.getElementById("loggedOutView").style.display = "none";
      document.getElementById("loggedInView").style.display = "block";
      document.getElementById("accountEmail").textContent = res.email || res.displayName || "";
      document.getElementById("todayMin").textContent = res.todayMinutes;
    } else {
      document.getElementById("loggedOutView").style.display = "block";
      document.getElementById("loggedInView").style.display = "none";
    }
  });
}

refreshView();
