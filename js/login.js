import {
  auth, db, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile, doc, getDoc, setDoc,
  collection, query, where, getDocs, serverTimestamp, genStudentCode,
  toast, onAuthStateChanged, authErrorMessage
} from "./firebase.js";

let mode = "login"; // "login" | "register"
let selectedRole = "student";

const authTab = document.getElementById("authTab");
const roleToggle = document.getElementById("roleToggle");
const displayNameField = document.getElementById("displayNameField");
const studentJoinField = document.getElementById("studentJoinField");
const teacherCodeField = document.getElementById("teacherCodeField");
const authForm = document.getElementById("authForm");
const submitBtn = document.getElementById("submitBtn");
const authError = document.getElementById("authError");
const forgotPasswordBtn = document.getElementById("forgotPasswordBtn");

// Nếu đã đăng nhập sẵn (phiên trước chưa đăng xuất), điều hướng luôn
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  const snap = await getDoc(doc(db, "users", user.uid));
  if (snap.exists()) redirectByRole(snap.data().role);
});

authTab.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (!btn) return;
  [...authTab.children].forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  mode = btn.dataset.mode;
  applyModeUI();
});

roleToggle.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-role]");
  if (!btn) return;
  [...roleToggle.children].forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  selectedRole = btn.dataset.role;
  applyModeUI();
});

function applyModeUI() {
  const isRegister = mode === "register";
  displayNameField.style.display = isRegister ? "block" : "none";
  roleToggle.style.display = isRegister ? "flex" : "none";
  studentJoinField.style.display = isRegister && selectedRole === "student" ? "block" : "none";
  teacherCodeField.style.display = isRegister && selectedRole === "teacher" ? "block" : "none";
  submitBtn.textContent = isRegister ? "Tạo tài khoản" : "Đăng nhập";
  document.getElementById("password").autocomplete = isRegister ? "new-password" : "current-password";
  authError.textContent = "";
}
applyModeUI();

forgotPasswordBtn.addEventListener("click", async () => {
  const email = document.getElementById("email").value.trim();
  if (!email) {
    authError.textContent = "Nhập email ở trên trước, rồi bấm lại \"Quên mật khẩu?\".";
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    toast("Đã gửi email đặt lại mật khẩu — kiểm tra hộp thư của bạn.");
  } catch (err) {
    authError.textContent = authErrorMessage(err);
  }
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.textContent = "";
  submitBtn.disabled = true;

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  try {
    if (mode === "register") {
      await handleRegister(email, password);
    } else {
      await handleLogin(email, password);
    }
  } catch (err) {
    console.error(err);
    authError.textContent = authErrorMessage(err);
  } finally {
    submitBtn.disabled = false;
  }
});

async function handleRegister(email, password) {
  const displayName = document.getElementById("displayName").value.trim();

  if (selectedRole === "teacher") {
    const code = document.getElementById("teacherCode").value.trim();
    const ok = await verifyTeacherCode(code);
    if (!ok) {
      authError.textContent = "Mã xác thực giáo viên không đúng.";
      return;
    }
  }

  const cred = await createUserWithEmailAndPassword(auth, email, password);
  const user = cred.user;
  if (displayName) await updateProfile(user, { displayName }).catch(() => {});
  const userRef = doc(db, "users", user.uid);

  if (selectedRole === "teacher") {
    await setDoc(userRef, {
      role: "teacher",
      displayName: displayName || "",
      email,
      createdAt: serverTimestamp()
    });
    redirectByRole("teacher");
    return;
  }

  // Học sinh
  let classId = null;
  const joinCode = document.getElementById("joinCode").value.trim().toUpperCase();
  if (joinCode) {
    const q = query(collection(db, "classes"), where("joinCode", "==", joinCode));
    const res = await getDocs(q);
    if (!res.empty) classId = res.docs[0].id;
    else toast("Không tìm thấy mã lớp — bạn vẫn có thể tham gia lớp sau trong phần Cài đặt.");
  }

  const studentCode = genStudentCode();
  await setDoc(userRef, {
    role: "student",
    displayName: displayName || "",
    email,
    studentCode,
    classId,
    createdAt: serverTimestamp()
  });

  if (classId) {
    await setDoc(doc(db, "classes", classId, "students", user.uid), {
      studentCode,
      joinedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }

  redirectByRole("student");
}

async function handleLogin(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  const user = cred.user;
  const userRef = doc(db, "users", user.uid);
  const snap = await getDoc(userRef);

  if (snap.exists()) {
    redirectByRole(snap.data().role);
    return;
  }

  // Trường hợp hiếm: tài khoản Auth đã tồn tại (VD: tạo từ tiện ích trình duyệt)
  // nhưng chưa có hồ sơ users/{uid} — tự tạo hồ sơ học sinh mặc định.
  await setDoc(userRef, {
    role: "student",
    displayName: user.displayName || "",
    email,
    studentCode: genStudentCode(),
    classId: null,
    createdAt: serverTimestamp()
  });
  redirectByRole("student");
}

async function verifyTeacherCode(code) {
  if (!code) return false;
  try {
    // Mã kiểu cũ (1 mã duy nhất, đặt tay ở Firestore config/teacherAccess) — giữ để tương thích ngược
    const legacySnap = await getDoc(doc(db, "config", "teacherAccess"));
    if (legacySnap.exists() && legacySnap.data().code === code) return true;

    // Nhiều mã cùng hiệu lực, quản lý qua admin.html
    const q = query(collection(db, "teacherAccessCodes"), where("code", "==", code));
    const res = await getDocs(q);
    return !res.empty;
  } catch {
    return false;
  }
}

function redirectByRole(role) {
  window.location.href = role === "teacher" ? "teacher.html" : "app.html";
}
