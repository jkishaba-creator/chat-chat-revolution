/**
 * Headless soak of the game rules: runs thousands of rounds with no renderer,
 * checks invariants, and prints the match-length distribution used for tuning.
 * Run with: npm test
 */
import { Game, parseMoves, movesToPath, cellName } from "./src/game.js";
import { PHASE, COLS, ROWS, MAX_MOVES } from "./src/config.js";

const fail = (msg) => { throw new Error(msg); };

/* ---------------- parser ---------------- */

const parserCases = [
  ["rrud", 4], ["r r u d", 4], ["r3u", 4], ["LEFT left up", 3], ["u9", MAX_MOVES],
  ["rrrrrrrr", MAX_MOVES], ["", 0], ["hello", 0], ["lol", 0], ["cool", 0],
  ["gg wp", 0], ["down down", 2], ["  R,R>U ", 3],
];
for (const [input, expected] of parserCases) {
  const { moves } = parseMoves(input);
  if (moves.length !== expected) fail(`parse ${JSON.stringify(input)} -> ${moves.length}, expected ${expected}`);
}

const clamped = movesToPath(0, 0, ["l", "u", "r", "d"], new Set(["1,0"]));
if (cellName(clamped.at(-1).x, clamped.at(-1).y) !== "A2") fail("walls and edges should block a step, not wrap it");

/* ---------------- simulation ---------------- */

const events = [];
const game = new Game({ onEvent: (e) => events.push(e) });
const ROSTER = 11;
for (let i = 0; i < ROSTER - 1; i++) {
  game.addPlayer(`bot${i}`, { bot: true, skill: 0.35 + Math.random() * 0.55 });
}
game.setHuman("YOU");

const TICKS = 400000;
for (let i = 0; i < TICKS; i++) {
  game.update(16);
  if (game.players.length !== ROSTER) fail(`roster changed: ${game.players.length}`);
  if (game.alivePlayers().length === 0 && game.phase !== PHASE.GAMEOVER) fail("nobody alive outside game over");
  const blocked = new Set(game.obstacles.map((o) => `${o.x},${o.y}`));
  for (const p of game.players) {
    if (p.x < 0 || p.y < 0 || p.x >= COLS || p.y >= ROWS) fail(`out of bounds ${p.x},${p.y}`);
    if (p.alive && blocked.has(`${p.x},${p.y}`)) fail(`${p.name} stands inside an obstacle`);
  }
  if (game.phase === PHASE.PLAN) {
    const danger = new Set(game.hazards.map((h) => `${h.x},${h.y}`));
    for (const p of game.alivePlayers()) {
      if (!game.hasEscape(p, danger, blocked)) fail(`${p.name} has no survivable path in round ${game.round}`);
    }
  }
}

const results = events.filter((e) => e.type === "result");
const lengths = results.map((e) => Number(e.text.match(/round (\d+)/)?.[1] || 0)).filter(Boolean);
const avg = lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1);

console.log(`rounds played      ${events.filter((e) => e.type === "round").length}`);
console.log(`matches finished   ${results.length}`);
console.log(`avg match length   ${avg.toFixed(1)} rounds`);
console.log(`shortest/longest   ${Math.min(...lengths)} / ${Math.max(...lengths)} rounds`);
console.log(`elimination events ${events.filter((e) => e.type === "out").length}`);
console.log("all invariants held");
