/**
 * Fake chat source with the same interface as the YouTube one, so the whole
 * bridge and game loop can be built and tested without a live broadcast.
 *
 * It deliberately imitates YouTube's awkward parts: messages arrive in batches
 * on an interval rather than individually, and the same person keeps a stable
 * channel ID across messages.
 */

const NAMES = [
  "KITSUNE99", "ramen_dad", "ShogunSam", "tanuki_tv", "HANABI", "mochi_mochi",
  "aoi_ame", "RONIN_77", "sakura_bot", "kappa_sensei", "YUKI", "TOFU_KING",
  "neko_neko", "DAIFUKU", "ZEN_MODE", "umeboshi", "genji_p", "shiba_inu",
];

const CHATTER = [
  "いくぞ", "no way", "gg", "counting squares", "why do I always go left",
  "こわい", "trust the grid", "clutch", "run run run", "lag diff", "ez",
];

const MOVES = ["l", "r", "u", "d"];
const randInt = (n) => Math.floor(Math.random() * n);

function randomPath() {
  const len = 1 + randInt(4);
  let out = "";
  for (let i = 0; i < len; i++) out += MOVES[randInt(MOVES.length)];
  return out;
}

export function createMockSource({ intervalMs = 1800, perBatch = 3, population = 14 } = {}) {
  // A stable pool, so the same channel IDs recur exactly like real viewers.
  const people = Array.from({ length: population }, (_, i) => ({
    channelId: `UC_mock_${String(i).padStart(3, "0")}`,
    name: NAMES[i % NAMES.length],
  }));

  let timer = null;
  let seq = 0;

  return {
    name: "mock",
    start(onMessages) {
      timer = setInterval(() => {
        const batch = [];
        const count = 1 + randInt(perBatch);
        for (let i = 0; i < count; i++) {
          const who = people[randInt(people.length)];
          // Mostly paths, sometimes plain chatter the parser must ignore.
          const text = Math.random() < 0.75 ? randomPath() : CHATTER[randInt(CHATTER.length)];
          batch.push({
            id: `mock-${seq++}`,
            channelId: who.channelId,
            name: who.name,
            text,
            publishedAt: new Date().toISOString(),
          });
        }
        onMessages(batch);
      }, intervalMs);
      return { pollingIntervalMillis: intervalMs };
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status() {
      return { source: "mock", connected: Boolean(timer), quotaUsed: 0, quotaLimit: null };
    },
  };
}
