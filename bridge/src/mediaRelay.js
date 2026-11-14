/**
 * Relays JPEG watch frames from Mac preview → phone viewers.
 * (Same picture OBS is capturing from the game.)
 */

/**
 * @param {import("ws").WebSocket} ws
 * @param {Set<import("ws").WebSocket>} clients
 * @param {(…args: unknown[]) => void} [log]
 */
export function attachWatchRelay(ws, clients, log) {
  ws.__wantWatch = false;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.channel === "watch-sub") {
      ws.__wantWatch = true;
      log?.("[watch] viewer subscribed");
      return;
    }
    if (msg.channel === "watch-unsub") {
      ws.__wantWatch = false;
      return;
    }
    if (msg.channel === "watch" && typeof msg.jpeg === "string") {
      // Preview publisher → all phone viewers
      const payload = typeof raw === "string" ? raw : String(raw);
      for (const c of clients) {
        if (c !== ws && c.readyState === 1 && c.__wantWatch) {
          c.send(payload);
        }
      }
    }
  });
}
