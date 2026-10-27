/**
 * Module dùng chung để gọi AI qua POP-AI Gateway (n8n).
 * Có thể copy nguyên file này (+ gateway-config.js) sang web khác dưới cùng domain được phép; n8n tự ghi nhận web nào gọi (theo page_url).
 *
 * Luồng:
 *  1. Lấy Firebase ID token của người đang đăng nhập.
 *  2. Gửi {id_token, page_url} tới /popai-gw-token -> nhận token sống ~5 phút.
 *  3. Gọi /popai-gw-chat kèm token -> n8n kiểm tra, gọi LLM và trả lời.
 *  Token được làm mới âm thầm: (a) hẹn giờ ở phút thứ 4 nếu người dùng vừa hoạt động,
 *  (b) làm mới "lười" ngay trước khi gọi nếu token còn dưới 60 giây, (c) tự thử lại 1 lần khi gặp 401.
 */
import { auth } from "./firebase.js";
import { GATEWAY_BASE_URL } from "./gateway-config.js";

const RENEW_BEFORE_MS = 60 * 1000;        // còn dưới 60s thì xin token mới trước khi gọi
const RENEW_TIMER_BEFORE_MS = 60 * 1000;  // hẹn giờ xin lại khi còn 60s (≈ phút thứ 4 với token 5 phút)
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;  // chỉ tự gia hạn nền nếu người dùng vừa dùng trợ lý trong 10 phút

let cached = null;     // { token, expMs }
let inflight = null;   // chống gọi trùng khi nhiều nơi cùng xin token
let renewTimer = null;
let lastUsedAt = 0;

class GatewayError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status || 0; }
}

async function postJson(path, body) {
  let res;
  try {
    res = await fetch(GATEWAY_BASE_URL + path, {
      method: "POST",
      // text/plain = "simple request": trình duyệt không gửi preflight (OPTIONS) tới n8n.
      // Nội dung vẫn là JSON, n8n tự parse. Tránh lỗi CORS khi proxy của hosting trả lời preflight sai.
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    throw new GatewayError("network_error");
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* phản hồi không phải JSON */ }
  return { status: res.status, data };
}

async function fetchToken() {
  const user = auth.currentUser;
  if (!user) throw new GatewayError("not_logged_in");
  const idToken = await user.getIdToken();
  const { status, data } = await postJson("/popai-gw-token", {
    id_token: idToken,
    page_url: location.href
  });
  if (status !== 200 || !data || !data.token) {
    throw new GatewayError((data && data.error) || "token_http_" + status, status);
  }
  const ttlMs = (Number(data.expires_in) || 300) * 1000;
  cached = { token: data.token, expMs: Date.now() + ttlMs };
  scheduleRenew(ttlMs);
  return cached.token;
}

function scheduleRenew(ttlMs) {
  clearTimeout(renewTimer);
  renewTimer = setTimeout(() => {
    if (Date.now() - lastUsedAt < ACTIVE_WINDOW_MS) ensureToken(true).catch(() => {});
  }, Math.max(10 * 1000, ttlMs - RENEW_TIMER_BEFORE_MS));
}

/** Đảm bảo có token còn hạn; force=true để bắt buộc xin mới. */
export function ensureToken(force = false) {
  if (!force && cached && cached.expMs - Date.now() > RENEW_BEFORE_MS) return Promise.resolve(cached.token);
  if (!inflight) inflight = fetchToken().finally(() => { inflight = null; });
  return inflight;
}

/** Gọi khi trang vừa tải xong và người dùng đã đăng nhập, để lần chat đầu không phải chờ xin token. */
export function prefetchToken() {
  ensureToken().catch(() => {});
}

/** Thông báo lỗi thân thiện bằng tiếng Việt cho người dùng cuối. */
export function friendlyError(err) {
  const code = (err && err.code) || "";
  const map = {
    not_logged_in: "Bạn cần đăng nhập để dùng trợ lý.",
    network_error: "Không kết nối được tới trợ lý, hãy kiểm tra mạng rồi thử lại.",
    user_rate_limit: "Bạn gửi hơi nhanh, đợi một chút rồi hỏi tiếp nhé.",
    user_daily_limit: "Hôm nay bạn đã dùng hết lượt hỏi trợ lý. Mai quay lại nhé!",
    web_daily_cap: "Hôm nay trợ lý đã hết lượt dùng. Thử lại vào ngày mai nhé.",
    daily_cap_reached: "Hôm nay trợ lý đã hết lượt dùng. Thử lại vào ngày mai nhé.",
    gateway_disabled: "Trợ lý đang tạm dừng để bảo trì. Thử lại sau nhé.",
    message_too_long: "Tin nhắn quá dài, hãy rút gọn lại.",
    too_many_requests: "Có quá nhiều yêu cầu, đợi một chút rồi thử lại.",
    llm_unavailable: "Trợ lý đang quá tải, thử lại sau ít phút nhé."
  };
  return map[code] || ("Trợ lý đang gặp sự cố (" + (code || "lỗi không rõ") + "). Thử lại sau nhé.");
}

/**
 * Gửi câu hỏi tới AI.
 * @param {{message:string, history?:{role:string,content:string}[], context?:string}} p
 * @returns {Promise<string>} nội dung trả lời
 */
export async function askGateway({ message, history = [], context = "" }) {
  lastUsedAt = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await ensureToken(attempt > 0);
    const { status, data } = await postJson("/popai-gw-chat", {
      token, message, history, context, page_url: location.href
    });
    if (status === 200 && data && typeof data.reply === "string") return data.reply;
    const code = (data && data.error) || "http_" + status;
    // token hết hạn/không hợp lệ -> xin token mới và thử lại đúng 1 lần
    if (status === 401 && attempt === 0) { cached = null; continue; }
    throw new GatewayError(code, status);
  }
  throw new GatewayError("token_refresh_failed");
}
