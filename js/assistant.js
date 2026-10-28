/**
 * Trợ lý POP-AI — gọi AI qua POP-AI Gateway (n8n), KHÔNG còn API key trong trình duyệt.
 *
 * - Key LLM chỉ nằm trong Credentials của n8n. Trình duyệt chỉ nhận một token sống ~5 phút
 *   (xem js/popai-gateway.js) và gửi câu hỏi tới n8n; n8n kiểm tra đăng nhập, giới hạn tần suất,
 *   hạn mức rồi mới gọi LLM và ghi log.
 * - System prompt, model, max_tokens do n8n quyết định. Trình duyệt chỉ gửi: câu hỏi, lịch sử ngắn
 *   và phần "dữ liệu học sinh" (đọc từ Firestore bằng uid của chính người đang đăng nhập).
 * - Lịch sử hội thoại vẫn lưu ở Realtime Database (assistantChats/{uid}/messages).
 */
import {
  auth, db, rtdb, onAuthStateChanged, toast,
  doc, getDoc, collection, query, orderBy, limit, getDocs,
  ref, push, get, rtdbQuery, limitToLast, rtdbServerTimestamp,
  todayKey, dateKeyOffset, effectiveUsageSeconds
} from "./firebase.js";
import { askGateway, prefetchToken, friendlyError } from "./popai-gateway.js";

const MAX_HISTORY_MESSAGES = 12;
const MAX_USER_MESSAGE_LEN = 1000;

const chatMessagesEl = document.getElementById("chatMessages");
const chatInputEl = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");

let currentUser = null;
onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) prefetchToken(); // xin sẵn token để lần chat đầu không phải chờ
});

function addBubble(role, text) {
  const wrap = document.createElement("div");
  wrap.className = "chat-msg " + role;
  const label = document.createElement("span");
  label.className = "chat-label";
  label.textContent = role === "user" ? "Bạn" : "Trợ lý POP-AI";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = text;
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  chatMessagesEl.appendChild(wrap);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  return bubble;
}

/**
 * Gom dữ liệu thật của học sinh (đọc trực tiếp từ Firestore bằng SDK client)
 * làm ngữ cảnh cho LLM — thay cho buildStudentContext() trước đây ở Cloud Function.
 */
async function buildStudentContext(uid) {
  const [planSnap, usageSnap, assessSnap, journalDocs] = await Promise.all([
    getDoc(doc(db, "plans", uid)),
    getDoc(doc(db, "usageData", uid, "daily", todayKey())),
    getDocs(query(collection(db, "assessments", uid, "entries"), orderBy("createdAt", "desc"), limit(1))),
    Promise.all(
      Array.from({ length: 7 }, (_, i) => getDoc(doc(db, "journals", uid, "entries", dateKeyOffset(-i))))
    )
  ]);

  const plan = planSnap.exists() ? planSnap.data() : null;
  const todayShortVideoMin = usageSnap.exists() ? Math.round(effectiveUsageSeconds(usageSnap.data()) / 60) : null;
  const assessment = assessSnap.empty ? null : assessSnap.docs[0].data();

  const journalLines = [];
  journalDocs.forEach((snap, i) => {
    if (!snap.exists()) return;
    const j = snap.data();
    journalLines.push(
      `- ${dateKeyOffset(-i)}: video ngắn ${j.shortVideoMin ?? "?"} phút, ` +
      `tập trung ${j.totalFocusMin ?? "?"} phút (${j.focusSessionsCompleted ?? 0} phiên), ` +
      `gián đoạn ${j.interruptions ?? 0} lần, hoàn thành nhiệm vụ ${j.taskCompletion ?? "?"}/5, ` +
      `cảm nhận tập trung ${j.feeling ?? "?"}/5` +
      (j.wentWell ? `. Điều tốt: "${String(j.wentWell).slice(0, 120)}"` : "") +
      (j.toImprove ? `. Cần cải thiện: "${String(j.toImprove).slice(0, 120)}"` : "")
    );
  });

  const parts = [];
  parts.push("=== DỮ LIỆU THẬT CỦA HỌC SINH NÀY (dùng để cá nhân hóa câu trả lời) ===");
  if (plan) {
    parts.push(
      `Kế hoạch hiện tại: mục tiêu giảm video ngắn xuống ${plan.targetShortVideoMin ?? "?"} phút/ngày ` +
      `(hiện đang ở mức ${plan.currentShortVideoMin ?? "?"} phút/ngày), ` +
      `${plan.sessionsPerDay ?? "?"} phiên tập trung ${plan.sessionLength ?? "?"} phút/phiên, ` +
      (plan.phoneFreeStart ? `không dùng điện thoại từ ${plan.phoneFreeStart} đến ${plan.phoneFreeEnd || "?"}, ` : "") +
      `nhiệm vụ quan trọng nhất: "${plan.topTask || "chưa ghi"}".`
    );
  } else {
    parts.push("Học sinh chưa lập kế hoạch trong mục Tối ưu hóa.");
  }
  if (todayShortVideoMin !== null) {
    parts.push(`Hôm nay đã xem video ngắn: ${todayShortVideoMin} phút (theo tiện ích trình duyệt).`);
  }
  if (assessment) {
    parts.push(`Lần tự đánh giá gần nhất: điểm ${assessment.score}/50, mức nguy cơ "${assessment.riskLevel}".`);
  }
  if (journalLines.length) {
    parts.push("Nhật ký gần đây (mới nhất trước):");
    parts.push(...journalLines);
  } else {
    parts.push("Chưa có nhật ký nào được ghi.");
  }

  return parts.join("\n");
}

// System prompt đã chuyển sang n8n (phía server) để học sinh không thể sửa/đọc được.

/** Lịch sử chat lưu ở Realtime Database: assistantChats/{uid}/messages/{pushId} */
function chatHistoryRef(uid) {
  return ref(rtdb, `assistantChats/${uid}/messages`);
}

async function loadHistory(uid) {
  const q = rtdbQuery(chatHistoryRef(uid), limitToLast(MAX_HISTORY_MESSAGES));
  const snap = await get(q);
  if (!snap.exists()) return [];
  const val = snap.val();
  // Realtime Database trả về object theo key push (đã theo thứ tự thời gian) — giữ nguyên thứ tự.
  return Object.values(val).map(m => ({ role: m.role, content: m.content }));
}

async function saveMessage(uid, role, content) {
  await push(chatHistoryRef(uid), { role, content, createdAt: rtdbServerTimestamp() });
}

async function sendChat() {
  const text = chatInputEl.value.trim();
  if (!text) return;
  if (!currentUser) { toast("Đang tải phiên đăng nhập, thử lại sau 1 giây."); return; }
  if (text.length > MAX_USER_MESSAGE_LEN) {
    toast(`Tin nhắn quá dài (tối đa ${MAX_USER_MESSAGE_LEN} ký tự).`);
    return;
  }

  const uid = currentUser.uid;
  addBubble("user", text);
  chatInputEl.value = "";
  autoGrow();
  chatSendBtn.disabled = true;
  const thinkingBubble = addBubble("assistant", "Đang suy nghĩ...");

  try {
    const [studentContext, history] = await Promise.all([
      buildStudentContext(uid),
      loadHistory(uid)
    ]);

    // n8n tự dựng system prompt + chọn model; ở đây chỉ gửi câu hỏi, lịch sử và dữ liệu học sinh.
    const replyText = await askGateway({ message: text, history, context: studentContext });

    thinkingBubble.textContent = replyText;

    // Lưu lại hội thoại vào Realtime Database để có ngữ cảnh cho lần hỏi sau.
    await saveMessage(uid, "user", text);
    await saveMessage(uid, "assistant", replyText);
  } catch (e) {
    console.error("POP-AI assistant error", e && e.code ? e.code : e);
    thinkingBubble.textContent = friendlyError(e);
  } finally {
    chatSendBtn.disabled = false;
  }
}

chatSendBtn.addEventListener("click", sendChat);
chatInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
function autoGrow() {
  chatInputEl.style.height = "auto";
  chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 140) + "px";
}
chatInputEl.addEventListener("input", autoGrow);
