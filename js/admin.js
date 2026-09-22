import {
  auth, db, doc, getDoc, deleteDoc, collection, addDoc, getDocs, orderBy, query,
  serverTimestamp, signOut, signInAnonymously, toast
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

const codesList = document.getElementById("codesList");
const legacyCodeBlock = document.getElementById("legacyCodeBlock");
const legacyCode = document.getElementById("legacyCode");
const deleteLegacyBtn = document.getElementById("deleteLegacyBtn");

const addForm = document.getElementById("addForm");
const newLabel = document.getElementById("newLabel");
const newCodeInput = document.getElementById("newCode");
const genCodeBtn = document.getElementById("genCodeBtn");
const addBtn = document.getElementById("addBtn");
const adminError = document.getElementById("adminError");
const adminOk = document.getElementById("adminOk");
const lockBtn = document.getElementById("lockBtn");

const CODES_COLLECTION = () => collection(db, "teacherAccessCodes");
const LEGACY_REF = () => doc(db, "config", "teacherAccess");

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
    if (!auth.currentUser) {
      await signInAnonymously(auth);
    }
    await loadAll();
    showAdmin();
  } catch (err) {
    console.error(err);
    passwordError.textContent =
      "Không đăng nhập được — kiểm tra đã bật \"Anonymous\" ở Firebase Console → Authentication → Sign-in method chưa.";
  } finally {
    unlockBtn.disabled = false;
  }
});

async function loadAll() {
  await Promise.all([loadCodes(), loadLegacy()]);
}

async function loadCodes() {
  codesList.innerHTML = `<p class="muted">Đang tải…</p>`;
  try {
    const q = query(CODES_COLLECTION(), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);

    if (snap.empty) {
      codesList.innerHTML = `<p class="muted">Chưa có mã nào — thêm mã đầu tiên bên dưới.</p>`;
      return;
    }

    codesList.innerHTML = "";
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      const row = document.createElement("div");
      row.className = "admin-code-row";
      const createdAt = data.createdAt?.toDate?.();
      const meta = [
        data.label ? data.label : null,
        createdAt ? createdAt.toLocaleDateString("vi-VN") : null
      ].filter(Boolean).join(" · ");

      row.innerHTML = `
        <div style="flex:1;min-width:0;">
          <code>${escapeHtml(data.code)}</code>
          ${meta ? `<div class="muted" style="margin-top:2px;">${escapeHtml(meta)}</div>` : ""}
        </div>
        <button type="button" class="btn btn-ghost btn-sm admin-copy-btn" data-code="${escapeHtml(data.code)}">Sao chép</button>
        <button type="button" class="btn btn-ghost btn-sm admin-danger-btn" data-id="${docSnap.id}">Xoá</button>
      `;
      codesList.appendChild(row);
    });

    codesList.querySelectorAll(".admin-copy-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(btn.dataset.code);
          toast("Đã sao chép mã.");
        } catch {
          toast("Không sao chép được — hãy chọn và copy thủ công.");
        }
      });
    });

    codesList.querySelectorAll(".admin-danger-btn[data-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Xoá mã này? Mã sẽ không đăng ký được nữa.")) return;
        try {
          await deleteDoc(doc(db, "teacherAccessCodes", btn.dataset.id));
          toast("Đã xoá mã.");
          await loadCodes();
        } catch (err) {
          console.error(err);
          toast("Xoá thất bại.");
        }
      });
    });
  } catch (err) {
    console.error(err);
    codesList.innerHTML = `<p class="muted">Không tải được danh sách mã.</p>`;
  }
}

async function loadLegacy() {
  const snap = await getDoc(LEGACY_REF());
  if (snap.exists() && snap.data().code) {
    legacyCode.textContent = snap.data().code;
    legacyCodeBlock.style.display = "block";
  } else {
    legacyCodeBlock.style.display = "none";
  }
}

deleteLegacyBtn.addEventListener("click", async () => {
  if (!confirm("Xoá mã kiểu cũ này? Mã sẽ không đăng ký được nữa.")) return;
  try {
    await deleteDoc(LEGACY_REF());
    toast("Đã xoá mã kiểu cũ.");
    await loadLegacy();
  } catch (err) {
    console.error(err);
    toast("Xoá thất bại.");
  }
});

genCodeBtn.addEventListener("click", () => {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const year = new Date().getFullYear();
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  newCodeInput.value = `GV${year}-${suffix}`;
});

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  adminError.textContent = "";
  adminOk.textContent = "";

  const code = newCodeInput.value.trim();
  const label = newLabel.value.trim();
  if (!code) {
    adminError.textContent = "Vui lòng nhập mã.";
    return;
  }

  addBtn.disabled = true;
  try {
    await addDoc(CODES_COLLECTION(), {
      code,
      label: label || null,
      createdAt: serverTimestamp()
    });
    adminOk.textContent = "Đã thêm mã mới.";
    newCodeInput.value = "";
    newLabel.value = "";
    await loadCodes();
    toast("Đã thêm mã xác thực giáo viên.");
  } catch (err) {
    console.error(err);
    adminError.textContent = "Thêm thất bại — kiểm tra lại firestore.rules đã cho phép ghi vào teacherAccessCodes chưa.";
  } finally {
    addBtn.disabled = false;
  }
});

lockBtn.addEventListener("click", async () => {
  await signOut(auth);
  showPassword();
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
