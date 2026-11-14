import { makeLiveEvent } from "./events.js";

/**
 * @typedef {{
 *   emit: (ev: import("./events.js").LiveEvent) => void,
 *   log?: (...args: unknown[]) => void,
 * }} BridgeCtx
 */

const YT_API = "https://www.googleapis.com/youtube/v3";

/** @type {ReturnType<typeof setTimeout> | null} */
let pollTimer = null;
/** @type {string | null} */
let liveChatId = null;
/** @type {string | null} */
let videoId = null;
/** @type {string | null} */
let pageToken = null;
/** Skip history on first successful poll. */
let skipHistory = true;
const seenMessageIds = new Set();

export function youtubeStatus() {
  return {
    polling: !!pollTimer,
    liveChatId,
    videoId,
  };
}

/**
 * Extract video id from raw id or youtube URL.
 * @param {string} raw
 */
export function parseYouTubeVideoId(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const v = u.searchParams.get("v");
    if (v && /^[\w-]{11}$/.test(v)) return v;
    // youtu.be/VIDEOID
    if (/youtu\.be$/i.test(u.hostname)) {
      const id = u.pathname.replace(/^\//, "").slice(0, 11);
      if (/^[\w-]{11}$/.test(id)) return id;
    }
    // /live/VIDEOID or /shorts/VIDEOID
    const m = u.pathname.match(/\/(live|shorts|embed)\/([\w-]{11})/);
    if (m) return m[2];
  } catch {
    /* not a URL */
  }
  return "";
}

/**
 * @param {string} apiKey
 * @param {string} vid
 */
async function resolveLiveChatId(apiKey, vid) {
  const url = new URL(`${YT_API}/videos`);
  url.searchParams.set("part", "liveStreamingDetails,snippet");
  url.searchParams.set("id", vid);
  url.searchParams.set("key", apiKey);
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.error?.message || `YouTube videos.list HTTP ${res.status}`;
    throw new Error(msg);
  }
  const item = data?.items?.[0];
  if (!item) throw new Error(`Video bulunamadı: ${vid}`);
  const chatId = item?.liveStreamingDetails?.activeLiveChatId;
  if (!chatId) {
    throw new Error(
      "Bu videoda aktif canlı chat yok. Yayını başlatıp video id'yi tekrar dene.",
    );
  }
  return String(chatId);
}

/**
 * @param {import("./events.js").LiveEvent["type"]} type
 * @param {object} item
 * @param {string} [text]
 */
function emitFromItem(ctx, type, item, text) {
  const author = item?.authorDetails || {};
  const name = String(
    author.displayName || author.channelId || "viewer",
  ).trim();
  const id = String(author.channelId || name);
  ctx.emit(
    makeLiveEvent({
      platform: "youtube",
      type,
      user: { id, name },
      text: text != null ? String(text) : undefined,
      raw: {
        messageId: item?.id,
        messageType: item?.snippet?.type,
      },
    }),
  );
}

/**
 * @param {BridgeCtx} ctx
 * @param {string} apiKey
 */
async function pollOnce(ctx, apiKey) {
  if (!liveChatId) return;

  const url = new URL(`${YT_API}/liveChat/messages`);
  url.searchParams.set("liveChatId", liveChatId);
  url.searchParams.set("part", "snippet,authorDetails");
  url.searchParams.set("key", apiKey);
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.error?.message || `YouTube liveChat HTTP ${res.status}`;
    throw new Error(msg);
  }

  pageToken = data?.nextPageToken || pageToken;
  const interval = Math.max(
    1000,
    Number(data?.pollingIntervalMillis) || 5000,
  );
  const items = Array.isArray(data?.items) ? data.items : [];

  if (skipHistory) {
    for (const item of items) {
      if (item?.id) seenMessageIds.add(String(item.id));
    }
    skipHistory = false;
    ctx.log?.(
      `[youtube] history skipped (${items.length}); polling every ${interval}ms`,
    );
  } else {
    for (const item of items) {
      const mid = item?.id ? String(item.id) : "";
      if (mid && seenMessageIds.has(mid)) continue;
      if (mid) {
        seenMessageIds.add(mid);
        if (seenMessageIds.size > 5000) {
          // Drop oldest-ish by clearing half (Set has no order trim — reset when huge)
          seenMessageIds.clear();
        }
      }

      const sn = item?.snippet || {};
      const type = String(sn.type || "");
      if (type === "textMessageEvent") {
        emitFromItem(ctx, "comment", item, sn.displayMessage || sn.textMessageDetails?.messageText || "");
      } else if (
        type === "superChatEvent" ||
        type === "superStickerEvent"
      ) {
        const giftText =
          sn.superChatDetails?.amountDisplayString ||
          sn.displayMessage ||
          "superchat";
        emitFromItem(ctx, "gift", item, giftText);
      }
      // ignore membership / tombstone / etc.
    }
  }

  scheduleNext(ctx, apiKey, interval);
}

/**
 * @param {BridgeCtx} ctx
 * @param {string} apiKey
 * @param {number} ms
 */
function scheduleNext(ctx, apiKey, ms) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollOnce(ctx, apiKey).catch((err) => {
      ctx.log?.("[youtube] poll error", err?.message || err);
      ctx.emit(
        makeLiveEvent({
          platform: "youtube",
          type: "status",
          user: { id: "system", name: "system" },
          text: `youtube poll error: ${err?.message || err}`,
        }),
      );
      // Back off then retry while still "connected"
      if (liveChatId) scheduleNext(ctx, apiKey, 15000);
    });
  }, ms);
}

/**
 * @param {{
 *   apiKey?: string,
 *   videoId?: string,
 *   liveChatId?: string,
 * }} opts
 * @param {BridgeCtx} ctx
 */
export async function youtubeConnect(opts, ctx) {
  const apiKey = String(
    opts.apiKey || process.env.YOUTUBE_API_KEY || "",
  ).trim();
  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY gerekli (bridge/.env)");
  }

  await youtubeDisconnect(ctx);

  const forcedChat = String(
    opts.liveChatId || process.env.YOUTUBE_LIVE_CHAT_ID || "",
  ).trim();
  const vid = parseYouTubeVideoId(
    opts.videoId || process.env.YOUTUBE_VIDEO_ID || "",
  );

  let chatId = forcedChat;
  if (!chatId) {
    if (!vid) {
      throw new Error(
        "YOUTUBE_VIDEO_ID veya YOUTUBE_LIVE_CHAT_ID gerekli (canlı video id)",
      );
    }
    chatId = await resolveLiveChatId(apiKey, vid);
  }

  liveChatId = chatId;
  videoId = vid || null;
  pageToken = null;
  skipHistory = true;
  seenMessageIds.clear();

  ctx.log?.(
    `[youtube] connected chat=${chatId}${vid ? ` video=${vid}` : ""}`,
  );
  ctx.emit(
    makeLiveEvent({
      platform: "youtube",
      type: "status",
      user: { id: "system", name: "system" },
      text: `youtube connected${vid ? ` ${vid}` : ""}`,
    }),
  );

  // Kick first poll immediately
  await pollOnce(ctx, apiKey);
  return { liveChatId: chatId, videoId: vid || null };
}

/** @param {BridgeCtx} [ctx] */
export async function youtubeDisconnect(ctx) {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  const was = !!liveChatId;
  liveChatId = null;
  videoId = null;
  pageToken = null;
  skipHistory = true;
  seenMessageIds.clear();
  if (was) {
    ctx?.log?.("[youtube] disconnected");
    ctx?.emit?.(
      makeLiveEvent({
        platform: "youtube",
        type: "status",
        user: { id: "system", name: "system" },
        text: "youtube disconnected",
      }),
    );
  }
}
