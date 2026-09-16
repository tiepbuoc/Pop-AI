import {
  refreshIdToken, overwriteDocument, patchDocument, getDocument,
  signInWithPassword, signUpWithPassword
} from "./firebase-rest.js";
import { APP_URL } from "./config.js";

function genStudentCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "HS-";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

const HEARTBEAT_ALARM = "pop-ai-heartbeat";
const HEARTBEAT_MINUTES = 1; // Chrome không cho phép alarm lặp lại dưới 1 phút trong bản đóng gói chính thức
const IDLE_THRESHOLD_SEC = 15;
const META_REFRESH_EVERY_TICKS = 15; // đọc lại kế hoạch/lớp học mỗi ~15 phút (đủ mới cho demo, tiết kiệm read)

const SOURCE_MATCHERS = [
  { source: "youtube", label: "YouTube Shorts", test: (u) => /^https:\/\/(www\.|m\.)?youtube\.com\/shorts\//.test(u) },
  { source: "tiktok", label: "TikTok", test: (u) => /^https:\/\/(www\.|vm\.)?tiktok\.com\//.test(u) },
  { source: "instagram", label: "Instagram Reels", test: (u) => /^https:\/\/(www\.)?instagram\.com\/(reel|reels|stories)\//.test(u) },
  { source: "facebook", label: "Facebook Reels", test: (u) => /^https:\/\/(www\.|m\.)?facebook\.com\/(reel|watch)/.test(u) }
];

function classifyUrl(url) {
  if (!url) return null;
  for (const m of SOURCE_MATCHERS) if (m.test(url)) return m;
  return null;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) tick();
});

async function getAuthSession() {
  const { authSession } = await chrome.storage.local.get("authSession");
  return authSession || null;
}
async function setAuthSession(session) {
  await chrome.storage.local.set({ authSession: session });
}
async function clearAuthSession() {
  await chrome.storage.local.remove("authSession");
}

async function getValidIdToken() {
  let session = await getAuthSession();
  if (!session || !session.consentGiven) return null;
  if (Date.now() > session.expiresAt - 60000) {
    try {
      const refreshed = await refreshIdToken(session.refreshToken);
      session = { ...session, ...refreshed };
      await setAuthSession(session);
    } catch (e) {
      console.warn("POP-AI: không thể làm mới token, cần đăng nhập lại.", e);
      return null;
    }
  }
  return session;
}

// ---------------------------------------------------------------
// Đọc kế hoạch (ngưỡng mục tiêu) + lớp học của học sinh — dùng cho
// (2) friction nudge và (3) dashboard trực tiếp của giáo viên.
// ---------------------------------------------------------------
let tickCount = 0;

async function refreshStudentMeta(session) {
  try {
    const [userDoc, planDoc] = await Promise.all([
      getDocument(session.idToken, `users/${session.uid}`),
      getDocument(session.idToken, `plans/${session.uid}`)
    ]);
    const meta = {
      classId: userDoc?.classId ?? null,
      studentCode: userDoc?.studentCode ?? null,
      planTargetMin: planDoc?.targetShortVideoMin ?? null
    };
    const updated = { ...session, ...meta, metaFetchedAt: Date.now() };
    await setAuthSession(updated);
    return updated;
  } catch (e) {
    console.warn("POP-AI: không đọc được kế hoạch/lớp học, dùng dữ liệu cũ.", e);
    return session;
  }
}

async function tick() {
  tickCount++;
  let session = await getAuthSession();
  if (!session || !session.consentGiven) return; // Chưa đăng nhập / chưa đồng ý -> không theo dõi gì cả

  if (!session.metaFetchedAt || tickCount % META_REFRESH_EVERY_TICKS === 0) {
    const valid = await getValidIdToken();
    if (valid) session = await refreshStudentMeta(valid);
  }

  const isActive = await new Promise((resolve) => chrome.idle.queryState(IDLE_THRESHOLD_SEC, resolve));
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const win = tab ? await chrome.windows.get(tab.windowId).catch(() => null) : null;
  const windowOk = !!(tab && win && win.focused && win.state !== "minimized");

  if (isActive !== "active" || !windowOk) {
    await pushLiveStatus(session, "idle", null);
    return;
  }

  const match = classifyUrl(tab.url);

  if (!match) {
    await pushLiveStatus(session, "other", null);
    return;
  }

  // (3) Dashboard trực tiếp: báo ngay là đang xem nền tảng giải trí nào
  await pushLiveStatus(session, "entertainment", match);

  await addSeconds(match.source, HEARTBEAT_MINUTES * 60);
  await syncToday();
  await maybeTriggerFriction(session, tab.id, match);
}

async function addSeconds(source, seconds) {
  const key = todayKey();
  const { usageByDate = {} } = await chrome.storage.local.get("usageByDate");
  const day = usageByDate[key] || { total: 0, bySource: { youtube: 0, tiktok: 0, instagram: 0, facebook: 0 } };
  day.total += seconds;
  day.bySource[source] = (day.bySource[source] || 0) + seconds;
  usageByDate[key] = day;
  await chrome.storage.local.set({ usageByDate });
  return day;
}

async function syncToday() {
  const session = await getValidIdToken();
  if (!session) return;
  const key = todayKey();
  const { usageByDate = {} } = await chrome.storage.local.get("usageByDate");
  const day = usageByDate[key];
  if (!day) return;

  try {
    await overwriteDocument(session.idToken, `usageData/${session.uid}/daily/${key}`, {
      totalSeconds: day.total,
      bySource: day.bySource,
      updatedAt: new Date()
    });
  } catch (e) {
    console.warn("POP-AI: đồng bộ Firestore thất bại, sẽ thử lại ở lượt sau.", e);
  }
}

// ---------------------------------------------------------------
// (2) Behavioral friction — can thiệp đúng khoảnh khắc vượt ngưỡng
// ---------------------------------------------------------------
async function maybeTriggerFriction(session, tabId, match) {
  if (!session.planTargetMin || session.planTargetMin <= 0) return; // chưa có kế hoạch -> không có ngưỡng để so
  const key = todayKey();
  const { usageByDate = {} } = await chrome.storage.local.get("usageByDate");
  const totalMinutes = Math.round((usageByDate[key]?.total || 0) / 60);
  if (totalMinutes < session.planTargetMin) return;

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "FRICTION_SHOW",
      minutes: totalMinutes,
      target: session.planTargetMin,
      appUrl: APP_URL
    });
  } catch (e) {
    // content script có thể chưa sẵn sàng (trang vừa mở) — bỏ qua, lượt sau thử lại
  }
}

// ---------------------------------------------------------------
// (3) Dashboard trực tiếp cho giáo viên — ghi trạng thái hiện tại,
// KHÔNG ghi URL cụ thể khi không phải trang giải trí (bảo vệ riêng tư).
// ---------------------------------------------------------------
async function pushLiveStatus(session, status, match) {
  const valid = await getValidIdToken();
  if (!valid || !valid.classId) return; // chưa tham gia lớp -> giáo viên không cần thấy

  try {
    await overwriteDocument(valid.idToken, `liveStatus/${valid.uid}`, {
      classId: valid.classId,
      studentCode: valid.studentCode || "",
      status, // "entertainment" | "other" | "idle"
      source: match ? match.source : null,
      sourceLabel: match ? match.label : null,
      updatedAt: new Date()
    });
  } catch (e) {
    console.warn("POP-AI: không đẩy được trạng thái trực tiếp.", e);
  }
}

// ---------------------------------------------------------------
// Đăng nhập/Đăng ký trực tiếp trong popup bằng email+password — không
// còn phụ thuộc web app, externally_connectable hay POPAI_EXTENSION_ID.
// ---------------------------------------------------------------
function buildSession(authResult, consent) {
  return {
    uid: authResult.uid,
    idToken: authResult.idToken,
    refreshToken: authResult.refreshToken,
    // Firebase ID token sống 1 giờ; trừ hao 5 phút để chủ động làm mới sớm.
    expiresAt: Date.now() + 55 * 60 * 1000,
    email: authResult.email || "",
    displayName: "",
    consentGiven: !!consent,
    consentAt: Date.now()
  };
}

async function createDefaultStudentDoc(session, email) {
  // overwriteDocument (không dùng updateMask) thay toàn bộ nội dung document,
  // nên trackerConnectedAt phải nằm chung trong lần ghi này, không patch riêng trước đó.
  await overwriteDocument(session.idToken, `users/${session.uid}`, {
    role: "student",
    displayName: "",
    email,
    studentCode: genStudentCode(),
    classId: null,
    createdAt: new Date(),
    trackerConnectedAt: new Date()
  });
}

async function handleRegister(email, password, consent) {
  const authResult = await signUpWithPassword(email, password);
  let session = buildSession(authResult, consent);
  await setAuthSession(session);
  // Tài khoản Auth vừa tạo -> chưa có hồ sơ users/{uid}, tự tạo hồ sơ học sinh mặc định
  // (giáo viên và tham gia lớp vẫn làm trên web app; ở đây chỉ phục vụ đăng ký nhanh
  // để tiện ích có thể theo dõi ngay).
  await createDefaultStudentDoc(session, email).catch((e) => console.warn("POP-AI: không tạo được hồ sơ học sinh.", e));
  session = await refreshStudentMeta(session);
  return session;
}

async function handleLogin(email, password, consent) {
  const authResult = await signInWithPassword(email, password);
  let session = buildSession(authResult, consent);
  await setAuthSession(session);

  // Nếu tài khoản Auth có sẵn nhưng chưa có hồ sơ users/{uid} (hiếm), tạo hồ sơ mặc định;
  // nếu đã có hồ sơ (đăng ký từ web app hoặc lần trước), chỉ đánh dấu đã kết nối tiện ích.
  const userDoc = await getDocument(session.idToken, `users/${session.uid}`).catch(() => null);
  if (!userDoc) {
    await createDefaultStudentDoc(session, email).catch(() => {});
  } else {
    await patchDocument(session.idToken, `users/${session.uid}`, { trackerConnectedAt: new Date() }, ["trackerConnectedAt"]).catch(() => {});
  }
  session = await refreshStudentMeta(session);
  return session;
}

// ---- Nhắn tin từ popup ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "LOGIN") {
      try {
        const session = await handleLogin(msg.email, msg.password, msg.consent);
        sendResponse({ ok: true, email: session.email });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    }

    if (msg.type === "REGISTER") {
      try {
        const session = await handleRegister(msg.email, msg.password, msg.consent);
        sendResponse({ ok: true, email: session.email });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    }

    if (msg.type === "LOGOUT") {
      await clearAuthSession();
      sendResponse({ ok: true });
    }

    if (msg.type === "GET_STATUS") {
      const session = await getAuthSession();
      const { usageByDate = {} } = await chrome.storage.local.get("usageByDate");
      const todaySeconds = (usageByDate[todayKey()] || { total: 0 }).total;
      sendResponse({
        loggedIn: !!session,
        email: session?.email,
        displayName: session?.displayName,
        todayMinutes: Math.round(todaySeconds / 60),
        planTargetMin: session?.planTargetMin ?? null
      });
    }
  })();
  return true; // giữ kênh mở cho sendResponse bất đồng bộ
});
