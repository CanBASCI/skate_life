/**
 * WebSocket client for bridge → preview LiveEvents.
 * Keep field shapes in sync with bridge/src/events.js.
 *
 * @typedef {"instagram" | "tiktok" | "youtube" | "sim"} LivePlatform
 * @typedef {{
 *   platform: LivePlatform,
 *   type: "comment" | "like" | "gift" | "join" | "leave" | "status",
 *   user: { id: string, name: string },
 *   text?: string,
 *   team?: "a" | "b" | null,
 *   likeCount?: number,
 *   raw?: unknown,
 * }} LiveEvent
 */

const DEFAULT_WS = "ws://127.0.0.1:8787/events";
const DEFAULT_HTTP = "http://127.0.0.1:8787";

/**
 * @param {{
 *   url?: string,
 *   onEvent?: (ev: LiveEvent) => void,
 *   onStatus?: (connected: boolean, detail?: string) => void,
 * }} [opts]
 */
export function connectLiveBridge(opts = {}) {
  const url = opts.url || DEFAULT_WS;
  /** @type {WebSocket | null} */
  let ws = null;
  let closed = false;
  let retryMs = 1200;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null;

  function clearRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry() {
    if (closed) return;
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, retryMs);
    retryMs = Math.min(12000, Math.round(retryMs * 1.4));
  }

  function open() {
    if (closed) return;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      opts.onStatus?.(false, String(err?.message || err));
      scheduleRetry();
      return;
    }

    ws.addEventListener("open", () => {
      retryMs = 1200;
      opts.onStatus?.(true, "bağlı");
    });

    ws.addEventListener("message", (msg) => {
      let data;
      try {
        data = JSON.parse(String(msg.data || ""));
      } catch {
        return;
      }
      if (data?.channel !== "live" || !data?.event) return;
      opts.onEvent?.(data.event);
    });

    ws.addEventListener("close", () => {
      ws = null;
      opts.onStatus?.(false, "kopuk");
      scheduleRetry();
    });

    ws.addEventListener("error", () => {
      /* close handler retries */
    });
  }

  open();

  return {
    get connected() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
    close() {
      closed = true;
      clearRetry();
      try {
        ws?.close();
      } catch {
        /* */
      }
      ws = null;
    },
  };
}

/**
 * @param {string} [base]
 */
export function bridgeHttpBase(base) {
  return String(base || DEFAULT_HTTP).replace(/\/$/, "");
}

/**
 * @param {string} path
 * @param {object} [body]
 * @param {string} [base]
 */
export async function bridgePost(path, body = {}, base) {
  const url = `${bridgeHttpBase(base)}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

/**
 * @param {string} [base]
 */
export async function bridgeStatus(base) {
  const url = `${bridgeHttpBase(base)}/status`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
