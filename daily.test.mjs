/**
 * The Daily Kawara's whole promise is that every player gets the same board,
 * and that the board is always survivable no matter where you stand.
 * Run with: npm run test:daily
 */
import { execFileSync } from "node:child_process";
import { dailyPlan, recordDaily, readDaily } from "./src/daily.js";
import { COLS, ROWS, MAX_MOVES, DAILY_ROUNDS } from "./src/config.js";
import { rngFrom, hashSeed, todayKey } from "./src/rng.js";

let failures = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures += 1; console.log(`  FAIL ${name} ${detail}`); }
};

const key = (x, y) => `${x},${y}`;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;
const DELTAS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function escapesFrom(x, y, danger, blocked) {
  const seen = new Set([key(x, y)]);
  let frontier = [{ x, y }];
  if (!danger.has(key(x, y))) return true;
  for (let step = 0; step < MAX_MOVES; step++) {
    const next = [];
    for (const cell of frontier) {
      for (const [dx, dy] of DELTAS) {
        const nx = cell.x + dx;
        const ny = cell.y + dy;
        const k = key(nx, ny);
        if (!inBounds(nx, ny) || blocked.has(k) || seen.has(k)) continue;
        if (!danger.has(k)) return true;
        seen.add(k);
        next.push({ x: nx, y: ny });
      }
    }
    frontier = next;
  }
  return false;
}

/* ---------------- PRNG ---------------- */

console.log("seeded rng");
{
  const a = rngFrom("ccr-2026-08-10");
  const b = rngFrom("ccr-2026-08-10");
  const c = rngFrom("ccr-2026-08-11");
  const seqA = Array.from({ length: 12 }, () => a());
  const seqB = Array.from({ length: 12 }, () => b());
  const seqC = Array.from({ length: 12 }, () => c());
  check("same seed gives the same sequence", seqA.join() === seqB.join());
  check("different seed diverges", seqA.join() !== seqC.join());
  check("stays in [0,1)", seqA.every((v) => v >= 0 && v < 1));
  check("hash is a uint32", Number.isInteger(hashSeed("x")) && hashSeed("x") >= 0);
  check("today key is ISO date", /^\d{4}-\d{2}-\d{2}$/.test(todayKey()));
}

/* ---------------- determinism ---------------- */

console.log("\nplan determinism");
{
  const one = dailyPlan("2026-08-10");
  const two = dailyPlan("2026-08-10");
  const other = dailyPlan("2026-08-11");
  check("identical in-process", JSON.stringify(one) === JSON.stringify(two));
  check("differs by date", JSON.stringify(one) !== JSON.stringify(other));
  check("has the full round count", one.plan.length === DAILY_ROUNDS);
  check("start cell is on the board", inBounds(one.start.x, one.start.y));

  // The real risk is a machine-to-machine difference, so verify across processes.
  const script = 'import("./src/daily.js").then(m=>console.log(JSON.stringify(m.dailyPlan("2026-08-10"))))';
  const child = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8",
  }).trim();
  check("identical in a fresh process", child === JSON.stringify(one),
    child === JSON.stringify(one) ? "" : "cross-process plan mismatch");
}

/* ---------------- fairness ---------------- */

console.log("\nevery cell can escape, every round, every date");
{
  let checked = 0;
  let worst = null;
  for (let day = 0; day < 120; day++) {
    const d = new Date(Date.UTC(2026, 0, 1));
    d.setUTCDate(d.getUTCDate() + day * 3);
    const dateKey = d.toISOString().slice(0, 10);
    const { plan, start } = dailyPlan(dateKey);
    for (const [i, round] of plan.entries()) {
      const blocked = new Set(round.obstacles.map((o) => key(o.x, o.y)));
      const danger = new Set(round.hazards.map((h) => key(h.x, h.y)));
      if (blocked.has(key(start.x, start.y))) worst = `${dateKey} start inside obstacle`;
      for (let y = 0; y < ROWS && !worst; y++) {
        for (let x = 0; x < COLS; x++) {
          if (blocked.has(key(x, y))) continue;
          if (!escapesFrom(x, y, danger, blocked)) {
            worst = `${dateKey} round ${i + 1}: no escape from ${key(x, y)}`;
            break;
          }
        }
      }
      checked += 1;
      if (worst) break;
    }
    if (worst) break;
  }
  check(`all cells escape across ${checked} generated rounds`, !worst, worst || "");
}

/* ---------------- streaks ---------------- */

console.log("\nresult and streak tracking");
{
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
  };
  const first = recordDaily("2026-08-10", 12, storage);
  check("first attempt scores", first.scored && first.streak === 1, JSON.stringify(first));

  const repeat = recordDaily("2026-08-10", 40, storage);
  check("second attempt same day does not score", !repeat.scored && repeat.alreadyPlayed);
  check("repeat keeps the original score", repeat.rounds === 12, `rounds=${repeat.rounds}`);

  const next = recordDaily("2026-08-11", 9, storage);
  check("consecutive day extends the streak", next.streak === 2, `streak=${next.streak}`);

  const skipped = recordDaily("2026-08-20", 5, storage);
  check("a missed day resets the streak", skipped.streak === 1, `streak=${skipped.streak}`);

  const read = readDaily(storage);
  check("state reads back", read.result.date === "2026-08-20" && read.streak === 1);
  check("no storage degrades quietly", readDaily(null).streak === 0);
}

console.log(failures ? `\n${failures} failing check(s)` : "\nall daily checks passed");
process.exit(failures ? 1 : 0);
