/**
 * Trợ lý POP-AI — chạy HOÀN TOÀN TRÊN CLIENT (không dùng Cloud Functions).
 *
 * ⚠️ CHỈ DÙNG ĐỂ TEST: API key nằm thẳng trong file này nên bất kỳ ai mở
 * DevTools/View Source đều lấy được. Trước khi đưa cho học sinh dùng thật,
 * hãy đổi key khác (thu hồi key test này) và cân nhắc giấu key qua backend.
 *
 * Việc "cá nhân hóa" (đọc kế hoạch/nhật ký/tự đánh giá của đúng học sinh) giờ
 * đọc thẳng từ Firestore bằng SDK ở trình duyệt, dựa trên uid của người đang
 * đăng nhập (firestore.rules vẫn chặn không cho đọc dữ liệu người khác).
 * Lịch sử hội thoại được lưu ở Realtime Database (assistantChats/{uid}/messages).
 */
import {
  auth, db, rtdb, onAuthStateChanged, toast,
  doc, getDoc, collection, query, orderBy, limit, getDocs,
  ref, push, get, rtdbQuery, limitToLast, rtdbServerTimestamp,
  todayKey, dateKeyOffset
} from "./firebase.js";

// ---- Cấu hình LLM (test only — xem cảnh báo ở đầu file) ----
const API_URL = "https://api.shopaikey.com/v1/chat/completions";
const MODEL = "gpt-5-mini";
const API_KEY = "sk-4150297863e3eee405805e8609648e6c5cebb1b502ffb46e"; // test only — nhớ thu hồi key này sau khi test xong

const MAX_HISTORY_MESSAGES = 12;
const MAX_USER_MESSAGE_LEN = 1000;

const chatMessagesEl = document.getElementById("chatMessages");
const chatInputEl = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");

let currentUser = null;
onAuthStateChanged(auth, (user) => { currentUser = user; });

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
  const todayShortVideoMin = usageSnap.exists() ? Math.round((usageSnap.data().totalSeconds || 0) / 60) : null;
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

const SYSTEM_PROMPT = `Bạn là "Trợ lý POP-AI" — một người hướng dẫn đồng hành thân thiện cho học sinh THPT/THCS
trong chương trình POP-AI (Prevent - Optimize - Perform), giúp các em giảm thói quen xem video ngắn
(TikTok/Shorts/Reels) và rèn khả năng tập trung học tập.

Nguyên tắc trả lời:
- Luôn dựa vào DỮ LIỆU THẬT của đúng học sinh được cung cấp bên dưới — không đưa lời khuyên chung chung,
  không bịa số liệu không có trong dữ liệu.
- Giọng văn: gần gũi, khích lệ, không phán xét, không giáo điều. Coi học sinh là người đang cố gắng,
  không phải người đang thất bại.
- Đưa ra tối đa 1-2 gợi ý HÀNH ĐỘNG CỤ THỂ, khả thi trong ngày hôm nay hoặc ngày mai — không liệt kê
  danh sách dài lý thuyết.
- Nếu số liệu cho thấy học sinh đang tiến bộ, hãy công nhận điều đó trước khi góp ý thêm.
- Nếu học sinh hỏi ngoài phạm vi (bài tập môn học, chuyện cá nhân không liên quan), vẫn trả lời tử tế
  và ngắn gọn, rồi nhẹ nhàng lái về mục tiêu tập trung/giảm lướt nếu phù hợp.
- Không đưa ra chẩn đoán y khoa/tâm lý. Đây là công cụ giáo dục, không thay thế chuyên gia.
- Trả lời bằng tiếng Việt, độ dài khoảng 3-6 câu trừ khi học sinh yêu cầu chi tiết hơn.`;

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

    const messages = [
      { role: "system", content: SYSTEM_PROMPT + "\n\n" + studentContext },
      ...history,
      { role: "user", content: text }
    ];

    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({ model: MODEL, messages, temperature: 0.7, max_tokens: 1500 })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("POP-AI LLM lỗi HTTP", res.status, errText);
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    console.log("POP-AI LLM raw response:", JSON.stringify(data, null, 2)); // TODO: bỏ dòng này khi hết debug

    const choice = data.choices?.[0];
    const replyText =
      choice?.message?.content?.trim() ||
      choice?.text?.trim() || // vài API tương thích cũ trả về "text" thay vì "message.content"
      "";

    if (!replyText) {
      console.error("POP-AI: completion rỗng. finish_reason =", choice?.finish_reason, "| full choice:", choice);
      throw new Error(
        choice?.finish_reason === "length"
          ? "hết token trước khi trả lời xong (tăng max_tokens)"
          : "empty completion"
      );
    }

    thinkingBubble.textContent = replyText;

    // Lưu lại hội thoại vào Realtime Database để có ngữ cảnh cho lần hỏi sau.
    await saveMessage(uid, "user", text);
    await saveMessage(uid, "assistant", replyText);
  } catch (e) {
    console.error("POP-AI assistant error", e);
    thinkingBubble.textContent = "Xin lỗi, trợ lý đang gặp sự cố (" + (e.message || "lỗi không rõ") + "). Thử lại sau nhé.";
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
