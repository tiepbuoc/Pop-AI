/**
 * Cầu nối Web App -> Chrome Extension.
 *
 * Thay vì bắt học sinh đăng nhập Google riêng trong popup extension (cần OAuth Client ID
 * cấu hình ở Google Cloud Console), ta tận dụng luôn phiên đăng nhập Firebase đã có sẵn
 * trên web app: sau khi đăng nhập thành công ở web, gửi idToken/refreshToken sang extension
 * qua `chrome.runtime.sendMessage(EXTENSION_ID, ...)`. Extension nhận ở
 * `chrome.runtime.onMessageExternal` (xem extension/background.js).
 *
 * Điều kiện để việc gửi tin nhắn này hoạt động:
 * 1. Extension đã cài trên trình duyệt (nếu chưa cài, sendMessage sẽ báo lỗi — bỏ qua,
 *    không ảnh hưởng gì tới việc dùng web app bình thường).
 * 2. `extension/manifest.json` có khai `externally_connectable.matches` trùng đúng domain
 *    web app đang chạy (vd: "https://TEN-TAI-KHOAN.github.io/*").
 * 3. POPAI_EXTENSION_ID bên dưới trùng đúng Extension ID thật (xem chrome://extensions
 *    sau khi Load unpacked extension — copy chuỗi 32 ký tự dưới tên "POP-AI Tracker").
 */
export const POPAI_EXTENSION_ID = "DIEN_EXTENSION_ID_CUA_BAN"; // <-- thay bằng Extension ID thật

export async function notifyExtensionLogin(user) {
  if (!window.chrome?.runtime?.sendMessage) return; // không phải Chrome, hoặc API không sẵn có
  if (!POPAI_EXTENSION_ID || POPAI_EXTENSION_ID.startsWith("DIEN_")) {
    console.warn("POP-AI: chưa điền POPAI_EXTENSION_ID trong js/extension-bridge.js, bỏ qua đồng bộ extension.");
    return;
  }
  try {
    const idToken = await user.getIdToken();
    chrome.runtime.sendMessage(
      POPAI_EXTENSION_ID,
      {
        type: "POPAI_WEB_LOGIN",
        idToken,
        refreshToken: user.refreshToken,
        uid: user.uid,
        email: user.email || "",
        displayName: user.displayName || ""
      },
      (response) => {
        if (chrome.runtime.lastError) {
          // Bình thường nếu học sinh chưa cài extension — không phải lỗi cần xử lý.
          console.info("POP-AI: chưa kết nối được tiện ích:", chrome.runtime.lastError.message);
          return;
        }
        if (response?.ok) console.info("POP-AI: đã đồng bộ đăng nhập sang tiện ích.");
      }
    );
  } catch (e) {
    console.warn("POP-AI: gửi đăng nhập sang tiện ích thất bại", e);
  }
}
