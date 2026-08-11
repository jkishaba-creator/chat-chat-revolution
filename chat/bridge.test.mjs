/**
 * Stresses the live-chat path: a crowd joining mid-match, duplicate messages,
 * name changes, plain conversation, and a board pushed to capacity.
 * Run with: npm run test:chat
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatBridge } from "./bridge.js";
import { ProfileStore } from "./store.js";
import { PHASE, COLS, ROWS, MAX_CHATTERS } from "../src/config.js";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name} ${detail}`); }
};

const bridge = new ChatBridge({ source: null, botFill: 4 });
const game = bridge.game;

let seq = 0;
const say = (channelId, name, text) =>
  bridge.handleMessages([{ id: `m${seq++}`, channelId, name, text }]);

console.log("chat intake");

// Plain conversation must never move anyone.
say("UC_talk", "talker", "hello everyone");
const talker = game.findByKey("UC_talk");
check("conversation does not seat a player", talker === null);

// A move command seats the sender.
say("UC_a", "AoiAme", "rru");
const a = game.findByKey("UC_a");
check("move command seats the sender", Boolean(a));
check("player carries the channel id", a?.externalKey === "UC_a");

// Identity follows the channel ID, not the display name.
say("UC_a", "AoiAme_RENAMED", "ll");
check("rename keeps one player", game.players.filter((p) => p.externalKey === "UC_a").length === 1);
check("rename updates the label", game.findByKey("UC_a").name === "AoiAme_RENAMED");

// A resent message must not overwrite a chosen path.
const before = [...game.findByKey("UC_a").queue];
bridge.handleMessages([{ id: "dup-1", channelId: "UC_a", name: "AoiAme", text: "uuuuu" }]);
bridge.handleMessages([{ id: "dup-1", channelId: "UC_a", name: "AoiAme", text: "ddddd" }]);
const afterDup = game.findByKey("UC_a").queue.join("");
check("duplicate message id is ignored", afterDup !== "ddddd", `queue=${afterDup} before=${before.join("")}`);

/* ---------- crowd ---------- */

console.log("\ncrowd and capacity");
for (let i = 0; i < 60; i++) say(`UC_crowd_${i}`, `viewer${i}`, "rl");

check("roster is capped", game.players.length <= MAX_CHATTERS,
  `players=${game.players.length} cap=${MAX_CHATTERS}`);
check("overflow is queued, not dropped", game.waiting.length > 0, `waiting=${game.waiting.length}`);
check("real people displaced the bots", game.players.filter((p) => p.bot).length === 0,
  `bots=${game.players.filter((p) => p.bot).length}`);

const keys = game.players.map((p) => p.externalKey).filter(Boolean);
check("no duplicate channel ids seated", new Set(keys).size === keys.length);

/* ---------- long run ---------- */

console.log("\nsimulated broadcast");
let ticks = 0;
let maxAlive = 0;
const cells = COLS * ROWS;

for (let i = 0; i < 40000; i++) {
  game.update(16);
  ticks += 1;

  // A trickle of new arrivals and ongoing commands, like a real stream.
  if (i % 97 === 0) say(`UC_late_${i}`, `late${i}`, "ud");
  if (i % 31 === 0) say(`UC_crowd_${i % 60}`, `viewer${i % 60}`, "rrl");

  maxAlive = Math.max(maxAlive, game.alivePlayers().length);

  if (game.players.length > MAX_CHATTERS) {
    check("roster never exceeds the cap", false, `players=${game.players.length}`);
    break;
  }

  // Nobody may stand on an obstacle, and everyone must have an escape.
  const blocked = new Set(game.obstacles.map((o) => `${o.x},${o.y}`));
  for (const p of game.players) {
    if (p.x < 0 || p.y < 0 || p.x >= COLS || p.y >= ROWS) {
      check("positions stay on the board", false, `${p.name} at ${p.x},${p.y}`);
      i = Infinity; break;
    }
    if (p.alive && blocked.has(`${p.x},${p.y}`)) {
      check("nobody spawns inside an obstacle", false, `${p.name} at ${p.x},${p.y}`);
      i = Infinity; break;
    }
  }
  if (game.phase === PHASE.PLAN) {
    const danger = new Set(game.hazards.map((h) => `${h.x},${h.y}`));
    for (const p of game.alivePlayers()) {
      if (!game.hasEscape(p, danger, blocked)) {
        check("every player has an escape", false, `${p.name} round ${game.round}`);
        i = Infinity; break;
      }
    }
  }
}

check("simulation ran to completion", ticks >= 39000, `ticks=${ticks}`);
check("board stayed within capacity", maxAlive <= cells, `maxAlive=${maxAlive} cells=${cells}`);
// Seats must rotate: people who kept playing should hold seats, and the
// original crowd must not own the board forever while a queue waits.
const seatedLate = game.players.filter((p) => String(p.externalKey).startsWith("UC_late_")).length;
check("seats rotate to newer chatters", seatedLate > 0,
  `seated late arrivals=${seatedLate}, waiting=${game.waiting.length}`);
// An unbounded queue would grow with every arrival and starve latecomers.
check("waiting list stays bounded", game.waiting.length <= game.maxWaiting,
  `waiting=${game.waiting.length} cap=${game.maxWaiting}`);
check("commands were accepted", bridge.stats.commands > 0, JSON.stringify(bridge.stats));
check("conversation was ignored, not executed", bridge.stats.ignored > 0, JSON.stringify(bridge.stats));

const snap = bridge.snapshot();
check("snapshot serialises", JSON.stringify(snap).length > 100);
check("snapshot carries players", snap.players.length === game.players.length);
check("snapshot carries the en-mark field", "enMark" in snap);

bridge.stop();

/* ---------- en-marks ---------- */

console.log("\n縁 en-marks");
{
  const b = new ChatBridge({ source: null, botFill: 0 });
  const g = b.game;
  for (let i = 0; i < 8; i++) g.addPlayer(`p${i}`, { bot: false, externalKey: `UC_e${i}` });

  // Force a known en-mark rather than waiting for one to be generated.
  g.hazards = [{ x: 5, y: 3, type: "tile" }, { x: 5, y: 4, type: "tile" }, { x: 4, y: 3, type: "bell" }];
  g.enMark = { x: 5, y: 3, required: 3 };

  const shelter = g.enMarkShelter();
  check("shelter covers the mark and its neighbours", shelter.size === 9, `size=${shelter.size}`);

  // Too few: everyone on the mark dies.
  const alive = g.alivePlayers();
  alive.forEach((p, i) => { p.x = i < 2 ? 5 : 0; p.y = i < 2 ? 3 : i; });
  g.settleImpact();
  check("an under-strength gathering is crushed", !g.enMarkResult.held
    && alive.slice(0, 2).every((p) => !p.alive), JSON.stringify(g.enMarkResult));

  // Enough bodies: everyone on the mark lives, and the ring is spared.
  const b2 = new ChatBridge({ source: null, botFill: 0 });
  const g2 = b2.game;
  for (let i = 0; i < 8; i++) g2.addPlayer(`q${i}`, { bot: false, externalKey: `UC_f${i}` });
  g2.hazards = [{ x: 5, y: 3, type: "tile" }, { x: 5, y: 4, type: "tile" }, { x: 4, y: 3, type: "bell" }];
  g2.enMark = { x: 5, y: 3, required: 3 };
  const crowd = g2.alivePlayers();
  crowd.forEach((p, i) => {
    if (i < 3) { p.x = 5; p.y = 3; }        // on the mark
    else if (i === 3) { p.x = 5; p.y = 4; }  // sheltered neighbour
    else { p.x = 0; p.y = i - 4; }
  });
  g2.settleImpact();
  check("a full gathering survives", g2.enMarkResult.held && crowd.slice(0, 3).every((p) => p.alive),
    JSON.stringify(g2.enMarkResult));
  check("neighbouring hazards are cancelled", crowd[3].alive, "sheltered neighbour died");

  b.stop();
  b2.stop();
}

/* ---------- persistence ---------- */

console.log("\npersistent profiles");
{
  const dir = mkdtempSync(join(tmpdir(), "ccr-store-"));
  try {
    const store = new ProfileStore({ dir, season: "TEST-S1" });
    check("starts in file mode", store.mode === "file", store.error || "");

    store.recordRound("UC_1", "KITSUNE99", { survived: true, roundsSurvived: 3 });
    store.recordRound("UC_1", "KITSUNE99", { survived: true, roundsSurvived: 4 });
    store.recordWin("UC_1", "KITSUNE99", 4);
    store.recordRound("UC_2", "ramen_dad", { survived: false, roundsSurvived: 1 });
    store.close();

    check("writes a file", existsSync(join(dir, "profiles.json")));

    // The point of the feature: a restart must not lose history.
    const reopened = new ProfileStore({ dir, season: "TEST-S1" });
    const top = reopened.leaderboard();
    check("survives a restart", top.length === 2, JSON.stringify(top));
    check("accumulates across sessions", top[0].name === "KITSUNE99" && top[0].wins === 1,
      JSON.stringify(top[0]));
    check("tracks the best round", top[0].bestRound === 4, JSON.stringify(top[0]));

    reopened.recordWin("UC_1", "KITSUNE99", 9);
    check("increments on a later session", reopened.leaderboard()[0].wins === 2);

    // A rename must follow the channel id, not split the record.
    reopened.recordRound("UC_1", "KITSUNE_RENAMED", { survived: true, roundsSurvived: 2 });
    const renamed = reopened.leaderboard();
    check("a rename keeps one row", renamed.length === 2, JSON.stringify(renamed));
    check("a rename updates the label", renamed[0].name === "KITSUNE_RENAMED", JSON.stringify(renamed[0]));

    // Seasons are isolated, so a reset never destroys the old table.
    const nextSeason = new ProfileStore({ dir, season: "TEST-S2" });
    check("a new season starts empty", nextSeason.leaderboard().length === 0);
    nextSeason.close();
    reopened.close();

    const back = new ProfileStore({ dir, season: "TEST-S1" });
    check("the old season is still intact", back.leaderboard().length === 2);
    back.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // An unwritable directory must degrade, never throw: Railway without a volume.
  let degraded = null;
  try {
    degraded = new ProfileStore({ dir: "/proc/ccr-cannot-write", season: "TEST" });
  } catch (error) {
    check("unwritable dir does not throw", false, error.message);
  }
  if (degraded) {
    check("unwritable dir degrades to memory", degraded.mode === "memory", degraded.mode);
    degraded.recordWin("UC_x", "someone", 5);
    check("still serves from memory", degraded.leaderboard()[0]?.wins === 1);
    check("reports the storage mode", degraded.status().storage === "memory");
    degraded.close();
  }

  // Wired end to end: a bridge with a store records a real win.
  const dir2 = mkdtempSync(join(tmpdir(), "ccr-store2-"));
  try {
    const store = new ProfileStore({ dir: dir2, season: "TEST-S1" });
    const b = new ChatBridge({ source: null, botFill: 0, store });
    const g = b.game;
    const winner = g.addPlayer("CHAMP", { bot: false, externalKey: "UC_champ" });
    const loser = g.addPlayer("OTHER", { bot: false, externalKey: "UC_other" });
    g.hazards = [{ x: loser.x, y: loser.y, type: "tile" }];
    g.enMark = null;
    winner.roundsSurvived = 6;
    g.settleImpact();
    const table = store.leaderboard();
    check("a bridge win reaches the store", table.some((r) => r.name === "CHAMP" && r.wins === 1),
      JSON.stringify(table));
    check("status exposes the leaderboard", Array.isArray(b.status().leaderboard));
    b.stop();
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
}
/* ---------- status keeps the two "waiting" meanings apart ---------- */

console.log("\nstatus fields");
{
  // The source reports waiting:true for "the broadcast has not started", while
  // the bridge's own waiting is the seat queue. One must not clobber the other.
  const source = {
    name: "stub",
    async start() { return { pollingIntervalMillis: 0 }; },
    stop() {},
    status: () => ({ source: "youtube", connected: false, waiting: true, videoId: "vid" }),
  };
  const b = new ChatBridge({ source, botFill: 0 });
  for (let i = 0; i < 40; i++) {
    b.handleMessages([{ id: `m${i}`, channelId: `UC${i}`, name: `p${i}`, text: "r" }]);
  }
  const status = b.status();

  check("queue count survives", status.waiting === b.game.waiting.length && status.waiting > 0,
    `waiting=${status.waiting} queue=${b.game.waiting.length}`);
  check("source waiting is surfaced separately", status.sourceWaiting === true,
    JSON.stringify({ waiting: status.waiting, sourceWaiting: status.sourceWaiting }));
  check("still reports the video", status.videoId === "vid");
  b.stop();

  const off = new ChatBridge({ source: null, botFill: 0 });
  check("no source means not waiting", off.status().sourceWaiting === false);
  off.stop();
}

console.log(failures ? `\n${failures} failing check(s)` : "\nall bridge checks passed");
process.exit(failures ? 1 : 0);
