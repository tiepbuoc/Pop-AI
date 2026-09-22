import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile, signOut, onAuthStateChanged,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, collection, addDoc, query,
  where, orderBy, limit, getDocs, serverTimestamp, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getDatabase, ref, push, get, query as rtdbQuery, limitToLast, serverTimestamp as rtdbServerTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const rtdb = getDatabase(app); // Realtime Database — dùng cho lịch sử chat Trợ lý AI

export {
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile, signOut, onAuthStateChanged,
  signInAnonymously,
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, addDoc, query,
  where, orderBy, limit, getDocs, serverTimestamp, onSnapshot,
  ref, push, get, rtdbQuery, limitToLast, rtdbServerTimestamp
};

// Dịch mã lỗi Firebase Auth sang tiếng Việt dễ hiểu cho người dùng cuối
export function authErrorMessage(err) {
  const code = err?.code || "";
  const map = {
    "auth/email-already-in-use": "Email này đã có tài khoản — hãy chọn \"Đăng nhập\" thay vì \"Đăng ký\".",
    "auth/invalid-email": "Địa chỉ email không hợp lệ.",
    "auth/weak-password": "Mật khẩu cần ít nhất 6 ký tự.",
    "auth/wrong-password": "Sai mật khẩu.",
    "auth/user-not-found": "Không tìm thấy tài khoản với email này — hãy chọn \"Đăng ký\" nếu chưa có tài khoản.",
    "auth/invalid-credential": "Email hoặc mật khẩu không đúng.",
    "auth/too-many-requests": "Bạn thử sai quá nhiều lần — vui lòng đợi một lát rồi thử lại.",
    "auth/missing-password": "Vui lòng nhập mật khẩu."
  };
  return map[code] || (err?.message || "Có lỗi xảy ra, vui lòng thử lại.");
}

// ---- Helpers dùng chung ----
export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function dateKeyOffset(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return todayKey(d);
}

export function genStudentCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "HS-";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export function genJoinCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export function toast(msg) {
  let el = document.getElementById("app-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "app-toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2600);
}
