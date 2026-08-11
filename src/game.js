import {
  COLS, ROWS, MAX_MOVES, PHASE, TIMING, planMs, PLAN_FLOOR_SOLO, MAX_CHATTERS,
  EN_MARK_MIN_ROUND, EN_MARK_MIN_PLAYERS, EN_MARK_MIN_REQUIRED, EN_MARK_MAX_REQUIRED,
  SKINS, BOT_NAMES, COL_LABELS,
} from "./config.js";

const DIRS = { l: [-1, 0], r: [1, 0], u: [0, -1], d: [0, 1] };

const key = (x, y) => `${x},${y}`;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;

export const cellName = (x, y) => `${COL_LABELS[x]}${y + 1}`;

/**
 * Turn a chat message into a list of moves.
 * Accepts "rrud", "r r u d", "r3u", "left left up", mixed case and punctuation.
 * Returns { moves, matched } where matched is false when nothing move-like was found.
 */
export function parseMoves(raw) {
  const text = String(raw || "").toLowerCase().trim()
    .replace(/\bleft\b/g, "l").replace(/\bright\b/g, "r")
    .replace(/\bup\b/g, "u").replace(/\bdown\b/g, "d");

  // A message only counts as a path when it contains nothing but moves.
  // Otherwise "hello" would walk you two squares left.
  if (!text || !/^[lrud\d\s,.>+-]+$/.test(text)) return { moves: [], matched: false };

  const moves = [];
  let matched = false;
  const re = /([lrud])(\d{0,2})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    matched = true;
    const count = m[2] ? Math.min(parseInt(m[2], 10), MAX_MOVES) : 1;
    for (let i = 0; i < count && moves.length < MAX_MOVES; i++) moves.push(m[1]);
  }
  return { moves, matched: matched && moves.length > 0 };
}

export function movesToPath(startX, startY, moves, blocked) {
  const path = [{ x: startX, y: startY }];
  let x = startX;
  let y = startY;
  for (const mv of moves) {
    const [dx, dy] = DIRS[mv] || [0, 0];
    const nx = x + dx;
    const ny = y + dy;
    if (inBounds(nx, ny) && !blocked.has(key(nx, ny))) {
      x = nx;
      y = ny;
    }
    path.push({ x, y });
  }
  return path;
}

export class Game {
  constructor({
    onEvent,
    snapMotion = false,
    planFloor = PLAN_FLOOR_SOLO,
    maxPlayers = MAX_CHATTERS,
    rng = Math.random,
    plan = null,
    solo = false,
  } = {}) {
    this.onEvent = onEvent || (() => {});
    // Injectable so the Daily Kawara can reproduce a board from a date seed.
    // Everything random in the rules layer must go through this.
    this.rng = rng;
    // A precomputed round sequence. When present, startRound() consumes it
    // instead of generating, which is what makes a shared daily seed possible.
    this.plan = plan;
    // Solo runs end on the player's own death, not on last-one-standing.
    this.solo = solo;
    // With reduced motion the token jumps square to square instead of sliding.
    this.snapMotion = snapMotion;
    this.planFloor = planFloor;
    this.maxPlayers = maxPlayers;
    // Deep enough that a seat is worth waiting for, shallow enough that the
    // wait is measured in a couple of matches rather than never.
    this.maxWaiting = maxPlayers * 2;
    this.reset(true);
  }

  reset(firstRun = false) {
    this.round = 0;
    this.phase = PHASE.BREAK;
    this.hazards = [];
    this.obstacles = [];
    this.effects = [];
    this.shake = 0;
    this.winner = null;
    this.enMark = null;
    this.enMarkResult = null;

    if (firstRun) {
      this.clock = 0;
      this.phaseDuration = 900;
      this.phaseEndsAt = 900;
      this.players = [];
      this.nextBotId = 0;
      this.humanId = null;
      this.planDuration = planMs(1, this.planFloor);
      this.waiting = [];
      return;
    }

    this.enterPhase(PHASE.BREAK, 1400);
    // A fresh match is the one moment seats free up for anyone who was queued.
    this.admitWaiting();
    for (const p of this.players) {
      p.alive = true;
      p.spectating = false;
      p.pendingEntry = false;
      p.queue = [];
      p.path = null;
      p.stepIndex = 0;
      p.plannedThisRound = false;
      p.roundsSurvived = 0;
      const spot = this.freeSpawn();
      if (spot) {
        p.x = spot.x; p.y = spot.y;
        p.rx = spot.x; p.ry = spot.y;
      }
    }
    this.emit("system", "New match. Everyone respawns.");
  }

  emit(type, text, meta) {
    this.onEvent({ type, text, meta });
  }

  randInt(n) {
    return Math.floor(this.rng() * n);
  }

  pick(arr) {
    return arr[this.randInt(arr.length)];
  }

  enterPhase(phase, ms) {
    this.phase = phase;
    this.phaseDuration = ms;
    this.phaseEndsAt = this.clock + ms;
  }

  /* ------------------------------------------------------------------ *
   * Players
   * ------------------------------------------------------------------ */

  addPlayer(name, { bot = false, skill = 0.8, externalKey = null } = {}) {
    const spot = this.freeSpawn();
    if (!spot) return null; // Board is full.
    const id = `${bot ? "bot" : "you"}-${this.nextBotId++}`;
    const player = {
      id, name, bot, skill, externalKey,
      skin: SKINS[this.players.length % SKINS.length],
      x: spot.x, y: spot.y,
      rx: spot.x, ry: spot.y,
      alive: true,
      queue: [],
      path: null,
      stepIndex: 0,
      bumped: false,
      roundsSurvived: 0,
      plannedThisRound: false,
      lastActiveRound: this.round,
      seatedAt: this.seatCounter = (this.seatCounter || 0) + 1,
      spectating: this.phase !== PHASE.BREAK && this.round > 0,
      // Arriving mid-round is not the same as being eliminated: a newcomer sits
      // out the current round, then enters at the next one.
      pendingEntry: this.phase !== PHASE.BREAK && this.round > 0,
      face: 1,
    };
    if (player.spectating) player.alive = false;
    this.players.push(player);
    return player;
  }

  setHuman(name) {
    const existing = this.players.find((p) => p.id === this.humanId);
    if (existing) {
      existing.name = name;
      return existing;
    }
    const p = this.addPlayer(name, { bot: false });
    if (!p) return null;
    p.spectating = false;
    p.alive = true;
    this.humanId = p.id;
    return p;
  }

  human() {
    return this.players.find((p) => p.id === this.humanId) || null;
  }

  // Returns a free cell, or null when the board is genuinely full. Callers must
  // handle null: dropping a player onto an obstacle would break the fairness check.
  freeSpawn() {
    const taken = new Set(this.players.filter((p) => p.alive).map((p) => key(p.x, p.y)));
    const blocked = this.blockedCells();
    for (let i = 0; i < 120; i++) {
      const x = this.randInt(COLS);
      const y = this.randInt(ROWS);
      if (!taken.has(key(x, y)) && !blocked.has(key(x, y))) return { x, y };
    }
    // Random probing failed, so the board is crowded. Scan every cell before
    // declaring it full, starting at a random offset to avoid a corner bias.
    const total = COLS * ROWS;
    const offset = this.randInt(total);
    for (let i = 0; i < total; i++) {
      const cell = (offset + i) % total;
      const x = cell % COLS;
      const y = Math.floor(cell / COLS);
      if (!taken.has(key(x, y)) && !blocked.has(key(x, y))) return { x, y };
    }
    return null;
  }

  alivePlayers() {
    return this.players.filter((p) => p.alive);
  }

  blockedCells() {
    return new Set(this.obstacles.map((o) => key(o.x, o.y)));
  }

  /* ------------------------------------------------------------------ *
   * Input
   * ------------------------------------------------------------------ */

  submitMoves(player, moves) {
    if (!player || !player.alive) return false;
    if (this.phase !== PHASE.PLAN) return false;
    player.queue = moves.slice(0, MAX_MOVES);
    player.plannedThisRound = true;
    player.lastActiveRound = this.round;
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Live chat
   *
   * A chatter is identified by their channel ID, never their display name,
   * so renaming mid-match cannot steal another player's character.
   * ------------------------------------------------------------------ */

  findByKey(externalKey) {
    return this.players.find((p) => p.externalKey === externalKey) || null;
  }

  /**
   * Seat a chatter, replacing a bot if the board is full of them.
   * Returns { player, status } where status is one of:
   * "joined", "returning", "queued".
   */
  joinChatter(externalKey, name) {
    const existing = this.findByKey(externalKey);
    if (existing) {
      if (name && existing.name !== name) existing.name = name;
      return { player: existing, status: "returning" };
    }

    if (this.players.length >= this.maxPlayers) {
      // Give a real person a bot's seat before turning them away. Prefer a
      // living bot, so the newcomer is not handed an already-dead character.
      const bot = this.players.find((p) => p.bot && p.alive) || this.players.find((p) => p.bot);
      if (bot) {
        bot.bot = false;
        bot.externalKey = externalKey;
        bot.name = name;
        bot.queue = [];
        bot.path = null;
        bot.stepIndex = 0;
        bot.plannedThisRound = false;
        bot.roundsSurvived = 0;
        bot.lastActiveRound = this.round;
        bot.seatedAt = this.seatCounter = (this.seatCounter || 0) + 1;
        // Inheriting a dead seat means waiting like any other mid-round joiner,
        // rather than being permanently out for a round they never played.
        if (!bot.alive) bot.pendingEntry = true;
        return { player: bot, status: "joined" };
      }
      this.enqueue(externalKey, name);
      return { player: null, status: "queued" };
    }

    const player = this.addPlayer(name, { bot: false, externalKey });
    if (!player) {
      this.enqueue(externalKey, name);
      return { player: null, status: "queued" };
    }
    return { player, status: "joined" };
  }

  /**
   * Add someone to the waiting list, newest last.
   *
   * The queue is bounded. A busy stream produces far more would-be players than
   * an 11x7 board can ever seat, and an unbounded list would both grow without
   * limit and fill with people who closed the tab long ago, starving everyone
   * who arrived later. Dropping the stalest entry is safe because anyone still
   * watching re-queues automatically with their next message.
   */
  enqueue(externalKey, name) {
    const existing = this.waiting.find((w) => w.externalKey === externalKey);
    if (existing) {
      existing.name = name;
      existing.at = this.round;
      return;
    }
    this.waiting.push({ externalKey, name, at: this.round });
    while (this.waiting.length > this.maxWaiting) this.waiting.shift();
  }

  /**
   * Apply a parsed path from live chat. Auto-joins first-time chatters.
   * Returns a small result the bridge can turn into feedback.
   */
  submitFromChat(externalKey, name, moves) {
    const { player, status } = this.joinChatter(externalKey, name);
    if (!player) return { ok: false, reason: "queued", player: null, status };
    if (!player.alive) {
      return { ok: false, reason: player.pendingEntry ? "next-round" : "eliminated", player, status };
    }
    if (this.phase !== PHASE.PLAN) return { ok: false, reason: "locked", player, status };
    this.submitMoves(player, moves);
    return { ok: true, reason: "accepted", player, status };
  }

  /**
   * Free seats between matches so a queue of viewers is not locked out forever.
   *
   * A busy stream will always have more people than the 11x7 board can hold, so
   * "wait for someone to go idle" would never fire. Instead each new match frees
   * a slice of seats, giving up bots first, then the longest-idle players, then
   * the longest-tenured. Everyone gets a turn without the board churning fully.
   */
  rotateSeats({ idleRounds = 6, churn = 0.3 } = {}) {
    if (!this.waiting.length) return 0;

    const candidates = this.players.filter((p) => p.id !== this.humanId);
    const rank = (p) => {
      if (p.bot) return 0;                                                   // bots first
      if (this.round - (p.lastActiveRound ?? -Infinity) >= idleRounds) return 1; // then idle
      return 2;                                                              // then longest tenured
    };
    candidates.sort((a, b) => rank(a) - rank(b)
      || (a.lastActiveRound ?? -1) - (b.lastActiveRound ?? -1)
      || (a.seatedAt ?? 0) - (b.seatedAt ?? 0));

    const slice = Math.max(1, Math.ceil(this.maxPlayers * churn));
    const freeing = Math.min(candidates.length, this.waiting.length, slice);
    if (freeing <= 0) return 0;
    const evicted = new Set(candidates.slice(0, freeing).map((p) => p.id));
    this.players = this.players.filter((p) => !evicted.has(p.id));
    return freeing;
  }

  // Called between matches so queued chatters get a seat.
  admitWaiting() {
    this.rotateSeats();
    while (this.waiting.length && this.players.length < this.maxPlayers) {
      const next = this.waiting.shift();
      if (this.findByKey(next.externalKey)) continue;
      const player = this.addPlayer(next.name, { bot: false, externalKey: next.externalKey });
      if (!player) {
        this.waiting.unshift(next);
        break;
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Round setup
   * ------------------------------------------------------------------ */

  startRound() {
    this.round += 1;
    this.winner = null;

    for (const p of this.players) {
      // Two groups come back at the start of a round: the local player, who
      // always respawns, and newcomers who arrived while a round was running.
      // Chatters flattened by a tile stay out until the next match.
      // Solo runs never respawn: being hit is the end of the attempt.
      if (p.spectating && !this.solo && (p.id === this.humanId || p.pendingEntry)) {
        const spot = this.freeSpawn();
        if (spot) {
          p.spectating = false;
          p.pendingEntry = false;
          p.alive = true;
          p.x = spot.x; p.y = spot.y;
          p.rx = spot.x; p.ry = spot.y;
        }
      }
      p.queue = [];
      p.path = null;
      p.stepIndex = 0;
      p.plannedThisRound = false;
    }

    // A precomputed plan (the Daily Kawara) wins over live generation, because
    // generation reads player positions and would diverge between players.
    const scripted = this.plan ? this.plan[this.round - 1] : null;
    if (scripted) {
      this.obstacles = scripted.obstacles.map((o) => ({ ...o }));
      this.hazards = scripted.hazards.map((h) => ({ ...h }));
    } else {
      this.obstacles = this.generateObstacles();
      this.hazards = this.generateHazards();
    }
    this.enMark = scripted ? null : this.assignEnMark();
    this.effects = [];

    this.planDuration = planMs(this.round, this.planFloor);
    this.enterPhase(PHASE.PLAN, this.planDuration);

    const named = this.hazards.slice(0, 8).map((h) => cellName(h.x, h.y)).join(", ");
    const rest = this.hazards.length - 8;
    this.emit(
      "round",
      `Round ${this.round} — ${this.hazards.length} falling. Danger: ${named}${rest > 0 ? ` +${rest} more` : ""}`,
    );
    if (this.enMark) {
      this.emit(
        "system",
        `縁 En-mark on ${cellName(this.enMark.x, this.enMark.y)} — gather ${this.enMark.required} there and everyone on it lives.`,
      );
    }
  }

  generateObstacles() {
    if (this.round < 3) return [];
    const count = Math.min(9, Math.floor((this.round - 1) / 2) + 1);
    const out = [];
    const used = new Set(this.alivePlayers().map((p) => key(p.x, p.y)));
    const kinds = ["lantern", "bamboo", "pillar"];
    let guard = 0;
    while (out.length < count && guard++ < 300) {
      const x = this.randInt(COLS);
      const y = this.randInt(ROWS);
      if (used.has(key(x, y))) continue;
      // Keep the board breathable: no obstacle directly beside another.
      if (out.some((o) => Math.abs(o.x - x) + Math.abs(o.y - y) <= 1)) continue;
      used.add(key(x, y));
      out.push({ x, y, kind: this.pick(kinds) });
    }
    return out;
  }

  hazardPattern(count, blocked) {
    const cells = new Set();
    const add = (x, y) => {
      if (inBounds(x, y) && !blocked.has(key(x, y))) cells.add(key(x, y));
    };
    const kinds = this.round < 2 ? ["scatter"]
      : this.round < 4 ? ["scatter", "row", "col"]
      : ["scatter", "row", "col", "cross", "comb", "ring"];
    const kind = this.pick(kinds);

    if (kind === "row") {
      const y = this.randInt(ROWS);
      const gaps = new Set([this.randInt(COLS), this.randInt(COLS)]);
      for (let x = 0; x < COLS; x++) if (!gaps.has(x)) add(x, y);
    } else if (kind === "col") {
      const x = this.randInt(COLS);
      const gap = this.randInt(ROWS);
      for (let y = 0; y < ROWS; y++) if (y !== gap) add(x, y);
    } else if (kind === "cross") {
      const cx = 1 + this.randInt(COLS - 2);
      const cy = 1 + this.randInt(ROWS - 2);
      for (let x = 0; x < COLS; x++) add(x, cy);
      for (let y = 0; y < ROWS; y++) add(cx, y);
    } else if (kind === "comb") {
      const parity = this.randInt(2);
      for (let x = parity; x < COLS; x += 2) {
        for (let y = 0; y < ROWS; y++) if ((x + y) % 3 !== 0) add(x, y);
      }
    } else if (kind === "ring") {
      const cx = 1 + this.randInt(COLS - 2);
      const cy = 1 + this.randInt(ROWS - 2);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) if (dx || dy) add(cx + dx, cy + dy);
      }
    }

    let guard = 0;
    while (cells.size < count && guard++ < 400) add(this.randInt(COLS), this.randInt(ROWS));

    // Never cover the whole board.
    const free = COLS * ROWS - blocked.size;
    const cap = Math.min(count + 4, Math.floor(free * 0.6));
    const list = [...cells];
    while (list.length > cap) list.splice(this.randInt(list.length), 1);
    return list.map((k) => {
      const [x, y] = k.split(",").map(Number);
      return { x, y };
    });
  }

  generateHazards() {
    const blocked = this.blockedCells();
    const count = 3 + Math.round(this.round * 2.2);
    let cells = this.hazardPattern(count, blocked);

    // Fairness: every alive player must have a safe cell within MAX_MOVES.
    for (let attempt = 0; attempt < 30; attempt++) {
      const danger = new Set(cells.map((c) => key(c.x, c.y)));
      const stuck = this.alivePlayers().filter((p) => !this.hasEscape(p, danger, blocked));
      if (stuck.length === 0) break;
      // Open a hole next to whoever is trapped.
      for (const p of stuck) {
        const reach = this.reachable(p, blocked);
        const openable = [...reach].filter((k) => danger.has(k));
        const target = openable.length ? this.pick(openable) : null;
        if (target) cells = cells.filter((c) => key(c.x, c.y) !== target);
      }
    }

    const types = ["boulder", "tile", "bell"];
    return cells.map((c, i) => ({
      x: c.x,
      y: c.y,
      type: this.round < 3 ? (i % 2 ? "tile" : "boulder") : this.pick(types),
    }));
  }

  /* ------------------------------------------------------------------ *
   * 縁 En-marks
   *
   * One telegraphed square also carries a required headcount. Stand there
   * with enough people and everyone on it survives, and the eight
   * surrounding hazards are cancelled too.
   *
   * The mark is always placed ON an existing hazard, never on a safe cell.
   * That is what keeps the fairness guarantee intact: the danger set is
   * unchanged, hasEscape() behaves identically, and ignoring the mark stays
   * a valid way to survive. An en-mark only ever adds an option.
   * ------------------------------------------------------------------ */

  assignEnMark() {
    const alive = this.alivePlayers().length;
    if (this.round < EN_MARK_MIN_ROUND || alive < EN_MARK_MIN_PLAYERS) return null;
    if (!this.hazards.length) return null;

    // Never ask for more than half the room, so it stays achievable.
    const required = Math.max(
      EN_MARK_MIN_REQUIRED,
      Math.min(EN_MARK_MAX_REQUIRED, Math.floor(alive / 6), Math.floor(alive / 2)),
    );
    if (required < EN_MARK_MIN_REQUIRED) return null;

    // Prefer a central cell: easier for a scattered crowd to converge on.
    const cx = (COLS - 1) / 2;
    const cy = (ROWS - 1) / 2;
    const ranked = [...this.hazards].sort(
      (a, b) => (Math.abs(a.x - cx) + Math.abs(a.y - cy)) - (Math.abs(b.x - cx) + Math.abs(b.y - cy)),
    );
    const spot = ranked[this.randInt(Math.min(3, ranked.length))];
    return { x: spot.x, y: spot.y, required };
  }

  /** Cells spared when an en-mark succeeds: the mark plus its eight neighbours. */
  enMarkShelter() {
    if (!this.enMark) return new Set();
    const out = new Set();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const x = this.enMark.x + dx;
        const y = this.enMark.y + dy;
        if (inBounds(x, y)) out.add(key(x, y));
      }
    }
    return out;
  }

  /**
   * How many players are currently committed to the en-mark, based on where
   * their queued path ends. Drives the live "2/4" readout during planning.
   */
  enMarkCommitted() {
    if (!this.enMark) return 0;
    const blocked = this.blockedCells();
    let count = 0;
    for (const p of this.alivePlayers()) {
      const end = p.queue.length
        ? movesToPath(p.x, p.y, p.queue, blocked).at(-1)
        : { x: p.x, y: p.y };
      if (end.x === this.enMark.x && end.y === this.enMark.y) count += 1;
    }
    return count;
  }

  reachable(player, blocked) {
    const seen = new Set([key(player.x, player.y)]);
    let frontier = [{ x: player.x, y: player.y }];
    for (let step = 0; step < MAX_MOVES; step++) {
      const next = [];
      for (const cell of frontier) {
        for (const [dx, dy] of Object.values(DIRS)) {
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

  hasEscape(player, danger, blocked) {
    for (const k of this.reachable(player, blocked)) {
      if (!danger.has(k)) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * Bot planning
   * ------------------------------------------------------------------ */

  planBot(bot) {
    const blocked = this.blockedCells();
    const danger = new Set(this.hazards.map((h) => key(h.x, h.y)));

    // Breadth-first search for the closest safe cell.
    const prev = new Map();
    const start = key(bot.x, bot.y);
    prev.set(start, null);
    const queue = [{ x: bot.x, y: bot.y, depth: 0 }];
    const safeTargets = [];
    while (queue.length) {
      const cell = queue.shift();
      const k = key(cell.x, cell.y);
      if (!danger.has(k)) safeTargets.push({ k, depth: cell.depth });
      if (cell.depth >= MAX_MOVES) continue;
      for (const [dir, [dx, dy]] of Object.entries(DIRS)) {
        const nx = cell.x + dx;
        const ny = cell.y + dy;
        const nk = key(nx, ny);
        if (!inBounds(nx, ny) || blocked.has(nk) || prev.has(nk)) continue;
        prev.set(nk, { from: k, dir });
        queue.push({ x: nx, y: ny, depth: cell.depth + 1 });
      }
    }

    const sloppy = Math.random() > bot.skill;
    let target = null;
    if (safeTargets.length) {
      safeTargets.sort((a, b) => a.depth - b.depth);
      const shortlist = safeTargets.slice(0, sloppy ? safeTargets.length : Math.max(1, Math.ceil(safeTargets.length * 0.4)));
      target = this.pick(shortlist).k;
    }
    // A sloppy read is the whole game: they run somewhere reachable, not somewhere safe.
    if (!target || (sloppy && Math.random() < 0.55)) {
      target = this.pick([...prev.keys()]);
    }

    const moves = [];
    let cursor = target;
    while (cursor && prev.get(cursor)) {
      const step = prev.get(cursor);
      moves.unshift(step.dir);
      cursor = step.from;
    }
    return moves.slice(0, MAX_MOVES);
  }

  /* ------------------------------------------------------------------ *
   * Tick
   * ------------------------------------------------------------------ */

  update(dt) {
    this.clock += dt;
    this.shake = Math.max(0, this.shake - dt / 220);

    for (const e of this.effects) e.life -= dt;
    this.effects = this.effects.filter((e) => e.life > 0);

    // Smooth the drawn position toward the logical cell, or snap under reduced motion.
    const k = this.snapMotion ? 1 : Math.min(1, dt / 90);
    for (const p of this.players) {
      p.rx += (p.x - p.rx) * k;
      p.ry += (p.y - p.ry) * k;
    }

    if (this.clock < this.phaseEndsAt) return;

    switch (this.phase) {
      case PHASE.BREAK:
        this.startRound();
        break;
      case PHASE.PLAN:
        this.lockIn();
        break;
      case PHASE.LOCK:
        this.beginResolve();
        break;
      case PHASE.RESOLVE:
        this.advanceStep();
        break;
      case PHASE.IMPACT:
        this.settleImpact();
        break;
      case PHASE.GAMEOVER:
        this.reset();
        break;
      default:
        break;
    }
  }

  lockIn() {
    const blocked = this.blockedCells();
    for (const p of this.alivePlayers()) {
      if (p.bot && !p.plannedThisRound) p.queue = this.planBot(p);
      p.path = movesToPath(p.x, p.y, p.queue, blocked);
      p.stepIndex = 0;
    }
    this.enterPhase(PHASE.LOCK, TIMING.lock);
  }

  beginResolve() {
    this.enterPhase(PHASE.RESOLVE, TIMING.step);
  }

  advanceStep() {
    let moved = false;
    for (const p of this.alivePlayers()) {
      if (!p.path) continue;
      const next = p.stepIndex + 1;
      if (next < p.path.length) {
        const from = p.path[p.stepIndex];
        const to = p.path[next];
        p.bumped = from.x === to.x && from.y === to.y;
        if (to.x > from.x) p.face = 1;
        if (to.x < from.x) p.face = -1;
        p.x = to.x;
        p.y = to.y;
        p.stepIndex = next;
        moved = true;
      }
    }
    if (moved) {
      this.enterPhase(PHASE.RESOLVE, TIMING.step);
    } else {
      this.enterPhase(PHASE.IMPACT, TIMING.impact);
    }
  }

  settleImpact() {
    const danger = new Set(this.hazards.map((h) => key(h.x, h.y)));

    // Resolve the en-mark before the casualty sweep: a successful gathering
    // spares the marked cell and the ring of hazards around it.
    let enMarkResult = null;
    if (this.enMark) {
      const markKey = key(this.enMark.x, this.enMark.y);
      const occupants = this.alivePlayers().filter((p) => key(p.x, p.y) === markKey);
      const held = occupants.length >= this.enMark.required;
      enMarkResult = { ...this.enMark, occupants: occupants.length, held };
      if (held) {
        for (const k of this.enMarkShelter()) danger.delete(k);
        this.effects.push({ kind: "shelter", x: this.enMark.x, y: this.enMark.y, life: 900, max: 900 });
        this.emit(
          "result",
          `縁 ${occupants.length} gathered on ${cellName(this.enMark.x, this.enMark.y)}. The tiles broke around them.`,
        );
      }
    }
    this.enMarkResult = enMarkResult;

    const casualties = [];
    for (const p of this.alivePlayers()) {
      if (danger.has(key(p.x, p.y))) {
        p.alive = false;
        p.spectating = true;
        casualties.push(p);
        this.effects.push({ kind: "splat", x: p.x, y: p.y, life: 900, max: 900 });
      } else {
        p.roundsSurvived += 1;
      }
    }

    this.shake = 1;

    // Pure notification: ids and counts only. Persistence is the bridge's job,
    // so the rules layer stays runnable headless with no I/O.
    this.emit("roundSettled", `Round ${this.round} settled.`, {
      round: this.round,
      survivors: this.alivePlayers().map((p) => ({ id: p.id, roundsSurvived: p.roundsSurvived })),
      casualties: casualties.map((p) => ({ id: p.id, roundsSurvived: p.roundsSurvived })),
    });

    if (casualties.length) {
      const names = casualties.map((p) => p.name).join(", ");
      this.emit("out", `${names} ${casualties.length > 1 ? "were" : "was"} flattened.`, {
        ids: casualties.map((p) => p.id),
      });
    }

    const alive = this.alivePlayers();

    // Solo (the Daily Kawara): there is nobody to outlast, so the run ends when
    // you are hit or when the scripted rounds are used up — not at one survivor.
    if (this.solo) {
      const me = this.human();
      const finished = this.plan && this.round >= this.plan.length;
      if (!me || !me.alive || finished) {
        this.winner = me && me.alive ? me : null;
        this.enterPhase(PHASE.GAMEOVER, TIMING.gameover);
        this.emit(
          "result",
          this.winner
            ? `Cleared all ${this.round} rounds. 天晴れ!`
            : `Flattened on round ${this.round}.`,
        );
        return;
      }
      this.enterPhase(PHASE.BREAK, TIMING.break);
      return;
    }

    if (alive.length <= 1) {
      this.winner = alive[0] || null;
      this.enterPhase(PHASE.GAMEOVER, TIMING.gameover);
      this.emit(
        "result",
        this.winner ? `${this.winner.name} survives round ${this.round}. 勝ち!` : "Everyone got flattened. 全滅!",
      );
      return;
    }

    // Hazards stay on the floor through the break so the round reads as wreckage.
    this.enterPhase(PHASE.BREAK, TIMING.break);
  }

  /* ------------------------------------------------------------------ *
   * Derived info for the UI
   * ------------------------------------------------------------------ */

  planProgress() {
    if (this.phase !== PHASE.PLAN) return 0;
    return Math.max(0, Math.min(1, (this.phaseEndsAt - this.clock) / this.planDuration));
  }

  timeLeft() {
    return Math.max(0, this.phaseEndsAt - this.clock);
  }

  describe() {
    const you = this.human();
    const parts = [`Round ${this.round}.`, `Phase: ${this.phase}.`];
    if (you) {
      parts.push(
        you.alive
          ? `You are at ${cellName(you.x, you.y)}.`
          : "You are out this round and will respawn next round.",
      );
      if (you.queue.length) parts.push(`Queued: ${you.queue.join(" ")}.`);
    }
    if (this.hazards.length) {
      parts.push(`Falling on ${this.hazards.map((h) => cellName(h.x, h.y)).join(", ")}.`);
    }
    if (this.enMark) {
      parts.push(
        `En-mark on ${cellName(this.enMark.x, this.enMark.y)} needs ${this.enMark.required};`
        + ` ${this.enMarkCommitted()} committed.`,
      );
    }
    if (this.obstacles.length) {
      parts.push(`Blocked cells ${this.obstacles.map((o) => cellName(o.x, o.y)).join(", ")}.`);
    }
    parts.push(`${this.alivePlayers().length} of ${this.players.length} still standing.`);
    return parts.join(" ");
  }
}


