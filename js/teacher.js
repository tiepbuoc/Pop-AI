import {
  auth, db, signOut, onAuthStateChanged, doc, getDoc, setDoc, collection,
  addDoc, query, where, getDocs, orderBy, serverTimestamp, genJoinCode, toast, onSnapshot
} from "./firebase.js";

import {
  pairUp, descriptives, pairedTTest, wilcoxonSignedRank,
  recommendTest, interpretEffect, mean
} from "./stats.js";

let currentUser = null;
let classes = [];
let activeClassId = null;
let liveUnsubscribe = null;
let liveDocs = [];
let liveTickInterval = null;

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = "index.html"; return; }
  const snap = await getDoc(doc(db, "users", user.uid));
  if (!snap.exists() || snap.data().role !== "teacher") {
    window.location.href = "index.html";
    return;
  }
  currentUser = user;
  const name = snap.data().displayName || user.email || "Giáo viên";
  document.getElementById("userName").textContent = name;
  document.getElementById("userInitial").textContent = name.charAt(0).toUpperCase();
  await loadClasses();
});

document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth));

async function loadClasses() {
  const q = query(collection(db, "classes"), where("teacherId", "==", currentUser.uid));
  const snap = await getDocs(q);
  classes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const select = document.getElementById("classSelect");

  if (classes.length === 0) {
    select.innerHTML = `<option>Chưa có lớp nào</option>`;
    document.getElementById("classCodeCard").style.display = "none";
    currentStudents = [];
    renderTable([]);
    updateMetrics([]);
    renderStats();
    return;
  }
  select.innerHTML = classes.map(c => `<option value="${c.id}">${c.name}</option>`).join("");
  activeClassId = classes[0].id;
  select.value = activeClassId;
  await loadClassData();
}

document.getElementById("classSelect").addEventListener("change", async (e) => {
  activeClassId = e.target.value;
  await loadClassData();
});

document.getElementById("newClassBtn").addEventListener("click", async () => {
  const name = prompt("Tên lớp (VD: 10A1 - Ngữ văn):");
  if (!name) return;
  const joinCode = genJoinCode();
  const ref = await addDoc(collection(db, "classes"), {
    teacherId: currentUser.uid, name, joinCode, createdAt: serverTimestamp()
  });
  toast("Đã tạo lớp. Mã tham gia: " + joinCode);
  await loadClasses();
  document.getElementById("classSelect").value = ref.id;
  activeClassId = ref.id;
  await loadClassData();
});

async function loadClassData() {
  const cls = classes.find(c => c.id === activeClassId);
  if (!cls) return;
  document.getElementById("classCodeCard").style.display = "block";
  document.getElementById("joinCodeDisplay").textContent = cls.joinCode;

  const studentsSnap = await getDocs(collection(db, "classes", activeClassId, "students"));
  const students = studentsSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
  currentStudents = students;
  renderTable(students);
  updateMetrics(students);
  renderStats();
  watchLiveStatus(activeClassId);
}

// ---------------------------------------------------------------
// (4) KIỂM ĐỊNH THỐNG KÊ NGAY TRÊN DASHBOARD
// Thiết kế pre–post một nhóm: so sánh số liệu ban đầu với số liệu
// sau can thiệp trên cùng những học sinh (dữ liệu ghép cặp).
// ---------------------------------------------------------------
let currentStudents = [];

const OUTCOMES = {
  shortVideo: {
    label: "Thời gian xem video ngắn",
    unit: "phút/ngày",
    beforeKey: "baselineShortVideoMin",
    afterKey: "latestShortVideoMin",
    beforeLabel: "Trước can thiệp (kế hoạch ban đầu)",
    afterLabel: "Sau can thiệp (nhật ký gần nhất)",
    missingHint: "Học sinh cần lưu kế hoạch (mức hiện tại) và ghi ít nhất một nhật ký."
  },
  assessment: {
    label: "Điểm tự đánh giá nguy cơ",
    unit: "điểm",
    beforeKey: "baselineAssessmentScore",
    afterKey: "finalAssessmentScore",
    beforeLabel: "Lần tự đánh giá đầu tiên",
    afterLabel: "Lần tự đánh giá gần nhất",
    missingHint: "Học sinh cần làm bài tự đánh giá ít nhất hai lần (đầu và cuối chương trình)."
  }
};

document.getElementById("outcomeSelect").addEventListener("change", renderStats);

function num(x, digits = 2) {
  return Number.isFinite(x) ? x.toFixed(digits) : "—";
}

function renderStats() {
  const body = document.getElementById("statsBody");
  const outcome = OUTCOMES[document.getElementById("outcomeSelect").value];
  const { before, after } = pairUp(currentStudents, outcome.beforeKey, outcome.afterKey);

  if (before.length < 2) {
    body.innerHTML = `<p class="empty-state">Mới có ${before.length} học sinh có đủ số liệu lúc đầu và hiện tại — cần ít nhất 2 em để đánh giá.<br><span class="muted">${outcome.missingHint}</span></p>`;
    return;
  }

  // --- Phần tính toán giữ nguyên ở bên trong, chỉ không hiển thị thuật ngữ ra ngoài ---
  const dBefore = descriptives(before);
  const dAfter = descriptives(after);
  const diffs = before.map((b, i) => b - after[i]);
  const tt = pairedTTest(before, after);
  const wx = wilcoxonSignedRank(before, after);
  const rec = recommendTest(diffs);
  const primary = rec.test === "ttest" ? tt : wx;
  const sig = primary.ok && Number.isFinite(primary.p) && primary.p < 0.05;
  const effectLevel = !primary.ok ? "" : (rec.test === "ttest" ? interpretEffect(tt.dz) : interpretEffect(wx.r, "r"));

  const total = diffs.length;
  const improved = diffs.filter(d => d > 0).length;
  const worse = diffs.filter(d => d < 0).length;
  const avgChange = mean(diffs);               // > 0 nghĩa là đã giảm
  const pct = dBefore.mean > 0 ? Math.round(Math.abs(avgChange) / dBefore.mean * 100) : null;
  const u = outcome.unit;
  const rnd = (x) => Number.isFinite(x) ? (Math.round(x * 10) / 10).toString().replace(".", ",") : "—";

  // --- Xếp loại đơn giản ---
  let level, badge, headline;
  if (!primary.ok) {
    level = "Chưa rõ"; badge = "";
    headline = "Số liệu còn ít nên chưa nhận xét chắc chắn được.";
  } else if (avgChange > 0 && sig && (effectLevel === "lớn" || effectLevel === "trung bình")) {
    level = "Tốt"; badge = "badge-low";
    headline = `Lớp đã tiến bộ rõ rệt: ${outcome.label.toLowerCase()} giảm khoảng ${rnd(avgChange)} ${u}${pct !== null ? ` (khoảng ${pct}%)` : ""}.`;
  } else if (avgChange > 0 && (sig || improved / total >= 0.6)) {
    level = "Khá"; badge = "badge-mid";
    headline = `Lớp có tiến bộ: ${outcome.label.toLowerCase()} giảm khoảng ${rnd(avgChange)} ${u}, nhưng mức giảm chưa nhiều.`;
  } else if (avgChange < 0 && sig) {
    level = "Cần chú ý"; badge = "badge-high";
    headline = `${outcome.label} đang tăng thêm khoảng ${rnd(Math.abs(avgChange))} ${u} so với lúc đầu.`;
  } else {
    level = "Chưa thay đổi nhiều"; badge = "badge-mid";
    headline = `${outcome.label} gần như chưa thay đổi so với lúc đầu.`;
  }

  const tip = (level === "Tốt")
    ? "Cứ tiếp tục duy trì cách làm hiện tại và khen các em đã cố gắng."
    : (level === "Khá")
      ? "Đang đi đúng hướng, nên động viên các em duy trì thêm một thời gian."
      : (level === "Cần chú ý")
        ? "Nên trò chuyện với lớp và xem lại kế hoạch/mục tiêu của các em."
        : (level === "Chưa thay đổi nhiều")
          ? "Có thể cần thêm thời gian, hoặc nhắc các em ghi nhật ký và bám sát kế hoạch hơn."
          : "Chờ thêm học sinh ghi nhật ký / tự đánh giá rồi xem lại.";

  const smallNote = total < 10
    ? `<p class="muted" style="font-size:0.8rem;">Hiện mới có ${total} học sinh có số liệu nên kết quả chỉ mang tính tham khảo.</p>`
    : "";

  body.innerHTML = `
    <div class="conclusion-box">
      <p><span class="badge ${badge}">${level}</span> &nbsp;<strong>${headline}</strong></p>
      <p class="muted" style="margin-top:6px;">${tip}</p>
    </div>

    <div class="grid-2 section-gap" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;">
      <div class="card"><div class="stat-num" style="font-family:'Fraunces',serif;font-size:1.5rem;">${rnd(dBefore.mean)}</div><div class="muted">Trung bình lúc đầu (${u})</div></div>
      <div class="card"><div class="stat-num" style="font-family:'Fraunces',serif;font-size:1.5rem;">${rnd(dAfter.mean)}</div><div class="muted">Trung bình hiện tại (${u})</div></div>
      <div class="card"><div class="stat-num" style="font-family:'Fraunces',serif;font-size:1.5rem;">${improved}/${total}</div><div class="muted">Học sinh đã tiến bộ</div></div>
    </div>

    <table class="section-gap">
      <thead><tr><th></th><th>Lúc đầu</th><th>Hiện tại</th></tr></thead>
      <tbody>
        <tr><td>Số học sinh</td><td>${dBefore.n}</td><td>${dAfter.n}</td></tr>
        <tr><td>Trung bình cả lớp</td><td>${rnd(dBefore.mean)}</td><td>${rnd(dAfter.mean)}</td></tr>
        <tr><td>Mức của em đứng giữa lớp</td><td>${rnd(dBefore.median)}</td><td>${rnd(dAfter.median)}</td></tr>
      </tbody>
    </table>
    <p class="muted" style="font-size:0.8rem;">Học sinh tiến bộ: ${improved} em · giữ nguyên: ${total - improved - worse} em · tăng lên: ${worse} em. Số càng thấp càng tốt.</p>
    ${smallNote}
    <p class="muted" style="font-size:0.78rem;">
      Đây là so sánh trên cùng một nhóm học sinh, chưa có lớp đối chứng nên kết quả chỉ để tham khảo.
      Cần xem sâu hơn thì dùng nút <em>Xuất dữ liệu (.xlsx)</em> ở khối bên dưới.
    </p>`;
}

// ---------------------------------------------------------------
// (3) DASHBOARD TRỰC TIẾP — realtime qua onSnapshot
// ---------------------------------------------------------------
const STATUS_LABEL = { entertainment: "Đang xem giải trí", other: "Đang ở trang khác", idle: "Tạm rời máy" };
const OFFLINE_AFTER_MS = 3 * 60 * 1000; // không cập nhật quá 3 phút -> coi như ngoại tuyến

function watchLiveStatus(classId) {
  if (liveUnsubscribe) { liveUnsubscribe(); liveUnsubscribe = null; }
  if (liveTickInterval) { clearInterval(liveTickInterval); liveTickInterval = null; }

  const q = query(collection(db, "liveStatus"), where("classId", "==", classId));
  liveUnsubscribe = onSnapshot(q, (snap) => {
    liveDocs = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    renderLiveTable();
  }, (err) => console.warn("POP-AI: không nghe được liveStatus", err));

  // Cập nhật lại nhãn "cập nhật cách đây..." và tự chuyển "Ngoại tuyến" mỗi 5 giây,
  // ngay cả khi không có snapshot mới nào tới.
  liveTickInterval = setInterval(renderLiveTable, 5000);
}

function renderLiveTable() {
  const body = document.getElementById("liveTableBody");
  if (!body) return;
  if (liveDocs.length === 0) {
    body.innerHTML = `<tr><td colspan="3" class="empty-state">Chưa có dữ liệu trực tiếp — học sinh cần cài tiện ích và tham gia lớp.</td></tr>`;
    return;
  }
  const now = Date.now();
  body.innerHTML = liveDocs.map(s => {
    const updatedMs = s.updatedAt?.toDate ? s.updatedAt.toDate().getTime() : null;
    const ageSec = updatedMs ? Math.round((now - updatedMs) / 1000) : null;
    const offline = ageSec === null || now - updatedMs > OFFLINE_AFTER_MS;

    const dotClass = offline ? "offline" : s.status;
    const label = offline ? "Ngoại tuyến" : (s.status === "entertainment" ? `Đang xem ${s.sourceLabel || "video ngắn"}` : STATUS_LABEL[s.status] || "—");
    const since = ageSec === null ? "—" : ageSec < 60 ? `${ageSec} giây trước` : `${Math.round(ageSec / 60)} phút trước`;

    return `
      <tr>
        <td><strong>${s.studentCode || s.uid.slice(0, 6)}</strong></td>
        <td><span class="live-dot ${dotClass}"></span>${label}</td>
        <td class="live-since">${since}</td>
      </tr>`;
  }).join("");
}

function renderTable(students) {
  const body = document.getElementById("studentTableBody");
  if (students.length === 0) {
    body.innerHTML = `<tr><td colspan="7" class="empty-state">Chưa có học sinh nào trong lớp này.</td></tr>`;
    return;
  }
  body.innerHTML = students.map(s => {
    const risk = s.riskLevel || "—";
    const badgeClass = risk === "Cao" ? "badge-high" : risk === "Trung bình" ? "badge-mid" : risk === "Thấp" ? "badge-low" : "";
    return `
      <tr>
        <td><strong>${s.studentCode || s.uid.slice(0, 6)}</strong></td>
        <td>${risk !== "—" ? `<span class="badge ${badgeClass}">${risk}</span>` : "—"}</td>
        <td>${s.baselineShortVideoMin ?? "—"} → ${s.latestShortVideoMin ?? "—"} phút</td>
        <td>${s.focusSessionsCount ?? 0}</td>
        <td>${s.interruptionsCount ?? 0}</td>
        <td>${s.completedDays ?? 0}/7${s.missedDays ? ` <span class="muted">(bỏ lỡ ${s.missedDays})</span>` : ""}</td>
        <td>${s.finalAssessmentScore ?? "—"}</td>
      </tr>`;
  }).join("");
}

function updateMetrics(students) {
  const total = students.length;
  const assessed = students.filter(s => s.riskScore !== undefined).length;
  const journalDone = students.filter(s => (s.completedDays || 0) >= 7).length;
  const avgFocus = total ? (students.reduce((a, s) => a + (s.focusSessionsCount || 0), 0) / total).toFixed(1) : 0;

  document.getElementById("mTotal").textContent = total;
  document.getElementById("mAssessed").textContent = assessed;
  document.getElementById("mJournalRate").textContent = total ? Math.round(journalDone / total * 100) + "%" : "0%";
  document.getElementById("mAvgFocus").textContent = avgFocus;
}

document.getElementById("exportBtn").addEventListener("click", async () => {
  if (!activeClassId) { toast("Chưa chọn lớp."); return; }
  const cls = classes.find(c => c.id === activeClassId);
  const studentsSnap = await getDocs(collection(db, "classes", activeClassId, "students"));
  const rows = studentsSnap.docs.map(d => {
    const s = d.data();
    return {
      "Mã học sinh": s.studentCode || d.id.slice(0, 6),
      "Lớp": cls.name,
      "Điểm nguy cơ ban đầu": s.baselineAssessmentScore ?? "",
      "Mức nguy cơ": s.riskLevel ?? "",
      "Video ngắn ban đầu (phút)": s.baselineShortVideoMin ?? "",
      "Video ngắn sau can thiệp (phút)": s.latestShortVideoMin ?? "",
      "Thời gian tập trung sau can thiệp (phút)": s.latestFocusMin ?? "",
      "Số phiên tập trung": s.focusSessionsCount ?? 0,
      "Số lần gián đoạn": s.interruptionsCount ?? 0,
      "Số ngày hoàn thành": s.completedDays ?? 0,
      "Số ngày bỏ lỡ": s.missedDays ?? 0,
      "Điểm tự đánh giá cuối chương trình": s.finalAssessmentScore ?? ""
    };
  });
  if (rows.length === 0) { toast("Chưa có dữ liệu để xuất."); return; }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "POP-AI");
  XLSX.writeFile(wb, `pop-ai_${cls.name.replace(/\s+/g, "_")}.xlsx`);
});
