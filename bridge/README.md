# skate_life live bridge

Local server that forwards **YouTube** / **TikTok** / **Instagram** live comments (and likes/gifts when available) into the preview game over WebSocket.

```
ws://127.0.0.1:8787/events
```

## Trust / risk

| Platform | Package / API | Official? | Notes |
|----------|---------------|-----------|--------|
| **YouTube** | YouTube Data API v3 `liveChat/messages` | Yes | Needs Google Cloud API key + live video id. |
| TikTok | `tiktok-live-connector` (zerodytrash) | No | Widely used; needs Euler URL signing. No TikTok login required. |
| Instagram (session poll) | `instagram-private-api` | No | Uses your `sessionid`. **Ban / checkpoint risk.** Prefer a throwaway or Creator account for tests. |
| Instagram (Meta webhook) | Graph `live_comments` | Yes | Needs Meta app, Advanced Access, public HTTPS (ngrok). Safest long-term. |

## Setup

```bash
cd bridge
cp .env.example .env
npm install
npm start
```

Node **≥ 20** required.

## YouTube (recommended for OBS live)

1. [Google Cloud Console](https://console.cloud.google.com/) → project → **APIs & Services** → enable **YouTube Data API v3**.
2. **Credentials** → **API key** oluştur → `bridge/.env`:
   ```
   YOUTUBE_API_KEY=...
   YOUTUBE_VIDEO_ID=xxxxxxxxxxx
   YOUTUBE_AUTO_START=1
   ```
3. OBS ile YouTube canlı yayını başlat. Video id: Studio / izleme URL’sindeki `v=` veya `youtu.be/…`.
4. `npm start` → preview (Menü → **Live**) bağlı görünmeli.
5. Chat’te `/signin` → oyunda karakter spawn; `/dance`, `/R3`, düz mesajlar o karaktere gider. `/signout` çıkarır.

HTTP ile bağla (env yerine):

```bash
curl -X POST http://127.0.0.1:8787/youtube/connect \
  -H 'content-type: application/json' \
  -d '{"videoId":"xxxxxxxxxxx"}'
```

### Simülasyon (API key olmadan test)

Bridge + preview açıkken:

```bash
curl -X POST http://127.0.0.1:8787/sim \
  -H 'content-type: application/json' \
  -d '{"platform":"youtube","user":"Ali","userId":"yt_ali","text":"/signin"}'

curl -X POST http://127.0.0.1:8787/sim \
  -H 'content-type: application/json' \
  -d '{"platform":"youtube","user":"Ali","userId":"yt_ali","text":"merhaba"}'

curl -X POST http://127.0.0.1:8787/sim \
  -H 'content-type: application/json' \
  -d '{"platform":"youtube","user":"Ali","userId":"yt_ali","text":"/dance"}'
```

## Instagram — try today (session)

1. Chrome’da [instagram.com](https://www.instagram.com) → hesabına giriş.
2. DevTools → **Application** → **Cookies** → `sessionid` değerini kopyala.
3. `bridge/.env` içine:
   ```
   IG_SESSION_ID=...
   IG_AUTO_START=1
   ```
4. Telefonda **Instagram Live** başlat (aynı hesap).
5. `npm start` → preview’da bridge **bağlı** görünmeli.
6. Yayında biri `/signin` yazınca oyunda karakter spawn olur.

Broadcast bulunamazsa Live açıkken `IG_BROADCAST_ID` ekle (gerekirse loglardan / 3. parti araçlardan).

## TikTok

```
TIKTOK_USERNAME=senin_unique_id
```

veya preview / HTTP:

```bash
curl -X POST http://127.0.0.1:8787/tiktok/connect \
  -H 'content-type: application/json' \
  -d '{"uniqueId":"senin_unique_id"}'
```

Yayın açık olmalı.

## Meta webhook (resmi Instagram)

1. Meta Developer app + Instagram professional account.
2. Webhook callback: `https://<ngrok>/instagram/webhook`
3. Verify token = `IG_WEBHOOK_VERIFY_TOKEN`
4. Subscribe `live_comments`

## Preview

Preview otomatik `ws://127.0.0.1:8787/events` dinler. **M** ile menüyü aç → **Live** satırında bridge durumu + YouTube video id / Bağla.
