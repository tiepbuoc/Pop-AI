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

// ---------------------------------------------------------------
// Cơ chế đo thời gian: EVENT-DRIVEN, không polling.
// Thay vì hỏi "bây giờ có đang xem không" mỗi phút, ta lắng nghe trực
// tiếp các sự kiện Chrome cung cấp sẵn (đổi audible, đổi tab, đổi
// focus cửa sổ, đổi trạng thái idle) — mỗi khi có sự kiện, tính lại
// xem điều kiện "đang xem giải trí" vừa BẮT ĐẦU hay KẾT THÚC, rồi
// cộng đúng khoảng thời gian thực đã trôi qua (mili-giây).
//
// "Đang xem giải trí" = URL khớp danh sách nền tảng AND (
//     tab đang audible (có tiếng, kể cả đang ở tab nền)
//     HOẶC
//     tab đang active + cửa sổ đang focus + người dùng không idle
//     (bắt được cả trường hợp video tự phát tắt tiếng nhưng học sinh
//      đang thực sự nhìn vào tab đó)
// )
//
// Vẫn giữ alarm 1 phút (HEARTBEAT_ALARM) — nhưng KHÔNG dùng để phát
// hiện đang xem nữa, chỉ dùng để: (a) đồng bộ Firestore + dashboard
// trực tiếp mỗi phút như cũ, (b) "chốt sổ" phiên đang mở (nếu có) để
// giới hạn thiệt hại tối đa của một lần gián đoạn bất thường (máy
// sleep, service worker bị Chrome tắt giữa chừng) xuống còn ~1 phút
// thay vì cộng/mất nguyên khoảng thời gian gián đoạn đó.
// ---------------------------------------------------------------

const HEARTBEAT_ALARM = "pop-ai-heartbeat";
const HEARTBEAT_MINUTES = 1; // Chrome không cho phép alarm lặp lại dưới 1 phút trong bản đóng gói chính thức
const IDLE_THRESHOLD_SEC = 15;
const META_REFRESH_EVERY_TICKS = 15; // đọc lại kế hoạch/lớp học mỗi ~15 phút (đủ mới cho demo, tiết kiệm read)
const MAX_SEGMENT_MS = 90 * 1000; // trần cho mỗi lần cộng dồn — chặn cộng sai khi có gián đoạn dài bất thường

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

chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SEC);

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
  reconcile();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MINUTES });
  reconcile();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) onHeartbeat();
});

// Các sự kiện kích hoạt tính lại trạng thái "đang xem"
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if ("audible" in changeInfo || "url" in changeInfo || "status" in changeInfo) reconcile();
});
chrome.tabs.onActivated.addListener(() => reconcile());
chrome.tabs.onRemoved.addListener(() => reconcile());
chrome.windows.onFocusChanged.addListener(() => reconcile());
chrome.idle.onStateChanged.addListener(() => reconcile());

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
// Phiên "đang xem" hiện tại (nếu có) — persist vào storage.local để
// sống sót qua việc service worker bị Chrome tắt/khởi động lại giữa
// chừng (không được giữ trong biến RAM thường, sẽ mất khi SW restart).
// ---------------------------------------------------------------
async function getViewSession() {
  const { viewSession } = await chrome.storage.local.get("viewSession");
  return viewSession || null;
}
async function setViewSession(vs) {
  await chrome.storage.local.set({ viewSession: vs });
}
async function clearViewSession() {
  await chrome.storage.local.remove("viewSession");
}

async function getFocusedActiveTab() {
  const windows = await chrome.windows.getAll({ populate: false });
  const focusedWin = windows.find((w) => w.focused && w.state !== "minimized");
  if (!focusedWin) return null;
  const [activeTab] = await chrome.tabs.query({ active: true, windowId: focusedWin.id });
  return activeTab || null;
}

// Quét toàn bộ tab đang mở, xác định có tab nào đang "được xem giải
// trí" không, và nếu có nhiều tab đồng thời khớp thì ưu tiên tab đang
// active+focus (nơi học sinh thực sự đang nhìn vào) hơn tab audible ở nền.
async function computeQualifyingTab() {
  const [allTabs, focusedActiveTab, idleState] = await Promise.all([
    chrome.tabs.query({}),
    getFocusedActiveTab(),
    new Promise((resolve) => chrome.idle.queryState(IDLE_THRESHOLD_SEC, resolve))
  ]);
  const userPresent = idleState === "active";

  let activeMatch = null;
  let audibleMatch = null;

  for (const tab of allTabs) {
    const match = classifyUrl(tab.url);
    if (!match) continue;
    if (!activeMatch && userPresent && focusedActiveTab && tab.id === focusedActiveTab.id) {
      activeMatch = match;
    }
    if (!audibleMatch && tab.audible) {
      audibleMatch = match;
    }
  }

  const chosen = activeMatch || audibleMatch;
  return chosen ? { qualifies: true, source: chosen.source, label: chosen.label } : { qualifies: false };
}

// ---------------------------------------------------------------
// Vòng lặp reconcile — chạy mỗi khi có sự kiện liên quan, có khoá đơn
// giản (reconciling/pendingReconcile) để tránh chạy chồng lấn khi
// nhiều sự kiện bắn gần như đồng thời.
// ---------------------------------------------------------------
let reconciling = false;
let pendingReconcile = false;

async function reconcile() {
  if (reconciling) {
    pendingReconcile = true;
    return;
  }
  reconciling = true;
  try {
    await doReconcile();
  } catch (e) {
    console.warn("POP-AI: lỗi khi reconcile trạng thái xem.", e);
  } finally {
    reconciling = false;
    if (pendingReconcile) {
      pendingReconcile = false;
      reconcile();
    }
  }
}

async function doReconcile() {
  const session = await getAuthSession();
  if (!session || !session.consentGiven) {
    await clearViewSession(); // chưa đăng nhập / chưa đồng ý -> không theo dõi gì cả
    return;
  }

  const result = await computeQualifyingTab();
  const now = Date.now();
  const vs = await getViewSession();

  if (result.qualifies) {
    if (!vs) {
      // Bắt đầu một phiên xem mới
      await setViewSession({ startedAt: now, source: result.source, label: result.label });
    } else if (vs.source !== result.source) {
      // Đổi từ nền tảng này sang nền tảng khác -> chốt phiên cũ, mở phiên mới
      await commitSegment(vs, now);
      await setViewSession({ startedAt: now, source: result.source, label: result.label });
    }
    // Nếu vẫn cùng nguồn -> phiên đang chạy tiếp, không làm gì (chưa chốt sổ)

    await pushLiveStatus(session, "entertainment", { source: result.source, label: result.label });
    await checkFrictionNow(session);
  } else {
    if (vs) {
      // Vừa rời khỏi điều kiện "đang xem" -> chốt sổ phiên vừa rồi
      await commitSegment(vs, now);
      await clearViewSession();
      await syncToday(); // đồng bộ ngay khi kết thúc phiên, không đợi alarm phút sau
    }
    const idleState = await new Promise((resolve) => chrome.idle.queryState(IDLE_THRESHOLD_SEC, resolve));
    await pushLiveStatus(session, idleState === "active" ? "other" : "idle", null);
  }
}

// Cộng khoảng thời gian đã trôi qua của một phiên vào tổng hôm nay.
// Trần MAX_SEGMENT_MS chặn trường hợp gián đoạn dài bất thường (máy
// sleep, service worker bị Chrome tắt lâu) bị tính nhầm thành thời
// gian xem thực.
async function commitSegment(vs, now) {
  const elapsedMs = Math.min(Math.max(now - vs.startedAt, 0), MAX_SEGMENT_MS);
  if (elapsedMs <= 0) return;
  await addSeconds(vs.source, elapsedMs / 1000);
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
      totalSeconds: Math.round(day.total),
      bySource: Object.fromEntries(Object.entries(day.bySource).map(([k, v]) => [k, Math.round(v)])),
      updatedAt: new Date()
    });
  } catch (e) {
    console.warn("POP-AI: đồng bộ Firestore thất bại, sẽ thử lại ở lượt sau.", e);
  }
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

async function onHeartbeat() {
  tickCount++;
  let session = await getAuthSession();
  if (!session || !session.consentGiven) return;

  if (!session.metaFetchedAt || tickCount % META_REFRESH_EVERY_TICKS === 0) {
    const valid = await getValidIdToken();
    if (valid) session = await refreshStudentMeta(valid);
  }

  // Chốt sổ định kỳ cho phiên đang mở (nếu có sự kiện nào đó đang "treo"
  // lâu không kết thúc, ví dụ video nền phát liên tục nhiều phút không
  // đổi trạng thái) — vừa để dashboard/Firestore có số liệu tươi mỗi
  // phút, vừa giới hạn rủi ro nếu service worker bị kill giữa chừng.
  const vs = await getViewSession();
  if (vs) {
    const now = Date.now();
    await commitSegment(vs, now);
    await setViewSession({ ...vs, startedAt: now });
  }

  await syncToday();
  await checkFrictionNow(session);
}

// ---------------------------------------------------------------
// (2) Behavioral friction — can thiệp đúng khoảnh khắc vượt ngưỡng
// ---------------------------------------------------------------
async function checkFrictionNow(session) {
  if (!session.planTargetMin || session.planTargetMin <= 0) return; // chưa có kế hoạch -> không có ngưỡng để so
  const key = todayKey();
  const { usageByDate = {} } = await chrome.storage.local.get("usageByDate");
  const totalMinutes = Math.round((usageByDate[key]?.total || 0) / 60);
  if (totalMinutes < session.planTargetMin) return;

  // Chỉ hiện overlay trên tab mà học sinh đang thực sự nhìn vào
  const activeTab = await getFocusedActiveTab();
  if (!activeTab) return;
  const match = classifyUrl(activeTab.url);
  if (!match) return;

  try {
    await chrome.tabs.sendMessage(activeTab.id, {
      type: "FRICTION_SHOW",
      minutes: totalMinutes,
      target: session.planTargetMin,
      appUrl: APP_URL
    });
  } catch (e) {
    // content script có thể chưa sẵn sàng (trang vừa mở) — bỏ qua, lần sau thử lại
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
        reconcile(); // bắt trạng thái ngay, không đợi sự kiện tab tiếp theo
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    }

    if (msg.type === "REGISTER") {
      try {
        const session = await handleRegister(msg.email, msg.password, msg.consent);
        sendResponse({ ok: true, email: session.email });
        reconcile();
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    }

    if (msg.type === "LOGOUT") {
      await clearAuthSession();
      await clearViewSession();
      sendResponse({ ok: true });
    }

    if (msg.type === "GET_STATUS") {
      const session = await getAuthSession();
      const { usageByDate = {} } = await chrome.storage.local.get("usageByDate");
      const vs = await getViewSession();
      // Cộng thêm phần của phiên đang mở (chưa chốt sổ) để popup hiển thị số liệu tươi,
      // không đợi tới lần commit/sync tiếp theo.
      const openElapsedSec = vs ? Math.min(Date.now() - vs.startedAt, MAX_SEGMENT_MS) / 1000 : 0;
      const todaySeconds = (usageByDate[todayKey()] || { total: 0 }).total + openElapsedSec;
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
