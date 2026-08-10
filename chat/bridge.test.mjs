/**
 * Stresses the live-chat path: a crowd joining mid-match, duplicate messages,
 * name changes, plain conversation, and a board pushed to capacity.
 * Run with: npm run test:chat
 */
import { ChatBridge } from "./bridge.js";
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

bridge.stop();
console.log(failures ? `\n${failures} failing check(s)` : "\nall bridge checks passed");
process.exit(failures ? 1 : 0);
