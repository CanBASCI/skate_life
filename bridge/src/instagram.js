import { createRequire } from "module";
import { makeLiveEvent } from "./events.js";

const require = createRequire(import.meta.url);
const { IgApiClient } = require("instagram-private-api");

/**
 * @typedef {{
 *   emit: (ev: import("./events.js").LiveEvent) => void,
 *   log?: (...args: unknown[]) => void,
 * }} BridgeCtx
 */

/** @type {InstanceType<typeof IgApiClient> | null} */
let ig = null;
/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;
/** @type {string | null} */
let broadcastId = null;
let lastCommentTs = 0;
let lastLikeTs = 0;
const seenCommentIds = new Set();

export function instagramStatus() {
  return {
    loggedIn: !!ig,
    polling: !!pollTimer,
    broadcastId,
  };
}

/**
 * Login via sessionid cookie (preferred) or username/password.
 * @param {{
 *   username?: string,
 *   password?: string,
 *   sessionId?: string,
 * }} creds
 * @param {BridgeCtx} ctx
 */
export async function instagramLogin(creds, ctx) {
  await instagramStop(ctx);

  const username = String(creds.username || process.env.IG_USERNAME || "").trim();
  const password = String(creds.password || process.env.IG_PASSWORD || "");
  const sessionId = String(
    creds.sessionId || process.env.IG_SESSION_ID || "",
  ).trim();

  if (!sessionId && !(username && password)) {
    throw new Error(
      "Instagram: IG_SESSION_ID veya IG_USERNAME+IG_PASSWORD gerekli (bridge/.env)",
    );
  }

  const client = new IgApiClient();
  client.state.generateDevice(username || `session_${sessionId.slice(0, 8)}`);

  if (sessionId) {
    await client.state.cookieJar.setCookie(
      `sessionid=${sessionId}; Domain=.instagram.com; Path=/; HttpOnly; Secure`,
      "https://i.instagram.com",
    );
    // Optional companion cookies help some endpoints
    const dsUser = String(process.env.IG_DS_USER_ID || "").trim();
    if (dsUser) {
      await client.state.cookieJar.setCookie(
        `ds_user_id=${dsUser}; Domain=.instagram.com; Path=/;`,
        "https://i.instagram.com",
      );
    }
  } else {
    ctx.log?.(
      "[instagram] Şifre ile giriş — hesap riski var; mümkünse sessionid kullan.",
    );
    await client.account.login(username, password);
  }

  const me = await client.account.currentUser();
  ig = client;
  ctx.log?.(
    `[instagram] oturum açık @${me.username} (pk=${me.pk}) — UNOFFICIAL API, ban riski`,
  );
  return { username: me.username, pk: String(me.pk) };
}

/**
 * Resolve active broadcast for the logged-in user (or IG_BROADCAST_ID).
 * @param {BridgeCtx} ctx
 */
async function resolveBroadcastId(ctx) {
  const forced = String(process.env.IG_BROADCAST_ID || "").trim();
  if (forced) return forced;
  if (!ig) throw new Error("Instagram: önce login");

  const me = await ig.account.currentUser();
  const pk = String(me.pk);

  // Story feed often includes current live broadcast
  try {
    const { body } = await ig.request.send({
      url: `/api/v1/feed/user/${pk}/story/`,
      method: "GET",
    });
    const b = body?.broadcast || body?.reel?.broadcast;
    if (b?.id || b?.broadcast_id) {
      return String(b.id || b.broadcast_id);
    }
  } catch (err) {
    ctx.log?.("[instagram] story feed", err?.message || err);
  }

  try {
    const presence = await ig.live.getLivePresence();
    ctx.log?.("[instagram] getLivePresence", JSON.stringify(presence).slice(0, 400));
    const candidates = [
      presence?.broadcast_id,
      presence?.broadcast?.id,
      presence?.broadcast?.broadcast_id,
      presence?.id,
    ].filter(Boolean);
    if (candidates[0]) return String(candidates[0]);
  } catch (err) {
    ctx.log?.("[instagram] presence", err?.message || err);
  }

  throw new Error(
    "Aktif Instagram Live bulunamadı. Telefonda yayını aç, veya bridge/.env içine IG_BROADCAST_ID yaz.",
  );
}

/**
 * Start polling live comments (+ like count delta) every ~2.2s.
 * @param {BridgeCtx} ctx
 * @param {{ broadcastId?: string }} [opts]
 */
export async function instagramStartPoll(ctx, opts = {}) {
  if (!ig) await instagramLogin({}, ctx);

  broadcastId = String(opts.broadcastId || "").trim() || (await resolveBroadcastId(ctx));
  lastCommentTs = 0;
  lastLikeTs = 0;
  seenCommentIds.clear();

  if (pollTimer) clearInterval(pollTimer);

  ctx.log?.(`[instagram] comment poll → broadcast ${broadcastId}`);
  ctx.emit(
    makeLiveEvent({
      platform: "instagram",
      type: "status",
      user: { id: "system", name: "system" },
      text: `instagram polling ${broadcastId}`,
    }),
  );

  const tick = async () => {
    if (!ig || !broadcastId) return;
    try {
      const { comments } = await ig.live.getComment({
        broadcastId,
        commentsRequested: 20,
        lastCommentTs,
      });
      const list = Array.isArray(comments) ? comments : [];
      for (const c of list) {
        const cid = String(c.pk || c.id || "");
        if (cid && seenCommentIds.has(cid)) continue;
        if (cid) {
          seenCommentIds.add(cid);
          if (seenCommentIds.size > 2000) {
            const first = seenCommentIds.values().next().value;
            seenCommentIds.delete(first);
          }
        }
        const ts = Number(c.created_at || c.created_at_utc || 0);
        if (ts > lastCommentTs) lastCommentTs = ts;
        const uname = c.user?.username || c.user?.full_name || "viewer";
        const uid = String(c.user?.pk || c.user_id || uname);
        ctx.emit(
          makeLiveEvent({
            platform: "instagram",
            type: "comment",
            user: { id: uid, name: String(uname) },
            text: String(c.text || ""),
            raw: { commentId: cid },
          }),
        );
      }
    } catch (err) {
      ctx.log?.("[instagram] getComment", err?.message || err);
    }

    try {
      const likes = await ig.live.getLikeCount(broadcastId, lastLikeTs);
      const bump = Number(likes?.like_ts ? likes.likes || likes.like_count || 0 : 0);
      // Response shapes vary; prefer burst count when present
      const burst =
        Number(likes?.burst_likes || likes?.likers?.length || likes?.likes || 0) ||
        0;
      if (likes?.like_ts != null) lastLikeTs = likes.like_ts;
      if (burst > 0) {
        ctx.emit(
          makeLiveEvent({
            platform: "instagram",
            type: "like",
            user: { id: "ig_likes", name: "instagram" },
            likeCount: burst,
            text: `like x${burst}`,
            raw: likes,
          }),
        );
      } else if (bump > 0) {
        ctx.emit(
          makeLiveEvent({
            platform: "instagram",
            type: "like",
            user: { id: "ig_likes", name: "instagram" },
            likeCount: bump,
            text: `like x${bump}`,
            raw: likes,
          }),
        );
      }
    } catch {
      /* likes optional */
    }
  };

  await tick();
  pollTimer = setInterval(() => {
    tick().catch((err) => ctx.log?.("[instagram] tick", err?.message || err));
  }, 2200);

  return { broadcastId };
}

/** Meta Graph webhook: live_comments field */
export function handleInstagramWebhookPayload(body, ctx) {
  const entries = body?.entry || [];
  let n = 0;
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      if (change.field !== "live_comments" && change.field !== "comments") continue;
      const v = change.value || {};
      const name = v.from?.username || "viewer";
      const id = String(v.from?.id || name);
      const text = String(v.text || "");
      if (!text) continue;
      ctx.emit(
        makeLiveEvent({
          platform: "instagram",
          type: "comment",
          user: { id, name: String(name) },
          text,
          raw: v,
        }),
      );
      n += 1;
    }
  }
  return n;
}

/** @param {BridgeCtx} [ctx] */
export async function instagramStop(ctx) {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  broadcastId = null;
  ig = null;
  ctx?.emit?.(
    makeLiveEvent({
      platform: "instagram",
      type: "status",
      user: { id: "system", name: "system" },
      text: "instagram stopped",
    }),
  );
}
