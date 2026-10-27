# POP-AI Gateway — chỉ dùng n8n (không còn Firestore / Service Account)

```
Web ──(Firebase ID token + page_url)──► n8n /popai-gw-token ──► token 5 phút
Web ──(token + câu hỏi)───────────────► n8n /popai-gw-chat  ──► LLM ──► trả lời
Bạn ──(header x-admin-key)────────────► n8n /popai-gw-admin ──► thống kê / log / bật-tắt
```

Một workflow duy nhất: `popai-gateway.json` (3 webhook). Cấu hình, bộ đếm hạn mức, khoá ký token, log và thống kê theo từng web đều nằm trong n8n (workflow static data).

## Thay đổi so với bản cũ
- **Mọi trang dưới `https://tiepbuoc.github.io`** đều xin được token và gọi được AI (kiểm tra theo header `Origin`, không cần liệt kê từng đường dẫn). Origin khác bị `403`.
- **Không còn `web_secret`/`web_id`** (secret nằm trong JS thì ai cũng thấy, không có tác dụng thật).
- **Ghi nhận web nào gọi AI:** mỗi request được gán vào một "web con" = `domain/thư-mục-đầu-tiên` (vd. `tiepbuoc.github.io/Pop-AI`), kèm trang cụ thể. Thống kê theo web con: số lần chat, token dùng, số lần bị từ chối, lần cuối dùng, 35 ngày gần nhất.
- **Bỏ Firestore:** không cần `gatewayConfig/gatewayWebs/gatewayLogs`, Service Account hay credential Google. Khoá ký token tự sinh ở lần chạy đầu.
- **Vẫn còn dùng Firebase Auth** (chỉ để xác minh học sinh đã đăng nhập, qua `apiKey` công khai). Nếu bỏ bước này thì ai cũng gọi được AI mà không cần đăng nhập, chỉ còn giới hạn theo IP.
- **Bỏ kiểm tra vai trò** (`users/{uid}.role`) vì cần đọc Firestore. Mọi tài khoản Firebase của project đều dùng được trong hạn mức.

## Cài đặt
1. **Credential LLM:** n8n → Credentials → Create → **Header Auth**, đặt tên đúng `LLM API Key`. Name: `Authorization`, Value: `Bearer <API key>`. Key chỉ dán ở đây, không dán vào code/chat/GitHub.
2. **Import** `popai-gateway.json`. Ở 3 node `LLM 1/2/3`, chọn lại credential `LLM API Key`. Nếu nhà cung cấp khác `api.shopaikey.com` thì sửa URL (giống nhau cả ba).
3. **Sửa node `Config`** (đầu file): `allowedOrigins`, hạn mức, `models`, và `adminKey` (chuỗi ngẫu nhiên ≥ 16 ký tự, `openssl rand -hex 16`; để rỗng là tắt endpoint admin).
4. **Bật workflow** (Active/Publish). URL production: `https://<n8n-host>/webhook/popai-gw-token`, `/popai-gw-chat`, `/popai-gw-admin`.
5. **Web:** sửa `js/gateway-config.js` → `GATEWAY_BASE_URL = "https://<n8n-host>/webhook"`, thay `js/popai-gateway.js` bằng bản mới, rồi upload lên GitHub Pages.

## Xem log, thống kê, tắt khẩn cấp
```bash
A="https://<n8n-host>/webhook/popai-gw-admin"; K="<adminKey>"
curl -s -X POST $A -H "x-admin-key: $K" -H "Content-Type: application/json" -d '{"action":"stats"}'
curl -s -X POST $A -H "x-admin-key: $K" -H "Content-Type: application/json" -d '{"action":"logs","limit":50,"site":"tiepbuoc.github.io/Pop-AI"}'
curl -s -X POST $A -H "x-admin-key: $K" -H "Content-Type: application/json" -d '{"action":"disable"}'   # tắt toàn bộ
curl -s -X POST $A -H "x-admin-key: $K" -H "Content-Type: application/json" -d '{"action":"enable"}'
```
Chặn riêng một web con: thêm vào `blockedSites` trong `Config` (vd. `'tiepbuoc.github.io/ten-web'`). Đặt trần riêng cho mỗi web con bằng `perSiteDailyRequestCap` / `perSiteDailyTokenCap`.

## Giới hạn cần biết
1. **`Origin` chỉ đáng tin với trình duyệt.** Script ngoài trình duyệt (curl) giả được `Origin`. Lớp chặn thật là: bắt buộc đăng nhập Firebase, giới hạn theo người dùng/IP, trần ngày toàn hệ thống (`dailyTokenCap`) và công tắc tắt.
2. **Ai cũng đăng ký được tài khoản** ở web POP-AI, nên "đã đăng nhập" không đồng nghĩa là học sinh của bạn. Hạn mức theo người dùng và trần ngày là thứ giới hạn thiệt hại.
3. **Mọi trang dưới `tiepbuoc.github.io` đều được phép** (gồm mọi repo của tài khoản đó). Muốn loại một web thì dùng `blockedSites`.
4. **`page_url` do web tự khai**, chỉ để ghi nhận. Web con trong token lấy từ lần xin token, nên đáng tin hơn khi đã qua kiểm tra Origin.
5. **Dữ liệu lưu trong bộ nhớ workflow:** chỉ ghi ở chế độ production (không ghi khi bấm *Test workflow*), mất khi import đè workflow (kể cả khoá ký token, nhưng token chỉ sống 5 phút nên web tự xin lại), và gần đúng khi nhiều request đồng thời. Log giữ `logKeep` dòng gần nhất (mặc định 300), thống kê theo ngày giữ 35 ngày. Cần lưu lâu dài hơn thì thêm node ghi ra Google Sheets/Data Table/DB.
6. Giữ **Save successful production executions = Do not save** (đã đặt sẵn) vì dữ liệu thực thi chứa ID token và nội dung chat của học sinh.
7. Mọi tin nhắn của học sinh đi qua n8n và nhà cung cấp LLM, nên cần thông báo cho học sinh/phụ huynh/nhà trường.

## Mã lỗi
`400 bad_request/message_too_long` · `401 invalid_id_token / invalid_token / token_expired` (web tự xin lại) · `403 forbidden` (reason: `origin_not_allowed`, `site_blocked`, `user_disabled`) · `429 user_rate_limit / user_daily_limit / web_daily_cap / too_many_requests` · `502 llm_unavailable` (`llm_http_401` = key sai hoặc thiếu `Bearer `; `empty_completion_length` = tăng `maxTokens`) · `503 gateway_disabled / daily_cap_reached`.
