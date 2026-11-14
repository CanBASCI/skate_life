/**
 * Same LiveEvent shape as preview/liveBridge.js — keep fields in sync.
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

/**
 * @param {Partial<LiveEvent> & { user: { id?: string, name: string } }} opts
 * @returns {LiveEvent}
 */
export function makeLiveEvent(opts) {
  const name = String(opts.user?.name || "anon").trim() || "anon";
  const id =
    String(opts.user?.id || "").trim() ||
    `u_${name.toLowerCase().replace(/[^a-z0-9]+/gi, "_")}`;
  return {
    platform: opts.platform || "sim",
    type: opts.type || "comment",
    user: { id, name },
    text: opts.text != null ? String(opts.text) : undefined,
    team: opts.team ?? null,
    likeCount: opts.likeCount,
    raw: opts.raw,
  };
}
