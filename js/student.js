import {
  auth, db, signOut, onAuthStateChanged, doc, getDoc, setDoc, updateDoc,
  collection, addDoc, query, orderBy, limit, getDocs, where, serverTimestamp,
  onSnapshot, runTransaction,
  todayKey, dateKeyOffset, toast, effectiveUsageSeconds, usageWrittenByTracker
} from "./firebase.js";

let currentUser = null;
let userData = null;
let currentPlan = null;

// ---------------------------------------------------------------
// AUTH GUARD
// ---------------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "index.html"; return; }
  const snap = await getDoc(doc(db, "users", user.uid));
  if (!snap.exists() || snap.data().role !== "student") {
    window.location.href = "index.html";
    return;
  }
  currentUser = user;
  userData = snap.data();
  initUserChrome();
  await Promise.all([loadToday(), loadPlan(), loadTrackerStatus(), loadClassInfo()]);
  buildAssessmentForm();
  openFocusTimerIfRequested();
  evaluateAdaptiveGoal();
  watchTodayUsage();
});

// Được mở từ overlay "friction" của tiện ích trình duyệt (mục "can thiệp đúng khoảnh khắc")
function openFocusTimerIfRequested() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("focus") !== "1") return;
  gotoPage("optimize");
  document.querySelector('#optimizeTabs [data-tab="timer"]')?.click();
  window.history.replaceState({}, "", window.location.pathname);
}

document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth));

function initUserChrome() {
  const name = userData.displayName || currentUser.email || "Học sinh";
  document.getElementById("userName").textContent = name;
  document.getElementById("userInitial").textContent = name.charAt(0).toUpperCase();
  document.getElementById("myStudentCode").textContent = userData.studentCode || "—";
  const hour = new Date().getHours();
  document.getElementById("todayGreeting").textContent =
    hour < 11 ? "Chào buổi sáng" : hour < 18 ? "Chào buổi chiều" : "Chào buổi tối";
}

// ---------------------------------------------------------------
// NAVIGATION
// ---------------------------------------------------------------
function gotoPage(name) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.getElementById("page-" + name).classList.add("active");
  document.querySelectorAll("#sideNav .nav-item").forEach(b => b.classList.toggle("active", b.dataset.page === name));
  document.querySelectorAll("#bottomNav button").forEach(b => b.classList.toggle("active", b.dataset.page === name));
  if (name === "perform") refreshReportIfVisible();
  if (name === "settings") loadTrackerStatus(); // tiện ích có thể vừa được đăng nhập sau khi trang đã mở
}
document.getElementById("sideNav").addEventListener("click", e => {
  const btn = e.target.closest("[data-page]"); if (btn) gotoPage(btn.dataset.page);
});
document.getElementById("bottomNav").addEventListener("click", e => {
  const btn = e.target.closest("[data-page]"); if (btn) gotoPage(btn.dataset.page);
});
document.querySelectorAll("[data-goto]").forEach(el => {
  el.addEventListener("click", () => gotoPage(el.dataset.goto));
});

function wireSubTabs(containerId, tabPrefix) {
  document.getElementById(containerId).addEventListener("click", e => {
    const btn = e.target.closest("[data-tab]"); if (!btn) return;
    const group = document.getElementById(containerId);
    [...group.children].forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    group.parentElement.querySelectorAll(`[id^="${tabPrefix}"]`).forEach(el => el.style.display = "none");
    document.getElementById(tabPrefix + btn.dataset.tab).style.display = "block";
    if (tabPrefix === "tab-" && btn.dataset.tab === "report") refreshReportIfVisible();
  });
}
wireSubTabs("preventTabs", "tab-");
wireSubTabs("optimizeTabs", "tab-");
wireSubTabs("performTabs", "tab-");
document.querySelectorAll("[data-tab-switch]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelector(`#preventTabs [data-tab="${btn.dataset.tabSwitch}"]`).click();
  });
});

// ---------------------------------------------------------------
// TODAY
// ---------------------------------------------------------------
// Thời gian xem video ngắn hôm nay — MỘT con số dùng chung cho web và tiện ích:
//   = số tiện ích tự đo + mức chỉnh tay từ nhật ký (xem effectiveUsageSeconds ở firebase.js).
// Nhật ký đã lưu từ trước khi có cơ chế đồng bộ (không có mức chỉnh tay) vẫn được giữ lại nhờ lấy số lớn hơn.
let todayUsageData = null;   // usageData hôm nay (null nếu chưa có)
let todayJournaledMin = 0;   // số phút ghi trong nhật ký hôm nay

function renderShortVideoStat() {
  const effectiveMin = Math.round(effectiveUsageSeconds(todayUsageData) / 60);
  document.getElementById("statShortVideo").textContent = Math.max(effectiveMin, todayJournaledMin) + "'";
}

// Nghe trực tiếp usageData hôm nay: tiện ích đo thêm phút nào là trang Hôm nay tự cập nhật,
// không cần tải lại trang.
let stopWatchingUsage = null;
function watchTodayUsage() {
  if (stopWatchingUsage || !currentUser) return;
  stopWatchingUsage = onSnapshot(
    doc(db, "usageData", currentUser.uid, "daily", todayKey()),
    (snap) => {
      todayUsageData = snap.exists() ? snap.data() : null;
      renderShortVideoStat();
    },
    (e) => console.warn("POP-AI: không theo dõi trực tiếp được số phút hôm nay.", e)
  );
}

async function loadToday() {
  const key = todayKey();
  const [usageSnap, todayJournalSnap] = await Promise.all([
    getDoc(doc(db, "usageData", currentUser.uid, "daily", key)),
    getDoc(doc(db, "journals", currentUser.uid, "entries", key))
  ]);

  todayUsageData = usageSnap.exists() ? usageSnap.data() : null;
  todayJournaledMin = todayJournalSnap.exists() ? (Number(todayJournalSnap.data().shortVideoMin) || 0) : 0;
  renderShortVideoStat();

  const sessionsQ = query(collection(db, "focusSessions", currentUser.uid, "entries"), where("dateKey", "==", key));
  const sessionsSnap = await getDocs(sessionsQ);
  document.getElementById("statFocusSessions").textContent = sessionsSnap.size;
  document.getElementById("timerCompletedCount").textContent = sessionsSnap.size;

  // Chuỗi ngày liên tục có nhật ký.
  // - Hôm nay đã có nhật ký: đếm từ hôm nay lùi về trước.
  // - Hôm nay chưa ghi: đếm từ hôm qua (chuỗi chưa đứt, vì hôm nay vẫn còn thời gian để ghi).
  const journaledToday = todayJournalSnap.exists();
  let streak = journaledToday ? 1 : 0;
  for (let i = 1; i < 30; i++) {
    const k = dateKeyOffset(-i);
    const jSnap = await getDoc(doc(db, "journals", currentUser.uid, "entries", k));
    if (jSnap.exists()) streak++; else break;
  }
  document.getElementById("statStreak").textContent = streak;

  // "Ngày X / 7": đã ghi nhật ký hôm nay thì hôm nay chính là ngày thứ `streak`;
  // chưa ghi thì hôm nay là ngày kế tiếp (streak + 1).
  const dayNumber = Math.min(Math.max(journaledToday ? streak : streak + 1, 1), 7);
  document.getElementById("todayDay").textContent = `Ngày ${dayNumber} / 7`;
  document.getElementById("weekProgressLabel").textContent = `${Math.min(streak, 7)}/7 ngày`;
  document.getElementById("weekProgressFill").style.width = `${Math.min(streak, 7) / 7 * 100}%`;
}

// ---------------------------------------------------------------
// PREVENT — SELF ASSESSMENT
// ---------------------------------------------------------------
const QUESTIONS = [
  "Tôi xem video ngắn (TikTok, Shorts, Reels) hơn 2 tiếng mỗi ngày.",
  "Tôi xem video ngắn ngay khi vừa thức dậy hoặc trước khi ngủ.",
  "Tôi lướt qua nhiều video chỉ trong vài giây nếu thấy không hấp dẫn.",
  "Tôi khó xem hết một video dài quá 5 phút.",
  "Tôi kiểm tra điện thoại nhiều lần trong một giờ học.",
  "Tôi cầm điện thoại lên mà không có lý do cụ thể.",
  "Tôi khó tập trung vào một nhiệm vụ học tập quá 20 phút.",
  "Tôi cảm thấy bồn chồn khi không có điện thoại bên cạnh.",
  "Tôi trì hoãn việc học để xem thêm video ngắn.",
  "Tôi thức khuya hơn dự định vì xem video ngắn."
];
const LIKERT = ["Không bao giờ", "Hiếm khi", "Thỉnh thoảng", "Thường xuyên", "Rất thường xuyên"];

function buildAssessmentForm() {
  const form = document.getElementById("assessForm");
  form.innerHTML = QUESTIONS.map((q, qi) => `
    <div class="q-block">
      <div class="q-title">${qi + 1}. ${q}</div>
      <div class="likert">
        ${LIKERT.map((label, li) => `
          <label>
            <input type="radio" name="q${qi}" value="${li + 1}" ${li === 0 ? "" : ""}>
            <span>${label}</span>
          </label>`).join("")}
      </div>
    </div>
  `).join("");
}

document.getElementById("submitAssessBtn").addEventListener("click", async () => {
  const answers = [];
  for (let i = 0; i < QUESTIONS.length; i++) {
    const checked = document.querySelector(`input[name="q${i}"]:checked`);
    if (!checked) { toast(`Bạn chưa trả lời câu ${i + 1}.`); return; }
    answers.push(Number(checked.value));
  }
  const score = answers.reduce((a, b) => a + b, 0);
  const riskLevel = score <= 20 ? "Thấp" : score <= 35 ? "Trung bình" : "Cao";
  const badgeClass = score <= 20 ? "badge-low" : score <= 35 ? "badge-mid" : "badge-high";

  const advice = riskLevel === "Cao"
    ? "Bạn nên bắt đầu với mục tiêu nhỏ: giảm 20–30 phút video ngắn mỗi ngày và thử một phiên tập trung 15 phút."
    : riskLevel === "Trung bình"
    ? "Một vài thói quen đang ảnh hưởng đến sự tập trung của bạn — thử đặt khung giờ không dùng điện thoại vào buổi tối."
    : "Bạn đang kiểm soát khá tốt — hãy duy trì và thử nâng độ khó của phiên tập trung.";

  document.getElementById("assessScore").textContent = score;
  const badge = document.getElementById("assessBadge");
  badge.textContent = "Nguy cơ " + riskLevel;
  badge.className = "badge " + badgeClass;
  document.getElementById("assessAdvice").textContent = advice;
  document.getElementById("assessResult").style.display = "block";

  await addDoc(collection(db, "assessments", currentUser.uid, "entries"), {
    answers, score, riskLevel, createdAt: serverTimestamp()
  });

  if (userData.classId) {
    const classRef = doc(db, "classes", userData.classId, "students", currentUser.uid);
    const existing = await getDoc(classRef);
    const patch = { riskScore: score, riskLevel, updatedAt: serverTimestamp() };
    if (!existing.exists() || existing.data().baselineAssessmentScore === undefined) {
      patch.baselineAssessmentScore = score;
    }
    patch.finalAssessmentScore = score;
    await setDoc(classRef, patch, { merge: true });
  }
});

// ---------------------------------------------------------------
// OPTIMIZE — PLAN
// ---------------------------------------------------------------
async function loadPlan() {
  const snap = await getDoc(doc(db, "plans", currentUser.uid));
  if (!snap.exists()) { currentPlan = null; return; }
  const p = snap.data();
  currentPlan = p;
  document.getElementById("planCurrent").value = p.currentShortVideoMin ?? "";
  document.getElementById("planTarget").value = p.targetShortVideoMin ?? "";
  document.getElementById("planPhoneStart").value = p.phoneFreeStart ?? "";
  document.getElementById("planPhoneEnd").value = p.phoneFreeEnd ?? "";
  document.getElementById("planSessionLen").value = String(p.sessionLength ?? "25");
  document.getElementById("planSessionsPerDay").value = p.sessionsPerDay ?? 2;
  document.getElementById("planTask").value = p.topTask ?? "";
  updateGoalSummary(p);
}

function updateGoalSummary(p) {
  if (!p || !p.targetShortVideoMin) return;
  document.getElementById("goalSummary").innerHTML =
    `Hôm nay: giảm video ngắn xuống <strong>${p.targetShortVideoMin} phút</strong>, hoàn thành ` +
    `<strong>${p.sessionsPerDay} phiên tập trung ${p.sessionLength} phút</strong>` +
    (p.phoneFreeStart ? `, không dùng điện thoại từ <strong>${p.phoneFreeStart}</strong> đến <strong>${p.phoneFreeEnd || "..."}</strong>.` : ".");
}

document.getElementById("savePlanBtn").addEventListener("click", async () => {
  const plan = {
    currentShortVideoMin: Number(document.getElementById("planCurrent").value) || 0,
    targetShortVideoMin: Number(document.getElementById("planTarget").value) || 0,
    phoneFreeStart: document.getElementById("planPhoneStart").value.trim(),
    phoneFreeEnd: document.getElementById("planPhoneEnd").value.trim(),
    sessionLength: Number(document.getElementById("planSessionLen").value),
    sessionsPerDay: Number(document.getElementById("planSessionsPerDay").value) || 1,
    topTask: document.getElementById("planTask").value.trim(),
    updatedAt: serverTimestamp()
  };
  await setDoc(doc(db, "plans", currentUser.uid), plan, { merge: true });
  currentPlan = { ...(currentPlan || {}), ...plan };
  updateGoalSummary(plan);
  toast("Đã lưu kế hoạch.");
  evaluateAdaptiveGoal();

  if (userData.classId) {
    await setDoc(doc(db, "classes", userData.classId, "students", currentUser.uid), {
      baselineShortVideoMin: plan.currentShortVideoMin, updatedAt: serverTimestamp()
    }, { merge: true });
  }
});

// ---------------------------------------------------------------
// (5) MỤC TIÊU TỰ ĐIỀU CHỈNH (adaptive goal-setting)
//
// Nguyên lý: một mục tiêu bị trượt liên tiếp không phải bằng chứng cho thấy
// học sinh thiếu ý chí, mà là dấu hiệu mục tiêu được đặt quá xa mức hành vi
// hiện tại. Thay vì để các em tự thấy mình thất bại rồi bỏ cuộc, hệ thống chủ
// động đề xuất một mức khả thi hơn — hạ xuống một bậc vừa đủ (khoảng 10% so
// với hành vi thực tế) để vẫn giữ hướng tiến bộ. Ngược lại, nếu đạt mục tiêu
// 3 ngày liên tiếp, hệ thống đề xuất nâng độ khó.
//
// Quyền quyết định cuối cùng vẫn thuộc về học sinh: mọi đề xuất đều có nút
// "Giữ nguyên mục tiêu", và ngưỡng mới sẽ tự động được tiện ích trình duyệt
// dùng làm mốc nhắc nhở ở lần đồng bộ kế tiếp.
// ---------------------------------------------------------------
const ADAPTIVE_LOOKBACK_DAYS = 6;   // quét tối đa 6 ngày gần nhất để tìm nhật ký
const ADAPTIVE_SNOOZE_DAYS = 3;     // sau khi từ chối, tạm ngừng đề xuất 3 ngày
const MIN_TARGET_MIN = 10;          // không đề xuất mục tiêu thấp hơn mức này

let pendingSuggestion = null;

function round5(x) {
  return Math.max(0, Math.round(x / 5) * 5);
}

/** Lấy các bản nhật ký gần nhất (mới nhất trước), kèm ngày. */
async function recentJournals(days = ADAPTIVE_LOOKBACK_DAYS) {
  const keys = Array.from({ length: days }, (_, i) => dateKeyOffset(-i));
  const snaps = await Promise.all(keys.map(k => getDoc(doc(db, "journals", currentUser.uid, "entries", k))));
  return snaps
    .map((s, i) => (s.exists() ? { dateKey: keys[i], ...s.data() } : null))
    .filter(Boolean);
}

function formatDay(dateKey) {
  const [, m, d] = dateKey.split("-");
  return `${d}/${m}`;
}

async function evaluateAdaptiveGoal() {
  const card = document.getElementById("adaptiveGoalCard");
  card.style.display = "none";
  pendingSuggestion = null;

  const target = currentPlan?.targetShortVideoMin;
  if (!target || target <= 0) return; // chưa có mục tiêu thì chưa có gì để điều chỉnh

  // Học sinh vừa chọn "giữ nguyên" thì không nhắc lại ngay
  if (currentPlan.goalSuggestionSnoozedUntil && Date.now() < currentPlan.goalSuggestionSnoozedUntil) return;

  const journals = await recentJournals();
  if (journals.length < 2) return;

  const lastTwo = journals.slice(0, 2);
  const missedBoth = lastTwo.every(j => (j.shortVideoMin ?? 0) > target);

  if (missedBoth) {
    const avgActual = lastTwo.reduce((a, j) => a + (j.shortVideoMin || 0), 0) / lastTwo.length;
    const proposed = Math.max(MIN_TARGET_MIN, round5(avgActual * 0.9));

    // Nếu mức khả thi mới không dễ hơn mục tiêu cũ, nghĩa là học sinh đã rất sát
    // đích — không cần hạ mục tiêu, chỉ cần thêm một ngày nữa.
    if (proposed <= target) return;

    showSuggestion({
      kind: "down",
      eyebrow: "POP-AI đề xuất điều chỉnh",
      title: `Hạ mục tiêu xuống ${proposed} phút/ngày?`,
      body: `Hai ngày gần nhất bạn đều vượt mục tiêu ${target} phút. Điều đó thường có nghĩa là khoảng cách giữa mục tiêu và thói quen hiện tại còn hơi xa, chứ không phải bạn không cố gắng. Một mục tiêu nhỏ hơn nhưng đạt được sẽ tạo đà tốt hơn một mục tiêu đẹp nhưng luôn trượt. Sau khi giữ vững mức mới, bạn có thể hạ tiếp.`,
      evidence: lastTwo.map(j => `${formatDay(j.dateKey)}: ${j.shortVideoMin} phút (mục tiêu ${target})`).join("<br>"),
      newTarget: proposed,
      reason: "missed_2_days"
    });
    return;
  }

  // Chiều ngược lại: đạt mục tiêu 3 ngày liên tiếp -> đề xuất nâng độ khó
  const lastThree = journals.slice(0, 3);
  if (lastThree.length === 3 && lastThree.every(j => (j.shortVideoMin ?? 0) <= target)) {
    const avgActual = lastThree.reduce((a, j) => a + (j.shortVideoMin || 0), 0) / lastThree.length;
    const proposed = Math.max(MIN_TARGET_MIN, round5(Math.min(target, avgActual) * 0.9));
    if (proposed >= target) return;

    showSuggestion({
      kind: "up",
      eyebrow: "Bạn đang làm tốt",
      title: `Thử hạ mục tiêu xuống ${proposed} phút/ngày?`,
      body: `Ba ngày liên tiếp bạn giữ được mức dưới ${target} phút — mục tiêu hiện tại đã nằm trong tầm kiểm soát của bạn. Nếu thấy sẵn sàng, hạ thêm một bậc nhỏ sẽ giúp tiến bộ tiếp tục thay vì chững lại.`,
      evidence: lastThree.map(j => `${formatDay(j.dateKey)}: ${j.shortVideoMin} phút (mục tiêu ${target})`).join("<br>"),
      newTarget: proposed,
      reason: "met_3_days"
    });
  }
}

function showSuggestion(s) {
  pendingSuggestion = s;
  const card = document.getElementById("adaptiveGoalCard");
  card.classList.toggle("up", s.kind === "up");
  document.getElementById("adaptiveEyebrow").textContent = s.eyebrow;
  document.getElementById("adaptiveTitle").textContent = s.title;
  document.getElementById("adaptiveBody").textContent = s.body;
  document.getElementById("adaptiveEvidence").innerHTML = s.evidence;
  document.getElementById("adaptiveAcceptBtn").textContent = `Dùng mục tiêu ${s.newTarget} phút`;
  card.style.display = "block";
}

document.getElementById("adaptiveAcceptBtn").addEventListener("click", async () => {
  if (!pendingSuggestion) return;
  const from = currentPlan.targetShortVideoMin;
  const to = pendingSuggestion.newTarget;

  // Lưu lại lịch sử điều chỉnh — vừa để học sinh nhìn lại, vừa là dữ liệu
  // cho phần phân tích can thiệp (mục tiêu có được điều chỉnh thích ứng không).
  const history = [...(currentPlan.goalHistory || []), {
    at: new Date().toISOString(),
    from, to,
    reason: pendingSuggestion.reason
  }].slice(-20);

  const patch = {
    targetShortVideoMin: to,
    goalHistory: history,
    goalSuggestionSnoozedUntil: Date.now() + ADAPTIVE_SNOOZE_DAYS * 86400000,
    updatedAt: serverTimestamp()
  };
  await setDoc(doc(db, "plans", currentUser.uid), patch, { merge: true });
  currentPlan = { ...currentPlan, ...patch };

  document.getElementById("planTarget").value = to;
  updateGoalSummary(currentPlan);
  document.getElementById("adaptiveGoalCard").style.display = "none";
  pendingSuggestion = null;
  toast(`Đã đặt mục tiêu mới: ${to} phút/ngày.`);
});

document.getElementById("adaptiveKeepBtn").addEventListener("click", async () => {
  const patch = { goalSuggestionSnoozedUntil: Date.now() + ADAPTIVE_SNOOZE_DAYS * 86400000 };
  await setDoc(doc(db, "plans", currentUser.uid), patch, { merge: true });
  currentPlan = { ...currentPlan, ...patch };
  document.getElementById("adaptiveGoalCard").style.display = "none";
  pendingSuggestion = null;
  toast("Giữ nguyên mục tiêu hiện tại. POP-AI sẽ không nhắc lại trong vài ngày tới.");
});

// ---------------------------------------------------------------
// OPTIMIZE — FOCUS TIMER
// ---------------------------------------------------------------
let timerSeconds = 25 * 60;
let timerTotal = 25 * 60;
let timerInterval = null;
let timerRunning = false;

document.querySelectorAll(".duration-picker button").forEach(btn => {
  btn.addEventListener("click", () => {
    if (timerRunning) return;
    document.querySelectorAll(".duration-picker button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    timerTotal = Number(btn.dataset.min) * 60;
    timerSeconds = timerTotal;
    renderTimer();
  });
});

function renderTimer() {
  const m = String(Math.floor(timerSeconds / 60)).padStart(2, "0");
  const s = String(timerSeconds % 60).padStart(2, "0");
  document.getElementById("timerDisplay").textContent = `${m}:${s}`;
}
renderTimer();

document.getElementById("timerStartBtn").addEventListener("click", () => {
  if (timerRunning) return;
  timerRunning = true;
  document.getElementById("timerPauseBtn").disabled = false;
  timerInterval = setInterval(async () => {
    timerSeconds--;
    renderTimer();
    if (timerSeconds <= 0) {
      clearInterval(timerInterval);
      timerRunning = false;
      document.getElementById("timerPauseBtn").disabled = true;
      await logFocusSession();
      toast("Hoàn thành phiên tập trung! Nghỉ 5 phút nhé.");
      timerSeconds = timerTotal;
      renderTimer();
    }
  }, 1000);
});
document.getElementById("timerPauseBtn").addEventListener("click", () => {
  clearInterval(timerInterval);
  timerRunning = false;
  document.getElementById("timerPauseBtn").disabled = true;
});
document.getElementById("timerResetBtn").addEventListener("click", () => {
  clearInterval(timerInterval);
  timerRunning = false;
  document.getElementById("timerPauseBtn").disabled = true;
  timerSeconds = timerTotal;
  renderTimer();
});

async function logFocusSession() {
  const taskName = document.getElementById("timerTask").value.trim() || "(không ghi tên nhiệm vụ)";
  const durationMin = timerTotal / 60;
  await addDoc(collection(db, "focusSessions", currentUser.uid, "entries"), {
    taskName, durationMin, dateKey: todayKey(), completedAt: serverTimestamp()
  });
  const el = document.getElementById("timerCompletedCount");
  el.textContent = Number(el.textContent) + 1;
  document.getElementById("statFocusSessions").textContent = el.textContent;
}

// ---------------------------------------------------------------
// PERFORM — JOURNAL
// ---------------------------------------------------------------
(async function prefillJournal() {
  // chạy sau khi currentUser sẵn sàng, dùng lắng nghe nhẹ
  const check = setInterval(async () => {
    if (!currentUser) return;
    clearInterval(check);
    const key = todayKey();
    try {
      const [journalSnap, usageSnap] = await Promise.all([
        getDoc(doc(db, "journals", currentUser.uid, "entries", key)),
        getDoc(doc(db, "usageData", currentUser.uid, "daily", key))
      ]);
      // Chỉ điền vào ô còn trống, để không đè lên thứ học sinh vừa gõ trong lúc đang tải.
      const fill = (id, v) => {
        const el = document.getElementById(id);
        if (el && el.value === "" && v !== undefined && v !== null) el.value = v;
      };

      // Số phút xem video ngắn: LUÔN lấy theo số hiệu lực của hôm nay (tiện ích đo + mức chỉnh tay),
      // nên tiện ích đo thêm phút nào là ô này khớp theo; nhật ký đã lưu từ trước vẫn được giữ nhờ lấy số lớn hơn.
      const usageMin = usageSnap.exists() ? Math.round(effectiveUsageSeconds(usageSnap.data()) / 60) : null;

      if (journalSnap.exists()) {
        // Hôm nay đã lưu nhật ký -> nạp lại ĐÚNG những gì đã lưu, không điền đè bằng số khác.
        // Nạp đủ mọi ô để bấm lưu lần nữa không làm mất các ô còn lại.
        const j = journalSnap.data();
        const savedMin = Number(j.shortVideoMin) || 0;
        fill("jShortVideo", usageMin !== null ? Math.max(usageMin, savedMin) : savedMin);
        fill("jSessions", j.focusSessionsCompleted);
        fill("jFocusMin", j.totalFocusMin);
        fill("jInterrupt", j.interruptions);
        // 1–5: giá trị 0 nghĩa là học sinh đã để trống khi lưu -> giữ ô trống
        fill("jTaskDone", j.taskCompletion || "");
        fill("jFeeling", j.feeling || "");
        fill("jGood", j.wentWell || "");
        fill("jImprove", j.toImprove || "");
      } else if (usageMin !== null) {
        // Chưa có nhật ký hôm nay -> gợi ý sẵn số phút hiện có.
        fill("jShortVideo", usageMin);
      }
    } catch (e) {
      console.warn("POP-AI: không điền sẵn được nhật ký hôm nay.", e);
    }
  }, 400);
})();

// Đặt số phút hôm nay = số học sinh vừa nhập, mà KHÔNG đụng vào phần tiện ích tự đo:
// chỉ ghi "mức chỉnh tay" = số nhập − số tiện ích đã đo. Tiện ích đo thêm thì cộng dồn lên trên.
// Dùng transaction để đọc-rồi-ghi không bị lệch nếu tiện ích vừa đồng bộ đúng lúc đó.
async function syncManualMinutesToUsage(targetMin) {
  const ref = doc(db, "usageData", currentUser.uid, "daily", todayKey());
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists() ? snap.data() : null;
    if (Math.round(effectiveUsageSeconds(data) / 60) === targetMin) return; // đã khớp sẵn -> không cần ghi
    const trackedSec = Number(data?.trackedSeconds ?? data?.totalSeconds ?? 0) || 0;
    tx.set(ref, {
      manualOffsetSeconds: targetMin * 60 - trackedSec,
      manualSetAt: serverTimestamp()
    }, { merge: true });
  });
}

document.getElementById("saveJournalBtn").addEventListener("click", async () => {
  const entry = {
    shortVideoMin: Number(document.getElementById("jShortVideo").value) || 0,
    focusSessionsCompleted: Number(document.getElementById("jSessions").value) || 0,
    totalFocusMin: Number(document.getElementById("jFocusMin").value) || 0,
    interruptions: Number(document.getElementById("jInterrupt").value) || 0,
    taskCompletion: Number(document.getElementById("jTaskDone").value) || 0,
    feeling: Number(document.getElementById("jFeeling").value) || 0,
    wentWell: document.getElementById("jGood").value.trim(),
    toImprove: document.getElementById("jImprove").value.trim(),
    createdAt: serverTimestamp()
  };
  await setDoc(doc(db, "journals", currentUser.uid, "entries", todayKey()), entry);

  // Đồng bộ số phút vừa nhập sang usageData để trang Hôm nay VÀ tiện ích cùng hiện đúng số này.
  let synced = true;
  try {
    await syncManualMinutesToUsage(entry.shortVideoMin);
  } catch (e) {
    synced = false;
    console.warn("POP-AI: không đồng bộ được số phút nhập tay sang tiện ích.", e);
  }
  toast(synced ? "Đã lưu nhật ký hôm nay." : "Đã lưu nhật ký, nhưng chưa đồng bộ được số phút sang tiện ích. Hãy thử lưu lại.");
  loadToday();
  evaluateAdaptiveGoal(); // nhật ký mới có thể làm thay đổi đề xuất mục tiêu

  if (userData.classId) {
    const classRef = doc(db, "classes", userData.classId, "students", currentUser.uid);
    const snap = await getDoc(classRef);
    const completedDays = (snap.exists() ? (snap.data().completedDays || 0) : 0) + (snap.exists() && snap.data()._lastJournalDate === todayKey() ? 0 : 1);
    await setDoc(classRef, {
      completedDays,
      _lastJournalDate: todayKey(),
      latestShortVideoMin: entry.shortVideoMin,
      latestFocusMin: entry.totalFocusMin,
      interruptionsCount: (snap.exists() ? (snap.data().interruptionsCount || 0) : 0) + entry.interruptions,
      focusSessionsCount: (snap.exists() ? (snap.data().focusSessionsCount || 0) : 0) + entry.focusSessionsCompleted,
      updatedAt: serverTimestamp()
    }, { merge: true });
  }
});

// ---------------------------------------------------------------
// PERFORM — PROGRESS REPORT
// ---------------------------------------------------------------
let chartShortVideo, chartFocus, reportLoaded = false;

function refreshReportIfVisible() {
  const tabReport = document.getElementById("tab-report");
  if (tabReport && tabReport.style.display !== "none") loadReport();
}

async function loadReport() {
  const labels = [];
  const shortVideoData = [];
  const focusData = [];
  for (let i = 6; i >= 0; i--) {
    const k = dateKeyOffset(-i);
    labels.push(k.slice(5));
    const snap = await getDoc(doc(db, "journals", currentUser.uid, "entries", k));
    if (snap.exists()) {
      let shortMin = snap.data().shortVideoMin || 0;
      if (i === 0) { // hôm nay: tiện ích có thể đã đo thêm sau khi lưu nhật ký
        const uSnap = await getDoc(doc(db, "usageData", currentUser.uid, "daily", k));
        if (uSnap.exists()) shortMin = Math.max(shortMin, Math.round(effectiveUsageSeconds(uSnap.data()) / 60));
      }
      shortVideoData.push(shortMin);
      focusData.push(snap.data().totalFocusMin || 0);
    } else {
      shortVideoData.push(null);
      focusData.push(null);
    }
  }

  const ctx1 = document.getElementById("chartShortVideo").getContext("2d");
  const ctx2 = document.getElementById("chartFocus").getContext("2d");
  if (chartShortVideo) chartShortVideo.destroy();
  if (chartFocus) chartFocus.destroy();

  chartShortVideo = new Chart(ctx1, {
    type: "line",
    data: { labels, datasets: [{ label: "Video ngắn (phút)", data: shortVideoData, borderColor: "#B5533C", backgroundColor: "#B5533C", tension: 0.3 }] },
    options: { plugins: { title: { display: true, text: "Thời gian xem video ngắn" } }, spanGaps: true }
  });
  chartFocus = new Chart(ctx2, {
    type: "line",
    data: { labels, datasets: [{ label: "Tập trung (phút)", data: focusData, borderColor: "#3E7C6B", backgroundColor: "#3E7C6B", tension: 0.3 }] },
    options: { plugins: { title: { display: true, text: "Thời gian tập trung" } }, spanGaps: true }
  });

  const valid = shortVideoData.map((v, i) => v !== null ? i : null).filter(v => v !== null);
  const fb = document.getElementById("reportFeedback");
  if (valid.length < 2) {
    fb.textContent = "Chưa đủ dữ liệu 7 ngày để đưa ra nhận xét — hãy ghi nhật ký đều đặn hơn.";
    return;
  }
  const first = valid[0], last = valid[valid.length - 1];
  const svDelta = shortVideoData[first] - shortVideoData[last];
  const focusFirst = focusData[first] || 0, focusLast = focusData[last] || 0;
  fb.textContent = `Trong ${valid.length} ngày gần đây, thời gian xem video ngắn của bạn ${svDelta >= 0 ? "giảm" : "tăng"} ${Math.abs(svDelta)} phút mỗi ngày. Thời gian tập trung thay đổi từ ${focusFirst} lên ${focusLast} phút. ${svDelta > 0 ? "Hãy tiếp tục duy trì kế hoạch hiện tại." : "Thử xem lại kế hoạch để điều chỉnh mục tiêu cho phù hợp hơn."}`;
}

// ---------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------
async function loadTrackerStatus() {
  const el = document.getElementById("trackerStatus");
  if (!currentUser) return;

  // "Đã kết nối" khi MỘT trong hai điều kiện đúng:
  //  (1) hồ sơ users/{uid} có trackerConnectedAt — tiện ích ghi mốc này ngay lúc học sinh
  //      đăng nhập/đăng ký trong popup, không cần đã xem video ngắn;
  //  (2) hôm nay tiện ích đã đồng bộ số liệu xem video (usageData).
  // Trước đây chỉ xét (2) nên học sinh vừa đăng nhập tiện ích, hoặc sang ngày mới mà chưa xem
  // video ngắn, luôn bị báo "Chưa kết nối" dù tiện ích đang chạy bình thường.
  let connected = false;
  try {
    const [userSnap, usageSnap] = await Promise.all([
      getDoc(doc(db, "users", currentUser.uid)),   // đọc mới, vì tiện ích có thể vừa đăng nhập sau khi trang được mở
      getDoc(doc(db, "usageData", currentUser.uid, "daily", todayKey()))
    ]);
    if (userSnap.exists() && userSnap.data().trackerConnectedAt) {
      userData = { ...userData, ...userSnap.data() };
      connected = true;
    }
    if (usageSnap.exists() && usageWrittenByTracker(usageSnap.data())) connected = true; // không tính tài liệu chỉ chứa số nhập tay
  } catch (e) {
    console.warn("POP-AI: không đọc được trạng thái tiện ích.", e);
    return; // lỗi mạng/quyền: giữ nguyên trạng thái đang hiện, không báo sai
  }

  if (connected) {
    el.textContent = "Đã kết nối";
    el.className = "badge badge-low";
  } else {
    el.textContent = "Chưa kết nối";
    el.className = "badge badge-mid";
  }
}

async function loadClassInfo() {
  if (userData.classId) {
    const c = await getDoc(doc(db, "classes", userData.classId));
    document.getElementById("classInfo").textContent = c.exists() ? `Đã tham gia lớp: ${c.data().name}` : "Đã tham gia lớp.";
  }
}

document.getElementById("joinClassBtn").addEventListener("click", async () => {
  const code = document.getElementById("joinClassCode").value.trim().toUpperCase();
  if (!code) return;
  const q = query(collection(db, "classes"), where("joinCode", "==", code));
  const res = await getDocs(q);
  if (res.empty) { toast("Không tìm thấy mã lớp."); return; }
  const classId = res.docs[0].id;
  await updateDoc(doc(db, "users", currentUser.uid), { classId });
  await setDoc(doc(db, "classes", classId, "students", currentUser.uid), {
    studentCode: userData.studentCode, joinedAt: serverTimestamp(), updatedAt: serverTimestamp()
  }, { merge: true });
  userData.classId = classId;
  toast("Đã tham gia lớp.");
  loadClassInfo();
});
