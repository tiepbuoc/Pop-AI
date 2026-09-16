import { FIREBASE_API_KEY, FIREBASE_PROJECT_ID } from "./firebase-config.js";

const TOKEN_BASE = "https://securetoken.googleapis.com/v1";
const IDENTITY_BASE = "https://identitytoolkit.googleapis.com/v1";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// Extension đăng nhập/đăng ký trực tiếp bằng email+password ngay trong popup,
// gọi thẳng Identity Toolkit REST API — không còn phụ thuộc web app hay
// externally_connectable/POPAI_EXTENSION_ID nữa.

function mapAuthError(message) {
  const map = {
    EMAIL_EXISTS: "Email này đã có tài khoản — hãy chọn \"Đăng nhập\" thay vì \"Đăng ký\".",
    EMAIL_NOT_FOUND: "Không tìm thấy tài khoản với email này — hãy chọn \"Đăng ký\" nếu chưa có tài khoản.",
    INVALID_PASSWORD: "Sai mật khẩu.",
    INVALID_LOGIN_CREDENTIALS: "Email hoặc mật khẩu không đúng.",
    USER_DISABLED: "Tài khoản này đã bị vô hiệu hoá.",
    TOO_MANY_ATTEMPTS_TRY_LATER: "Thử sai quá nhiều lần — vui lòng đợi một lát rồi thử lại.",
    INVALID_EMAIL: "Địa chỉ email không hợp lệ."
  };
  const key = (message || "").split(" : ")[0].trim();
  if (map[key]) return map[key];
  if (key.startsWith("WEAK_PASSWORD")) return "Mật khẩu cần ít nhất 6 ký tự.";
  return message || "Có lỗi xảy ra, vui lòng thử lại.";
}

function toSession(data) {
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + Number(data.expiresIn) * 1000,
    uid: data.localId,
    email: data.email || ""
  };
}

// Tạo tài khoản Firebase Auth mới bằng email/password (dùng khi học sinh cài
// tiện ích trước, chưa từng có tài khoản trên web app).
export async function signUpWithPassword(email, password) {
  const res = await fetch(`${IDENTITY_BASE}/accounts:signUp?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const data = await res.json();
  if (data.error) throw new Error(mapAuthError(data.error.message));
  return toSession(data);
}

// Đăng nhập bằng email/password đã có (dù tạo từ web app hay từ extension).
export async function signInWithPassword(email, password) {
  const res = await fetch(`${IDENTITY_BASE}/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const data = await res.json();
  if (data.error) throw new Error(mapAuthError(data.error.message));
  return toSession(data);
}

export async function refreshIdToken(refreshToken) {
  const res = await fetch(`${TOKEN_BASE}/token?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${refreshToken}`
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "Làm mới token thất bại");
  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
    uid: data.user_id
  };
}

function toFirestoreValue(v) {
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: v } : { doubleValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (v && typeof v === "object") {
    return { mapValue: { fields: toFirestoreFields(v) } };
  }
  return { stringValue: String(v) };
}
function toFirestoreFields(obj) {
  const fields = {};
  for (const k in obj) fields[k] = toFirestoreValue(obj[k]);
  return fields;
}

// Ghi đè toàn bộ document (dùng cho usageData hằng ngày — mỗi thiết bị là 1 nguồn ghi)
export async function overwriteDocument(idToken, path, dataObj) {
  const res = await fetch(`${FIRESTORE_BASE}/${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ fields: toFirestoreFields(dataObj) })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Firestore lỗi ${res.status}`);
  }
  return res.json();
}

function fromFirestoreValue(v) {
  if (!v) return null;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) return fromFirestoreFields(v.mapValue.fields || {});
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  return null;
}
function fromFirestoreFields(fields) {
  const out = {};
  for (const k in fields) out[k] = fromFirestoreValue(fields[k]);
  return out;
}

// Đọc một document — trả về object dữ liệu, hoặc null nếu không tồn tại
export async function getDocument(idToken, path) {
  const res = await fetch(`${FIRESTORE_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Firestore lỗi ${res.status}`);
  }
  const data = await res.json();
  return fromFirestoreFields(data.fields || {});
}

// Cập nhật một phần document (updateMask) — dùng khi không muốn ghi đè toàn bộ
export async function patchDocument(idToken, path, dataObj, maskFields) {
  const mask = maskFields.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
  const res = await fetch(`${FIRESTORE_BASE}/${path}?${mask}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ fields: toFirestoreFields(dataObj) })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Firestore lỗi ${res.status}`);
  }
  return res.json();
}
