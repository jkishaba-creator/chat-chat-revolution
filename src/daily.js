/**
 * 本日の瓦 — the Daily Kawara.
 *
 * Every player gets the same board on a given date, so results are comparable.
 * That only works if generation is player-independent: the live generator reads
 * player positions (it skips occupied cells and repairs hazards per player), so
 * two players who moved differently would consume different random draws and
 * end up on different boards. This module therefore precomputes the entire
 * sequence from the date seed alone, before anyone has moved.
 *
 * Fairness here is a stronger, position-free invariant: EVERY cell on the board
 * must have a safe cell within MAX_MOVES. If that holds, the player survives
 * wherever they happen to stand.
 */
import { COLS, ROWS, MAX_MOVES, DAILY_ROUNDS } from "./config.js";
import { rngFrom, todayKey } from "./rng.js";

const key = (x, y) => `${x},${y}`;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;
const DELTAS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/** Cells reachable from (x, y) in at most MAX_MOVES steps, avoiding blocked. */
function reachableFrom(x, y, blocked) {
  const seen = new Set([key(x, y)]);
  let frontier = [{ x, y }];
  for (let step = 0; step < MAX_MOVES; step++) {
    const next = [];
    for (const cell of frontier) {
      for (const [dx, dy] of DELTAS) {
        const nx = cell.x + dx;
        const ny = cell.y + dy;
        const k = key(nx, ny);
        if (!inBounds(nx, ny) || blocked.has(k) || seen.has(k)) continue;
        seen.add(k);
        next.push({ x: nx, y: ny });
      }
    }
    frontier = next;
  }
  return seen;
}

/** Every standable cell must be able to reach some cell that is not danger. */
function everyCellEscapes(danger, blocked) {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (blocked.has(key(x, y))) continue;
      let ok = false;
      for (const k of reachableFrom(x, y, blocked)) {
        if (!danger.has(k)) { ok = true; break; }
      }
      if (!ok) return false;
    }
  }
  return true;
}

function buildObstacles(rng, round, reserved) {
  if (round < 3) return [];
  const count = Math.min(9, Math.floor((round - 1) / 2) + 1);
  const out = [];
  let guard = 0;
  while (out.length < count && guard++ < 300) {
    const x = Math.floor(rng() * COLS);
    const y = Math.floor(rng() * ROWS);
    // The start cell must stay standable: an obstacle there would trap a
    // player who has not moved yet, since obstacles block entry and exit.
    if (reserved.has(key(x, y))) continue;
    if (out.some((o) => Math.abs(o.x - x) + Math.abs(o.y - y) <= 1)) continue;
    out.push({ x, y, kind: ["lantern", "bamboo", "pillar"][Math.floor(rng() * 3)] });
  }
  return out;
}

function buildHazards(rng, round, blocked) {
  const target = 3 + Math.round(round * 1.8);
  const free = COLS * ROWS - blocked.size;
  const cap = Math.floor(free * 0.5);

  let cells = [];
  const seed = () => {
    const picked = new Set();
    const patterns = round < 2 ? ["scatter"]
      : round < 4 ? ["scatter", "row", "col"]
      : ["scatter", "row", "col", "cross", "ring"];
    const kind = patterns[Math.floor(rng() * patterns.length)];
    const add = (x, y) => {
      if (inBounds(x, y) && !blocked.has(key(x, y))) picked.add(key(x, y));
    };
    if (kind === "row") {
      const y = Math.floor(rng() * ROWS);
      const gaps = new Set([Math.floor(rng() * COLS), Math.floor(rng() * COLS)]);
      for (let x = 0; x < COLS; x++) if (!gaps.has(x)) add(x, y);
    } else if (kind === "col") {
      const x = Math.floor(rng() * COLS);
      const gap = Math.floor(rng() * ROWS);
      for (let y = 0; y < ROWS; y++) if (y !== gap) add(x, y);
    } else if (kind === "cross") {
      const cx = 1 + Math.floor(rng() * (COLS - 2));
      const cy = 1 + Math.floor(rng() * (ROWS - 2));
      for (let x = 0; x < COLS; x++) add(x, cy);
      for (let y = 0; y < ROWS; y++) add(cx, y);
    } else if (kind === "ring") {
      const cx = 1 + Math.floor(rng() * (COLS - 2));
      const cy = 1 + Math.floor(rng() * (ROWS - 2));
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) if (dx || dy) add(cx + dx, cy + dy);
      }
    }
    let guard = 0;
    while (picked.size < target && guard++ < 400) {
      add(Math.floor(rng() * COLS), Math.floor(rng() * ROWS));
    }
    return [...picked];
  };

  cells = seed();
  while (cells.length > cap) cells.splice(Math.floor(rng() * cells.length), 1);

  // Repair until every cell on the board has an escape. Removing hazards can
  // only ever help, so this terminates: worst case it empties the board.
  let guard = 0;
  while (!everyCellEscapes(new Set(cells), blocked) && cells.length && guard++ < 200) {
    cells.splice(Math.floor(rng() * cells.length), 1);
  }

  const types = ["boulder", "tile", "bell"];
  return cells.map((k, i) => {
    const [x, y] = k.split(",").map(Number);
    return { x, y, type: round < 3 ? (i % 2 ? "tile" : "boulder") : types[Math.floor(rng() * 3)] };
  });
}

/**
 * Build a full day's round sequence plus the shared starting cell.
 * Same date in, byte-identical plan out, on any machine.
 */
export function dailyPlan(dateKey = todayKey(), rounds = DAILY_ROUNDS) {
  const rng = rngFrom(`ccr-${dateKey}`);

  // Choose the start cell first and reserve it for the whole day, so no later
  // round can drop an obstacle on the square the player begins on.
  const startCell = Math.floor(rng() * COLS * ROWS);
  const start = { x: startCell % COLS, y: Math.floor(startCell / COLS) };
  const reserved = new Set([key(start.x, start.y)]);

  const plan = [];
  for (let round = 1; round <= rounds; round++) {
    const obstacles = buildObstacles(rng, round, reserved);
    const blocked = new Set(obstacles.map((o) => key(o.x, o.y)));
    plan.push({ obstacles, hazards: buildHazards(rng, round, blocked) });
  }

  // Round 1 should not open with a tile already on the player's head.
  const first = plan[0];
  first.hazards = first.hazards.filter((h) => !(h.x === start.x && h.y === start.y));

  return { dateKey, rounds, plan, start };
}

/* ------------------------------------------------------------------ *
 * Local result tracking (browser only)
 * ------------------------------------------------------------------ */

const RESULT_KEY = "ccr-daily";
const STREAK_KEY = "ccr-daily-streak";

const yesterdayOf = (dateKey) => {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

export function readDaily(storage = globalThis.localStorage) {
  if (!storage) return { result: null, streak: 0, streakDate: null };
  let result = null;
  let streak = { count: 0, date: null };
  try {
    result = JSON.parse(storage.getItem(RESULT_KEY) || "null");
    streak = JSON.parse(storage.getItem(STREAK_KEY) || "null") || streak;
  } catch {
    // Corrupt or unreadable storage is not worth failing a game over.
  }
  return { result, streak: streak.count || 0, streakDate: streak.date || null };
}

/** Record today's scored attempt. Only the first attempt of a day counts. */
export function recordDaily(dateKey, rounds, storage = globalThis.localStorage) {
  if (!storage) return { scored: false, rounds, streak: 0 };
  const { result, streak, streakDate } = readDaily(storage);
  if (result && result.date === dateKey) {
    return { scored: false, rounds: result.rounds, streak, alreadyPlayed: true };
  }
  const next = streakDate === yesterdayOf(dateKey) ? streak + 1 : 1;
  try {
    storage.setItem(RESULT_KEY, JSON.stringify({ date: dateKey, rounds }));
    storage.setItem(STREAK_KEY, JSON.stringify({ count: next, date: dateKey }));
  } catch {
    return { scored: false, rounds, streak };
  }
  return { scored: true, rounds, streak: next };
}
