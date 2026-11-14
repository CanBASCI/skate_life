import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { tiktokConnect, tiktokDisconnect, tiktokStatus } from "./tiktok.js";
import {
  instagramLogin,
  instagramStartPoll,
  instagramStop,
  instagramStatus,
  handleInstagramWebhookPayload,
} from "./instagram.js";
import {
  youtubeConnect,
  youtubeDisconnect,
  youtubeStatus,
} from "./youtube.js";
import { makeLiveEvent } from "./events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const VERIFY_TOKEN = process.env.IG_WEBHOOK_VERIFY_TOKEN || "skate_life_ig_verify";

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({ limit: "1mb" }));

/** @type {Set<import("ws").WebSocket>} */
const clients = new Set();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** @param {import("./events.js").LiveEvent} ev */
function emit(ev) {
  const payload = JSON.stringify({ channel: "live", event: ev });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

const ctx = { emit, log };

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    tiktok: tiktokStatus(),
    instagram: instagramStatus(),
    youtube: youtubeStatus(),
    clients: clients.size,
  });
});

app.get("/status", (_req, res) => {
  res.json({
    tiktok: tiktokStatus(),
    instagram: instagramStatus(),
    youtube: youtubeStatus(),
    clients: clients.size,
  });
});

app.post("/tiktok/connect", async (req, res) => {
  try {
    const uniqueId =
      req.body?.uniqueId || req.body?.username || process.env.TIKTOK_USERNAME;
    const result = await tiktokConnect(uniqueId, ctx);
    res.json({ ok: true, ...result });
  } catch (err) {
    log("[http] tiktok connect", err?.message || err);
    res.status(400).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post("/tiktok/disconnect", async (_req, res) => {
  await tiktokDisconnect(ctx);
  res.json({ ok: true });
});

app.post("/instagram/login", async (req, res) => {
  try {
    const result = await instagramLogin(
      {
        username: req.body?.username,
        password: req.body?.password,
        sessionId: req.body?.sessionId,
      },
      ctx,
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    log("[http] ig login", err?.message || err);
    res.status(400).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post("/instagram/start", async (req, res) => {
  try {
    if (!instagramStatus().loggedIn) {
      await instagramLogin(
        {
          username: req.body?.username,
          password: req.body?.password,
          sessionId: req.body?.sessionId,
        },
        ctx,
      );
    }
    const result = await instagramStartPoll(ctx, {
      broadcastId: req.body?.broadcastId,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    log("[http] ig start", err?.message || err);
    res.status(400).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post("/instagram/stop", async (_req, res) => {
  await instagramStop(ctx);
  res.json({ ok: true });
});

app.post("/youtube/connect", async (req, res) => {
  try {
    const result = await youtubeConnect(
      {
        apiKey: req.body?.apiKey,
        videoId: req.body?.videoId || req.body?.url,
        liveChatId: req.body?.liveChatId,
      },
      ctx,
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    log("[http] youtube connect", err?.message || err);
    res.status(400).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post("/youtube/disconnect", async (_req, res) => {
  await youtubeDisconnect(ctx);
  res.json({ ok: true });
});

/** Meta webhook verification */
app.get("/instagram/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    log("[ig webhook] verified");
    res.status(200).send(challenge);
    return;
  }
  res.sendStatus(403);
});

app.post("/instagram/webhook", (req, res) => {
  try {
    const n = handleInstagramWebhookPayload(req.body, ctx);
    log(`[ig webhook] ${n} comment(s)`);
  } catch (err) {
    log("[ig webhook]", err?.message || err);
  }
  res.sendStatus(200);
});

/** Manual inject for debugging */
app.post("/sim", (req, res) => {
  const ev = makeLiveEvent({
    platform: req.body?.platform || "sim",
    type: req.body?.type || "comment",
    user: {
      id: req.body?.userId,
      name: req.body?.user || req.body?.username || "sim",
    },
    text: req.body?.text || "",
    team: req.body?.team ?? null,
  });
  emit(ev);
  res.json({ ok: true, event: ev });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/events" });

wss.on("connection", (ws) => {
  clients.add(ws);
  log(`[ws] client + (${clients.size})`);
  ws.send(
    JSON.stringify({
      channel: "live",
      event: makeLiveEvent({
        platform: "sim",
        type: "status",
        user: { id: "system", name: "system" },
        text: "bridge hello",
      }),
    }),
  );
  ws.on("close", () => {
    clients.delete(ws);
    log(`[ws] client - (${clients.size})`);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`skate_life live bridge http://127.0.0.1:${PORT}`);
  log(`WebSocket: ws://127.0.0.1:${PORT}/events`);
  log("Instagram: UNOFFICIAL session poll (hesap riski) veya Meta webhook");
  log("TikTok: tiktok-live-connector (Euler sign; resmi API değil)");
  log("YouTube: Data API v3 liveChat poll (YOUTUBE_API_KEY + video id)");

  const autoTt = String(process.env.TIKTOK_USERNAME || "").trim();
  if (autoTt) {
    tiktokConnect(autoTt, ctx).catch((err) =>
      log("[auto tiktok]", err?.message || err),
    );
  }
  if (process.env.IG_AUTO_START === "1") {
    instagramStartPoll(ctx).catch((err) =>
      log("[auto ig]", err?.message || err),
    );
  }
  if (process.env.YOUTUBE_AUTO_START === "1") {
    youtubeConnect({}, ctx).catch((err) =>
      log("[auto youtube]", err?.message || err),
    );
  }
});
