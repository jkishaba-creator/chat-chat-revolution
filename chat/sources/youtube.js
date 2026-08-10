/**
 * YouTube live chat poller.
 *
 * Reads a public broadcast's live chat with a plain API key. The expensive
 * search.list endpoint is never used: the chat ID comes from videos.list,
 * which costs 1 unit, so a whole stream fits inside the daily quota.
 *
 * Quota discipline, in order of importance:
 *   1. Honour pollingIntervalMillis from every response. Polling faster than
 *      YouTube's refresh rate returns rateLimitExceeded and wastes units.
 *   2. Back off when chat is quiet, so an idle stream costs almost nothing.
 *   3. Stop entirely at a self-imposed daily budget, well under the 10,000
 *      unit allocation, so this can never starve other calls on the project.
 */

const API = "https://www.googleapis.com/youtube/v3";

// Documented per-call costs. videos.list and liveChatMessages.list are both
// "list" methods on the Data API, billed at 1 unit each.
const COST_VIDEOS_LIST = 1;
const COST_CHAT_LIST = 1;

const DEFAULT_POLL_MS = 5000;
const MIN_POLL_MS = 2000;
// Quiet chat costs the same per call as busy chat, so slow down when nobody talks.
const IDLE_BACKOFF = [
  { afterEmptyPolls: 10, ms: 12000 },
  { afterEmptyPolls: 3, ms: 8000 },
  { afterEmptyPolls: 1, ms: 6000 },
];

export class QuotaExceeded extends Error {}
export class ChatEnded extends Error {}

function extractVideoId(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  // Bare 11-character video ID.
  if (/^[\w-]{11}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.hostname === "youtu.be") return url.pathname.slice(1, 12) || null;
    const v = url.searchParams.get("v");
    if (v) return v.slice(0, 11);
    const live = url.pathname.match(/\/live\/([\w-]{11})/);
    if (live) return live[1];
  } catch {
    return null;
  }
  return null;
}

export function createYouTubeSource({
  apiKey,
  video,
  dailyQuotaBudget = 9000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error("YOUTUBE_API_KEY is required");
  const videoId = extractVideoId(video);
  if (!videoId) throw new Error(`Could not read a video ID from ${JSON.stringify(video)}`);

  let quotaUsed = 0;
  let quotaDay = new Date().toISOString().slice(0, 10);
  let liveChatId = null;
  let pageToken = null;
  let emptyPolls = 0;
  let timer = null;
  let stopped = false;
  let lastError = null;
  let pollMs = DEFAULT_POLL_MS;
  // The first response replays chat backlog; those are commands for rounds that
  // already ended, so the first batch is counted but never played.
  let primed = false;

  function spend(units) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== quotaDay) {
      quotaDay = today;
      quotaUsed = 0;
    }
    if (quotaUsed + units > dailyQuotaBudget) throw new QuotaExceeded("Daily quota budget reached");
    quotaUsed += units;
  }

  async function call(url, units) {
    spend(units);
    const res = await fetchImpl(url);
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      const reason = body?.error?.errors?.[0]?.reason || "forbidden";
      if (reason === "quotaExceeded") throw new QuotaExceeded("YouTube reports quotaExceeded");
      if (reason === "liveChatEnded" || reason === "liveChatDisabled") throw new ChatEnded(reason);
      throw new Error(`YouTube 403: ${reason}`);
    }
    if (res.status === 404) throw new ChatEnded("liveChatNotFound");
    if (!res.ok) throw new Error(`YouTube ${res.status}`);
    return res.json();
  }

  async function resolveChatId() {
    const url = `${API}/videos?part=liveStreamingDetails&id=${videoId}&key=${apiKey}`;
    const data = await call(url, COST_VIDEOS_LIST);
    const details = data.items?.[0]?.liveStreamingDetails;
    if (!details) throw new ChatEnded("That video is not a live broadcast");
    const id = details.activeLiveChatId;
    if (!id) throw new ChatEnded("That broadcast has no active live chat");
    return id;
  }

  function nextDelay(batchSize, serverInterval) {
    const floor = Math.max(MIN_POLL_MS, serverInterval || DEFAULT_POLL_MS);
    if (batchSize > 0) {
      emptyPolls = 0;
      return floor;
    }
    emptyPolls += 1;
    const rule = IDLE_BACKOFF.find((r) => emptyPolls >= r.afterEmptyPolls);
    return Math.max(floor, rule ? rule.ms : floor);
  }

  return {
    name: "youtube",

    async start(onMessages, onStatus = () => {}) {
      stopped = false;
      liveChatId = await resolveChatId();
      onStatus({ connected: true, liveChatId });

      const tick = async () => {
        if (stopped) return;
        try {
          const params = new URLSearchParams({
            liveChatId,
            part: "snippet,authorDetails",
            maxResults: "200",
            key: apiKey,
          });
          if (pageToken) params.set("pageToken", pageToken);
          const data = await call(`${API}/liveChat/messages?${params}`, COST_CHAT_LIST);

          pageToken = data.nextPageToken || pageToken;
          const items = data.items || [];

          if (primed && items.length) {
            const batch = items.map((item) => ({
              id: item.id,
              channelId: item.authorDetails?.channelId,
              name: item.authorDetails?.displayName || "viewer",
              text: item.snippet?.displayMessage
                || item.snippet?.textMessageDetails?.messageText
                || "",
              publishedAt: item.snippet?.publishedAt,
            })).filter((m) => m.channelId && m.text);
            if (batch.length) onMessages(batch);
          }
          primed = true;

          if (data.offlineAt) throw new ChatEnded("Stream went offline");
          pollMs = nextDelay(items.length, data.pollingIntervalMillis);
          lastError = null;
        } catch (error) {
          lastError = error.message;
          if (error instanceof QuotaExceeded || error instanceof ChatEnded) {
            onStatus({ connected: false, error: error.message, fatal: true });
            stopped = true;
            return;
          }
          // Transient failure: slow down rather than hammering the API.
          pollMs = Math.min(30000, pollMs * 2);
          onStatus({ connected: true, error: error.message, fatal: false });
        }
        if (!stopped) timer = setTimeout(tick, pollMs);
      };

      timer = setTimeout(tick, 0);
      return { pollingIntervalMillis: pollMs };
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    status() {
      return {
        source: "youtube",
        connected: Boolean(liveChatId) && !stopped,
        videoId,
        quotaUsed,
        quotaLimit: dailyQuotaBudget,
        pollMs,
        lastError,
      };
    },
  };
}

export { extractVideoId };
