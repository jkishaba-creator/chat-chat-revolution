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
// Connecting before the broadcast is live is the normal case, not an error: the
// streamer starts this server, then goes live. Retry until chat exists, capped
// so a forgotten process costs at most 1 unit per 30s (~120/hour).
const CONNECT_RETRY_MS = 5000;
const MAX_CONNECT_RETRY_MS = 30000;
// Quiet chat costs the same per call as busy chat, so slow down when nobody talks.
const IDLE_BACKOFF = [
  { afterEmptyPolls: 10, ms: 12000 },
  { afterEmptyPolls: 3, ms: 8000 },
  { afterEmptyPolls: 1, ms: 6000 },
];

export class QuotaExceeded extends Error {}
export class ChatEnded extends Error {}
/** The broadcast is not ready yet. Worth retrying, unlike ChatEnded. */
export class ChatNotReady extends Error {}
/** The key or project is wrong. Retrying cannot fix it. */
export class ChatAccessDenied extends Error {}

// Error messages surface on the public /api/status endpoint, and a network
// failure can embed the request URL, so the key is stripped from any text.
function scrub(message, apiKey) {
  const text = String(message || "");
  return apiKey ? text.split(apiKey).join("[key]") : text;
}

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
  // Injectable so the retry path is testable without real time passing.
  delayImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
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
  // True while the broadcast has not started yet and we are still retrying.
  let waiting = false;
  let connectMs = CONNECT_RETRY_MS;
  let ready = Promise.resolve();
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
      // keyInvalid, accessNotConfigured, forbidden: a configuration fault.
      throw new ChatAccessDenied(`YouTube 403: ${reason}`);
    }
    // The chat resource can 404 in the gap between a video existing and its
    // chat opening, so this is only terminal once we are already polling.
    if (res.status === 404) throw new ChatNotReady("liveChatNotFound");
    if (!res.ok) throw new Error(`YouTube ${res.status}`);
    return res.json();
  }

  async function resolveChatId() {
    const url = `${API}/videos?part=liveStreamingDetails&id=${videoId}&key=${apiKey}`;
    const data = await call(url, COST_VIDEOS_LIST);
    if (!data.items?.length) throw new ChatNotReady("No such video yet");
    const details = data.items[0].liveStreamingDetails;
    if (!details) throw new ChatNotReady("That video is not a live broadcast yet");
    const id = details.activeLiveChatId;
    if (!id) throw new ChatNotReady("That broadcast has no active live chat yet");
    return id;
  }

  /**
   * Only a fault that retrying cannot fix stops the connect loop: a spent
   * quota, a bad key, or a chat that has already finished. Everything else --
   * a video that is not live yet, a 404, a 5xx, a dropped network -- is a
   * "not yet", because the streamer routinely starts this before going live.
   */
  function isFatalConnect(error) {
    return error instanceof QuotaExceeded
      || error instanceof ChatAccessDenied
      || error instanceof ChatEnded;
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

  /**
   * Retry the initial connect until the broadcast's chat exists. Runs in the
   * background: start() must return promptly or the whole bridge would block
   * behind a stream that has not begun, taking the board offline with it.
   */
  async function connectLoop(onMessages, onStatus) {
    connectMs = CONNECT_RETRY_MS;
    while (!stopped) {
      try {
        liveChatId = await resolveChatId();
        waiting = false;
        lastError = null;
        onStatus({ connected: true, waiting: false });
        beginPolling(onMessages, onStatus);
        return;
      } catch (error) {
        const message = scrub(error.message, apiKey);
        lastError = message;
        if (isFatalConnect(error)) {
          waiting = false;
          stopped = true;
          onStatus({ connected: false, waiting: false, error: message, fatal: true });
          return;
        }
        waiting = true;
        onStatus({ connected: false, waiting: true, error: message });
        await delayImpl(connectMs);
        connectMs = Math.min(MAX_CONNECT_RETRY_MS, connectMs * 2);
      }
    }
  }

  function beginPolling(onMessages, onStatus) {
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
        const message = scrub(error.message, apiKey);
        lastError = message;
        // Once connected, a vanished chat means the stream is over, not a
        // "not yet": ChatNotReady is terminal here even though the initial
        // connect retries it.
        if (error instanceof QuotaExceeded
          || error instanceof ChatEnded
          || error instanceof ChatNotReady) {
          onStatus({ connected: false, error: message, fatal: true });
          stopped = true;
          return;
        }
        // Transient failure: slow down rather than hammering the API.
        pollMs = Math.min(30000, pollMs * 2);
        onStatus({ connected: true, error: message, fatal: false });
      }
      if (!stopped) timer = setTimeout(tick, pollMs);
    };

    timer = setTimeout(tick, 0);
  }

  return {
    name: "youtube",

    async start(onMessages, onStatus = () => {}) {
      stopped = false;
      ready = connectLoop(onMessages, onStatus);
      return { pollingIntervalMillis: pollMs };
    },

    /**
     * Resolves once the connect has settled -- either polling has begun or a
     * fatal fault stopped it. Waiting for a broadcast leaves this pending,
     * which is exactly why start() does not await it.
     */
    get ready() {
      return ready;
    },

    stop() {
      stopped = true;
      waiting = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    status() {
      return {
        source: "youtube",
        connected: Boolean(liveChatId) && !stopped,
        waiting,
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
