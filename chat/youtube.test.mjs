/**
 * Verifies the YouTube source against a stubbed API: quota accounting, backlog
 * suppression, idle backoff, and fatal-error handling. Run with: npm run test:chat
 */
import { createYouTubeSource, extractVideoId, QuotaExceeded } from "./sources/youtube.js";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

/* ---------- video ID parsing ---------- */

console.log("video id extraction");
check("bare id", extractVideoId("dQw4w9WgXcQ") === "dQw4w9WgXcQ");
check("watch url", extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ") === "dQw4w9WgXcQ");
check("short url", extractVideoId("https://youtu.be/dQw4w9WgXcQ") === "dQw4w9WgXcQ");
check("live url", extractVideoId("https://www.youtube.com/live/dQw4w9WgXcQ") === "dQw4w9WgXcQ");
check("garbage", extractVideoId("not a video") === null);
check("empty", extractVideoId("") === null);

/* ---------- polling behaviour ---------- */

function stubFetch(script) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const step = script.shift() || script.last;
    return {
      ok: step.status ? step.status < 400 : true,
      status: step.status || 200,
      json: async () => step.body,
    };
  };
  impl.calls = calls;
  return impl;
}

const chatPage = (items, extra = {}) => ({
  body: { items, nextPageToken: "tok", pollingIntervalMillis: 3000, ...extra },
});

console.log("\npolling");
{
  const script = [
    { body: { items: [{ liveStreamingDetails: { activeLiveChatId: "CHAT1" } }] } },
    // Backlog replay: must not reach the game.
    chatPage([{
      id: "old-1",
      authorDetails: { channelId: "UC1", displayName: "old" },
      snippet: { displayMessage: "rr" },
    }]),
    chatPage([{
      id: "new-1",
      authorDetails: { channelId: "UC2", displayName: "fresh" },
      snippet: { displayMessage: "ud" },
    }]),
  ];
  script.last = chatPage([]);

  const fetchImpl = stubFetch(script);
  const source = createYouTubeSource({ apiKey: "k", video: "dQw4w9WgXcQ", fetchImpl });

  const received = [];
  await source.start((batch) => received.push(...batch));
  // The stub advertises a 3s polling interval and the source honours it,
  // so wait past one full cycle for the second (live) batch.
  await new Promise((r) => setTimeout(r, 3500));
  source.stop();

  check("resolves chat id via videos.list", fetchImpl.calls[0].includes("/videos?"));
  check("never calls search.list", !fetchImpl.calls.some((u) => u.includes("/search")));
  check("drops the backlog batch", !received.some((m) => m.id === "old-1"),
    JSON.stringify(received.map((m) => m.id)));
  check("delivers live messages", received.some((m) => m.id === "new-1"),
    JSON.stringify(received.map((m) => m.id)));
  const msg = received.find((m) => m.id === "new-1");
  check("maps channel id and name", msg?.channelId === "UC2" && msg?.name === "fresh");

  const status = source.status();
  check("counts quota per call", status.quotaUsed >= 2, `used=${status.quotaUsed}`);
  check("quota stays tiny", status.quotaUsed < 10, `used=${status.quotaUsed}`);
}

/* ---------- quota ceiling ---------- */

console.log("\nquota ceiling");
{
  const script = [];
  script.last = { body: { items: [{ liveStreamingDetails: { activeLiveChatId: "C" } }] } };
  const source = createYouTubeSource({
    apiKey: "k", video: "dQw4w9WgXcQ", fetchImpl: stubFetch(script), dailyQuotaBudget: 1,
  });
  await source.start(() => {});
  await new Promise((r) => setTimeout(r, 120));
  const status = source.status();
  check("stops at the budget", status.quotaUsed <= 1, `used=${status.quotaUsed}`);
  check("reports the stall", Boolean(status.lastError), status.lastError || "no error recorded");
  source.stop();
}

/* ---------- fatal errors ---------- */

console.log("\nfatal errors");
{
  const script = [];
  script.last = { status: 403, body: { error: { errors: [{ reason: "liveChatEnded" }] } } };
  const source = createYouTubeSource({ apiKey: "k", video: "dQw4w9WgXcQ", fetchImpl: stubFetch(script) });
  let fatal = null;
  try {
    await source.start(() => {}, (s) => { if (s.fatal) fatal = s; });
  } catch (error) {
    fatal = { error: error.message, fatal: true };
  }
  check("surfaces chat-ended", Boolean(fatal), JSON.stringify(fatal));
  source.stop();
}

console.log(failures ? `\n${failures} failing check(s)` : "\nall chat-source checks passed");
process.exit(failures ? 1 : 0);
