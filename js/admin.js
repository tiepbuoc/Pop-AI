import {
  auth, db, doc, getDoc, setDoc, serverTimestamp, signOut,
  signInAnonymously, toast
} from "./firebase.js";

// Mật khẩu quản trị — LƯU Ý: nằm trong mã nguồn client (site tĩnh, không có backend
// riêng), nên đây chỉ là khoá chống lỡ tay/tò mò, KHÔNG phải bảo mật thật. Ai xem được
// file này (View Source / DevTools) đều đọc được mật khẩu.
const ADMIN_PASSWORD = "nhat1234";

const passwordState = document.getElementById("passwordState");
const adminState = document.getElementById("adminState");
const passwordForm = document.getElementById("passwordForm");
const adminPassword = document.getElementById("adminPassword");
const passwordError = document.getElementById("passwordError");
const unlockBtn = document.getElementById("unlockBtn");

const currentCode = document.getElementById("currentCode");
const currentCodeMeta = document.getElementById("currentCodeMeta");
const copyCodeBtn = document.getElementById("copyCodeBtn");
const adminForm = document.getElementById("adminForm");
const newCodeInput = document.getElementById("newCode");
const genCodeBtn = document.getElementById("genCodeBtn");
const saveBtn = document.getElementById("saveBtn");
const adminError = document.getElementById("adminError");
const adminOk = document.getElementById("adminOk");
const lockBtn = document.getElementById("lockBtn");

const TEACHER_ACCESS_REF = () => doc(db, "config", "teacherAccess");

function showAdmin() {
  passwordState.style.display = "none";
  adminState.style.display = "block";
}
function showPassword() {
  adminState.style.display = "none";
  passwordState.style.display = "block";
  adminPassword.value = "";
  adminPassword.focus();
}

passwordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  passwordError.textContent = "";

  if (adminPassword.value !== ADMIN_PASSWORD) {
    passwordError.textContent = "Sai mật khẩu.";
    return;
  }

  unlockBtn.disabled = true;
  try {
    // Cần một phiên đăng nhập (kể cả ẩn danh) để thoả điều kiện Firestore rules.
    if (!auth.currentUser) {
      await signInAnonymously(auth);
    }
    await loadCurrentCode();
    showAdmin();
  } catch (err) {
    console.error(err);
    passwordError.textContent =
      "Không đăng nhập được — kiểm tra đã bật \"Anonymous\" ở Firebase Console → Authentication → Sign-in method chưa.";
  } finally {
    unlockBtn.disabled = false;
  }
});

async function loadCurrentCode() {
  const snap = await getDoc(TEACHER_ACCESS_REF());
  if (snap.exists() && snap.data().code) {
    currentCode.textContent = snap.data().code;
    const updatedAt = snap.data().updatedAt?.toDate?.();
    currentCodeMeta.textContent = updatedAt
      ? `Cập nhật lần cuối: ${updatedAt.toLocaleString("vi-VN")}`
      : "";
  } else {
    currentCode.textContent = "(chưa đặt)";
    currentCodeMeta.textContent = "Chưa có mã nào — nhập mã mới bên dưới để tạo lần đầu.";
  }
}

copyCodeBtn.addEventListener("click", async () => {
  const text = currentCode.textContent.trim();
  if (!text || text === "—" || text === "(chưa đặt)") return;
  try {
    await navigator.clipboard.writeText(text);
    toast("Đã sao chép mã.");
  } catch {
    toast("Không sao chép được — hãy chọn và copy thủ công.");
  }
});

genCodeBtn.addEventListener("click", () => {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const year = new Date().getFullYear();
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  newCodeInput.value = `GV${year}-${suffix}`;
});

adminForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  adminError.textContent = "";
  adminOk.textContent = "";

  const code = newCodeInput.value.trim();
  if (!code) {
    adminError.textContent = "Vui lòng nhập mã mới.";
    return;
  }

  saveBtn.disabled = true;
  try {
    await setDoc(TEACHER_ACCESS_REF(), {
      code,
      updatedAt: serverTimestamp()
    });
    adminOk.textContent = "Đã lưu mã mới thành công.";
    newCodeInput.value = "";
    await loadCurrentCode();
    toast("Đã cập nhật mã xác thực giáo viên.");
  } catch (err) {
    console.error(err);
    adminError.textContent = "Lưu thất bại — kiểm tra lại firestore.rules đã cho phép ghi vào config/teacherAccess chưa.";
  } finally {
    saveBtn.disabled = false;
  }
});

lockBtn.addEventListener("click", async () => {
  await signOut(auth);
  showPassword();
});
