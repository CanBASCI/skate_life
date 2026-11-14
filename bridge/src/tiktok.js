import { TikTokLiveConnection, WebcastEvent } from "tiktok-live-connector";
import { makeLiveEvent } from "./events.js";

/**
 * @typedef {{
 *   emit: (ev: import("./events.js").LiveEvent) => void,
 *   log?: (...args: unknown[]) => void,
 * }} BridgeCtx
 */

/** @type {TikTokLiveConnection | null} */
let connection = null;
/** @type {string | null} */
let connectedUniqueId = null;

export function tiktokStatus() {
  return {
    connected: !!connection,
    uniqueId: connectedUniqueId,
  };
}

/**
 * @param {string} uniqueId
 * @param {BridgeCtx} ctx
 */
export async function tiktokConnect(uniqueId, ctx) {
  const id = String(uniqueId || "")
    .trim()
    .replace(/^@/, "");
  if (!id) throw new Error("TikTok uniqueId gerekli");

  await tiktokDisconnect(ctx);

  const conn = new TikTokLiveConnection(id, {
    processInitialData: false,
    fetchRoomInfoOnConnect: true,
    enableExtendedGiftInfo: true,
  });

  conn.on(WebcastEvent.CHAT, (data) => {
    const name = data?.user?.nickname || data?.user?.uniqueId || "viewer";
    const userId = String(data?.user?.userId || data?.user?.uniqueId || name);
    ctx.emit(
      makeLiveEvent({
        platform: "tiktok",
        type: "comment",
        user: { id: userId, name: String(data?.user?.uniqueId || name) },
        text: String(data?.comment || ""),
        raw: { nickname: name },
      }),
    );
  });

  conn.on(WebcastEvent.LIKE, (data) => {
    const name = data?.user?.uniqueId || data?.user?.nickname || "viewer";
    const count = Number(data?.likeCount || data?.totalLikeCount || 1) || 1;
    ctx.emit(
      makeLiveEvent({
        platform: "tiktok",
        type: "like",
        user: { id: String(data?.user?.userId || name), name: String(name) },
        likeCount: count,
        text: `like x${count}`,
      }),
    );
  });

  conn.on(WebcastEvent.GIFT, (data) => {
    // Repeat gifts fire many times; only act on non-repeat or last of streak when possible
    if (data?.giftType === 1 && !data?.repeatEnd) return;
    const name = data?.user?.uniqueId || data?.user?.nickname || "viewer";
    const giftName = data?.extendedGiftInfo?.name || data?.giftName || "gift";
    ctx.emit(
      makeLiveEvent({
        platform: "tiktok",
        type: "gift",
        user: { id: String(data?.user?.userId || name), name: String(name) },
        text: String(giftName),
        raw: {
          giftId: data?.giftId,
          repeatCount: data?.repeatCount,
          diamondCount: data?.diamondCount,
        },
      }),
    );
  });

  conn.on(WebcastEvent.MEMBER, (data) => {
    const name = data?.user?.uniqueId || data?.user?.nickname || "viewer";
    ctx.emit(
      makeLiveEvent({
        platform: "tiktok",
        type: "join",
        user: { id: String(data?.user?.userId || name), name: String(name) },
        text: "join",
      }),
    );
  });

  conn.on(WebcastEvent.DISCONNECT, () => {
    ctx.log?.("[tiktok] disconnect");
    if (connection === conn) {
      connection = null;
      connectedUniqueId = null;
    }
    ctx.emit(
      makeLiveEvent({
        platform: "tiktok",
        type: "status",
        user: { id: "system", name: "system" },
        text: "tiktok disconnected",
      }),
    );
  });

  const state = await conn.connect();
  connection = conn;
  connectedUniqueId = id;
  ctx.log?.(`[tiktok] connected @${id} room=${state?.roomId || "?"}`);
  ctx.emit(
    makeLiveEvent({
      platform: "tiktok",
      type: "status",
      user: { id: "system", name: "system" },
      text: `tiktok connected @${id}`,
    }),
  );
  return { uniqueId: id, roomId: state?.roomId };
}

/** @param {BridgeCtx} [ctx] */
export async function tiktokDisconnect(ctx) {
  if (!connection) return;
  const conn = connection;
  connection = null;
  connectedUniqueId = null;
  try {
    await conn.disconnect();
  } catch (err) {
    ctx?.log?.("[tiktok] disconnect error", err?.message || err);
  }
}
