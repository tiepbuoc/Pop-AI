import {
  auth, db, doc, getDoc, setDoc, serverTimestamp, signOut,
  onAuthStateChanged, toast
} from "./firebase.js";

const checkingState = document.getElementById("checkingState");
const deniedState = document.getElementById("deniedState");
const adminState = document.getElementById("adminState");

const currentCode = document.getElementById("currentCode");
const currentCodeMeta = document.getElementById("currentCodeMeta");
const copyCodeBtn = document.getElementById("copyCodeBtn");
const adminForm = document.getElementById("adminForm");
const newCodeInput = document.getElementById("newCode");
const genCodeBtn = document.getElementById("genCodeBtn");
const saveBtn = document.getElementById("saveBtn");
const adminError = document.getElementById("adminError");
const adminOk = document.getElementById("adminOk");
const logoutBtn = document.getElementById("logoutBtn");

const TEACHER_ACCESS_REF = () => doc(db, "config", "teacherAccess");

function showOnly(el) {
  [checkingState, deniedState, adminState].forEach(s => s.style.display = "none");
  el.style.display = "block";
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    deniedState.querySelector("p").textContent =
      "Bạn cần đăng nhập bằng một tài khoản giáo viên trước khi vào trang này.";
    showOnly(deniedState);
    return;
  }

  try {
    const userSnap = await getDoc(doc(db, "users", user.uid));
    const role = userSnap.exists() ? userSnap.data().role : null;

    if (role !== "teacher") {
      deniedState.querySelector("p").textContent =
        "Trang này chỉ dành cho tài khoản có vai trò giáo viên. Tài khoản hiện tại không có quyền này.";
      showOnly(deniedState);
      return;
    }

    await loadCurrentCode();
    showOnly(adminState);
  } catch (err) {
    console.error(err);
    deniedState.querySelector("p").textContent =
      "Không kiểm tra được quyền truy cập — vui lòng thử tải lại trang.";
    showOnly(deniedState);
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
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.uid || null
    });
    adminOk.textContent = "Đã lưu mã mới thành công.";
    newCodeInput.value = "";
    await loadCurrentCode();
    toast("Đã cập nhật mã xác thực giáo viên.");
  } catch (err) {
    console.error(err);
    adminError.textContent = "Lưu thất bại — kiểm tra lại firestore.rules đã cho phép giáo viên ghi vào config/teacherAccess chưa.";
  } finally {
    saveBtn.disabled = false;
  }
});

logoutBtn.addEventListener("click", async () => {
  await signOut(auth);
  window.location.href = "index.html";
});
