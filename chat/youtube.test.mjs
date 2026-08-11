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
    // start() returns before the connect settles, so a broadcast that has not
    // begun cannot block the bridge. Wait for the outcome.
    await source.ready;
  } catch (error) {
    fatal = { error: error.message, fatal: true };
  }
  check("surfaces chat-ended", Boolean(fatal), JSON.stringify(fatal));
  source.stop();
}

/* ---------- retrying the initial connect ---------- */

/**
 * Collapses the retry backoff so a wait of minutes tests in milliseconds,
 * recording what the source would have slept for.
 *
 * Two details keep this honest. It yields a real macrotask, because a delay
 * that resolves on the microtask queue alone starves the event loop and the
 * retry spins until it hits the quota ceiling. And after `limit` waits it
 * parks forever, so each test drives an exact number of retries instead of
 * however many happen to fit in a sleep.
 */
function instantDelay(limit = Infinity) {
  const waits = [];
  const impl = async (ms) => {
    waits.push(ms);
    if (waits.length >= limit) return new Promise(() => {});
    return new Promise((resolve) => setTimeout(resolve, 0));
  };
  impl.waits = waits;
  return impl;
}

// Resolves once the source has retried `n` times, so tests wait on progress
// rather than on a fixed sleep.
async function afterWaits(delayImpl, n) {
  while (delayImpl.waits.length < n) await new Promise((r) => setTimeout(r, 1));
}

const KEY = "test-key";
const NO_VIDEO = { body: { items: [] } };
const NOT_LIVE = { body: { items: [{ snippet: {} }] } };
const NO_CHAT = { body: { items: [{ liveStreamingDetails: {} }] } };
const LIVE = { body: { items: [{ liveStreamingDetails: { activeLiveChatId: "CHAT1" } }] } };

console.log("\nconnect retries while the stream is not live yet");
{
  const script = [
    NO_VIDEO,
    NOT_LIVE,
    NO_CHAT,
    { status: 404, body: {} },
    { status: 503, body: {} },
    LIVE,
  ];
  script.last = chatPage([]);
  const fetchImpl = stubFetch(script);
  const delayImpl = instantDelay();
  const source = createYouTubeSource({ apiKey: KEY, video: "dQw4w9WgXcQ", fetchImpl, delayImpl });

  const statuses = [];
  await source.start(() => {}, (s) => statuses.push(s));
  await source.ready;

  check("retries past every not-yet-live signal", source.status().connected,
    JSON.stringify(source.status()));
  check("never reports fatal while waiting", !statuses.some((s) => s.fatal));
  check("reports waiting on each retry", statuses.filter((s) => s.waiting).length === 5,
    JSON.stringify(statuses.map((s) => s.waiting)));
  check("says the video is not there yet", statuses[0].error?.includes("No such video"),
    statuses[0].error);
  check("says the video is not live yet", statuses[1].error?.includes("not a live broadcast"),
    statuses[1].error);
  check("says the chat is not open yet", statuses[2].error?.includes("no active live chat"),
    statuses[2].error);
  check("retries a 404 liveChatNotFound", statuses[3].error?.includes("liveChatNotFound"),
    statuses[3].error);
  check("retries a 5xx", statuses[4].error?.includes("503"), statuses[4].error);
  check("clears waiting once connected", source.status().waiting === false);
  check("clears the error once connected", source.status().lastError === null,
    String(source.status().lastError));
  source.stop();
}

console.log("\nconnect backoff");
{
  const script = [];
  script.last = NO_CHAT;
  const fetchImpl = stubFetch(script);
  const delayImpl = instantDelay(6);
  const source = createYouTubeSource({ apiKey: KEY, video: "dQw4w9WgXcQ", fetchImpl, delayImpl });
  // ready never settles while waiting, which is the point: park after 6 retries.
  await source.start(() => {}, () => {});
  await afterWaits(delayImpl, 6);

  check("backs off exponentially",
    delayImpl.waits.join(",") === "5000,10000,20000,30000,30000,30000",
    delayImpl.waits.join(","));
  check("caps the backoff at 30s", delayImpl.waits.every((ms) => ms <= 30000),
    String(Math.max(...delayImpl.waits)));
  check("one call per retry, no spin", fetchImpl.calls.length === 6,
    String(fetchImpl.calls.length));
  check("waiting costs 1 unit per retry", source.status().quotaUsed === 6,
    String(source.status().quotaUsed));
  check("stays disconnected while waiting", source.status().connected === false);
  check("reports waiting", source.status().waiting === true);
  source.stop();
}

console.log("\nconnect stays fatal for real faults");
for (const [name, reason] of [
  ["keyInvalid", "keyInvalid"],
  ["accessNotConfigured", "accessNotConfigured"],
  ["forbidden", "forbidden"],
  ["quotaExceeded", "quotaExceeded"],
  ["liveChatEnded", "liveChatEnded"],
]) {
  const script = [];
  script.last = { status: 403, body: { error: { errors: [{ reason }] } } };
  const delayImpl = instantDelay();
  const source = createYouTubeSource({
    apiKey: KEY, video: "dQw4w9WgXcQ", fetchImpl: stubFetch(script), delayImpl,
  });
  const statuses = [];
  await source.start(() => {}, (s) => statuses.push(s));
  await source.ready;

  check(`${name} is fatal, not retried`, statuses.some((s) => s.fatal), JSON.stringify(statuses));
  check(`${name} never sleeps for a retry`, delayImpl.waits.length === 0,
    JSON.stringify(delayImpl.waits));
  check(`${name} does not report waiting`, source.status().waiting === false);
  source.stop();
}

console.log("\nthe retry loop respects the quota budget");
{
  const script = [];
  script.last = NO_CHAT;
  const source = createYouTubeSource({
    apiKey: KEY,
    video: "dQw4w9WgXcQ",
    fetchImpl: stubFetch(script),
    delayImpl: instantDelay(),
    dailyQuotaBudget: 3,
  });
  await source.start(() => {}, () => {});
  await source.ready;
  const status = source.status();
  check("a stream that never starts cannot drain the quota", status.quotaUsed <= 3,
    `used=${status.quotaUsed}`);
  check("stops waiting once the budget is spent", status.waiting === false);
  source.stop();
}

console.log("\nstop() ends the retry loop");
{
  const script = [];
  script.last = NO_CHAT;
  const fetchImpl = stubFetch(script);
  const delayImpl = instantDelay();
  const source = createYouTubeSource({ apiKey: KEY, video: "dQw4w9WgXcQ", fetchImpl, delayImpl });
  await source.start(() => {}, () => {});
  await afterWaits(delayImpl, 3);
  source.stop();
  const after = fetchImpl.calls.length;
  await new Promise((r) => setTimeout(r, 20));
  check("no further calls after stop", fetchImpl.calls.length === after,
    `${after} -> ${fetchImpl.calls.length}`);
  check("stop clears waiting", source.status().waiting === false);
}

console.log(failures ? `\n${failures} failing check(s)` : "\nall chat-source checks passed");
process.exit(failures ? 1 : 0);
