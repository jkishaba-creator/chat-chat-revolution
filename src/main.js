import { Game, parseMoves, movesToPath, cellName } from "./game.js";
import { Renderer } from "./render.js";
import { ChatPanel } from "./chat.js";
import { PHASE, MAX_MOVES, BOT_NAMES, BOT_CHATTER } from "./config.js";
import { dailyPlan, readDaily, recordDaily } from "./daily.js";
import { todayKey } from "./rng.js";

const $ = (id) => document.getElementById(id);

const el = {
  canvas: $("game"),
  round: $("hud-round"),
  alive: $("hud-alive"),
  total: $("hud-total"),
  phase: $("hud-phase"),
  timerWrap: document.querySelector(".board__timer"),
  timerFill: $("timer-fill"),
  timerText: $("timer-text"),
  alt: $("board-alt"),
  log: $("chat-log"),
  announcer: $("announcer"),
  form: $("chat-form"),
  say: $("say"),
  handle: $("handle"),
  status: $("input-status"),
  modeLink: $("mode-link"),
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const chat = new ChatPanel({ log: el.log, announcer: el.announcer });
const renderer = new Renderer(el.canvas, { reducedMotion });

// 本日の瓦: /?daily runs the shared date-seeded board, alone, one scored run.
const DAILY = new URLSearchParams(location.search).has("daily");
const today = todayKey();
const daily = DAILY ? dailyPlan(today) : null;

const BOT_TARGET = DAILY ? 0 : 10;
let botSchedule = [];
let ambientAt = 0;
let dailyScored = false;

const game = new Game({
  snapMotion: reducedMotion,
  rng: Math.random,
  plan: daily ? daily.plan : null,
  solo: DAILY,
  onEvent: ({ type, text, meta }) => {
    if (type === "round") {
      chat.push({ name: "SYSTEM", body: text, kind: "system" });
      chat.announce(text);
      scheduleBots();
      // Re-apply whatever is still sitting in the box against the new board.
      previewFromInput();
    } else if (type === "out") {
      chat.push({ name: "SYSTEM", body: text, kind: "alert" });
      chat.announce(text);
      const you = game.human();
      if (you && meta?.ids?.includes(you.id)) {
        setStatus("You were flattened. You respawn next round.", "error");
      }
    } else if (type === "result") {
      chat.push({ name: "SYSTEM", body: text, kind: "alert" });
      chat.announce(text);
      if (DAILY) finishDaily(); else recordBest();
    } else {
      chat.push({ name: "SYSTEM", body: text, kind: "system" });
    }
  },
});

/* ------------------------------------------------------------------ *
 * Roster
 * ------------------------------------------------------------------ */

const shuffled = [...BOT_NAMES].sort(() => Math.random() - 0.5);
for (let i = 0; i < BOT_TARGET; i++) {
  game.addPlayer(shuffled[i % shuffled.length], {
    bot: true,
    skill: 0.35 + Math.random() * 0.55,
  });
}
const you = game.setHuman(el.handle.value.trim() || "YOU");

if (daily && you) {
  // Everyone starts the daily on the same square, or the shared board is not
  // really shared.
  you.x = daily.start.x; you.y = daily.start.y;
  you.rx = daily.start.x; you.ry = daily.start.y;
}

if (el.modeLink) {
  el.modeLink.textContent = DAILY ? "← Back to endless play" : "Play today's 本日の瓦 →";
  el.modeLink.href = DAILY ? "./" : "?daily";
}

if (DAILY) {
  const prior = readDaily();
  chat.push({ name: "SYSTEM", body: `本日の瓦 — the Daily Kawara for ${today}.`, kind: "system" });
  chat.push({ name: "SYSTEM", body: "Same board for every player today. No bots, one scored run.", kind: "system" });
  if (prior.result?.date === today) {
    chat.push({
      name: "SYSTEM",
      body: `You already scored ${prior.result.rounds} rounds today. This run is practice.`,
      kind: "system",
    });
  } else if (prior.streak > 0) {
    chat.push({ name: "SYSTEM", body: `Current streak: ${prior.streak} day(s).`, kind: "system" });
  }
} else {
  chat.push({ name: "SYSTEM", body: "瓦落とし — count the squares, then type your path.", kind: "system" });
  chat.push({ name: "SYSTEM", body: `Up to ${MAX_MOVES} steps per round: l, r, u, d. Obstacles block you from round 3.`, kind: "system" });
  chat.push({ name: "SYSTEM", body: "Chat is eliminated for the match when hit. You respawn every round.", kind: "system" });
}

/* ------------------------------------------------------------------ *
 * Bot chatter
 * ------------------------------------------------------------------ */

function scheduleBots() {
  const span = game.planDuration;
  botSchedule = game.alivePlayers()
    .filter((p) => p.bot)
    .map((p) => ({
      player: p,
      at: game.clock + (0.15 + Math.random() * 0.7) * span,
      done: false,
    }));
}

function runBotSchedule() {
  if (game.phase !== PHASE.PLAN) return;
  for (const entry of botSchedule) {
    if (entry.done || game.clock < entry.at) continue;
    entry.done = true;
    const p = entry.player;
    if (!p.alive) continue;
    const moves = game.planBot(p);
    p.queue = moves;
    p.plannedThisRound = true;
    const body = Math.random() < 0.22
      ? BOT_CHATTER[Math.floor(Math.random() * BOT_CHATTER.length)]
      : moves.join("") || "stay";
    chat.push({ name: p.name, body, kind: "user" });
  }
}

// Eliminated chatters keep talking from the sidelines.
function ambientChatter() {
  if (game.clock < ambientAt) return;
  ambientAt = game.clock + 2600 + Math.random() * 4200;
  const ghosts = game.players.filter((p) => p.bot && !p.alive);
  if (!ghosts.length) return;
  const p = ghosts[Math.floor(Math.random() * ghosts.length)];
  chat.push({
    name: p.name,
    body: BOT_CHATTER[Math.floor(Math.random() * BOT_CHATTER.length)],
    kind: "user",
    dead: true,
  });
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

function setStatus(text, tone = "") {
  el.status.textContent = text;
  el.status.className = `chat__status${tone ? ` chat__status--${tone}` : ""}`;
}

function describePlan(me, moves) {
  const blocked = new Set(game.obstacles.map((o) => `${o.x},${o.y}`));
  const path = movesToPath(me.x, me.y, moves, blocked);
  const end = path[path.length - 1];
  const danger = game.hazards.some((h) => h.x === end.x && h.y === end.y);
  const stopped = path.filter((c, i) => i > 0 && c.x === path[i - 1].x && c.y === path[i - 1].y).length;
  const label = `${moves.join(" ").toUpperCase()} → ${cellName(end.x, end.y)} · ` +
    (danger ? "a tile lands there" : "clear") +
    (stopped ? ` · ${stopped} step${stopped > 1 ? "s" : ""} hit a wall` : "");
  return { label, danger, end };
}

function previewFromInput() {
  const me = game.human();
  if (!me || !me.alive || game.phase !== PHASE.PLAN) return;
  const { moves, matched } = parseMoves(el.say.value);
  if (!matched) {
    if (me.queue.length && el.say.value.trim() === "") {
      me.queue = [];
      setStatus("Path cleared.");
    }
    return;
  }
  game.submitMoves(me, moves);
  const { label, danger } = describePlan(me, moves);
  setStatus(label, danger ? "error" : "ok");
}

el.say.addEventListener("input", previewFromInput);

// Arrow-key shortcut lives on the document, not on the input: inside a text field
// the arrows must keep moving the caret so the message stays editable.
const ARROW_DIRS = { ArrowLeft: "l", ArrowRight: "r", ArrowUp: "u", ArrowDown: "d" };

function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches("input, textarea, select, [contenteditable]");
}

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;

  if (event.key === "Enter") {
    if (!el.say.value.trim()) return;
    event.preventDefault();
    el.form.requestSubmit();
    return;
  }

  const dir = ARROW_DIRS[event.key];
  if (!dir) return;
  event.preventDefault();
  const { moves } = parseMoves(el.say.value);
  if (moves.length >= MAX_MOVES) {
    setStatus(`That is already ${MAX_MOVES} steps — the most you can queue.`, "error");
    return;
  }
  el.say.value = `${el.say.value}${dir}`;
  previewFromInput();
});

el.handle.addEventListener("change", () => {
  const name = el.handle.value.trim().slice(0, 14) || "YOU";
  el.handle.value = name;
  game.setHuman(name);
});

el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const raw = el.say.value.trim();
  if (!raw) return;
  const me = game.setHuman(el.handle.value.trim() || "YOU");
  const { moves, matched } = parseMoves(raw);

  chat.push({ name: me.name, body: raw, kind: "user", you: true, dead: !me.alive });
  el.say.value = "";

  if (!me.alive) {
    setStatus("You are out this round. You respawn when the next round starts.", "error");
    return;
  }
  if (!matched) {
    setStatus("No moves in that message. Try r, l, u, d — like rrud.", "error");
    return;
  }
  if (game.phase !== PHASE.PLAN) {
    setStatus("Paths are locked. Your next path counts from the next round.", "error");
    return;
  }
  game.submitMoves(me, moves);
  const { label, danger } = describePlan(me, moves);
  setStatus(`Sent · ${label}`, danger ? "error" : "ok");
});

/* ------------------------------------------------------------------ *
 * Best score
 * ------------------------------------------------------------------ */

// A daily run ends the moment you are hit: there is nobody else to outlast.
function finishDaily() {
  if (dailyScored) return;
  dailyScored = true;
  const me = game.human();
  const rounds = me ? me.roundsSurvived : 0;
  const outcome = recordDaily(today, rounds);
  const body = outcome.scored
    ? `本日の瓦 · ${today} · ${rounds} rounds · streak ${outcome.streak}`
    : `Practice run: ${rounds} rounds. Today's score stands at ${outcome.rounds}.`;
  chat.push({ name: "SYSTEM", body, kind: "alert" });
  chat.announce(body);
  setStatus(outcome.scored ? "Daily recorded. Come back tomorrow." : "Practice run — not scored.", "ok");
}

function recordBest() {
  const me = game.human();
  if (!me) return;
  const best = Number(localStorage.getItem("ccr-best") || 0);
  if (me.roundsSurvived > best) {
    localStorage.setItem("ccr-best", String(me.roundsSurvived));
    chat.push({ name: "SYSTEM", body: `New personal best: ${me.roundsSurvived} rounds survived.`, kind: "system" });
  }
}

if (!DAILY) {
  const storedBest = Number(localStorage.getItem("ccr-best") || 0);
  if (storedBest > 0) {
    chat.push({ name: "SYSTEM", body: `Your best so far: ${storedBest} rounds.`, kind: "system" });
  }
}

/* ------------------------------------------------------------------ *
 * HUD
 * ------------------------------------------------------------------ */

const PHASE_TEXT = {
  [PHASE.PLAN]: "Plot your path",
  [PHASE.LOCK]: "Paths locked",
  [PHASE.RESOLVE]: "Moving",
  [PHASE.IMPACT]: "Impact",
  [PHASE.BREAK]: "Next round incoming",
  [PHASE.GAMEOVER]: "Match over",
};

let lastPhase = null;

function updateHud() {
  el.round.textContent = String(Math.max(1, game.round));
  el.alive.textContent = String(game.alivePlayers().length);
  el.total.textContent = String(game.players.length);
  el.phase.textContent = game.phase === PHASE.GAMEOVER && game.winner
    ? `${game.winner.name} wins`
    : PHASE_TEXT[game.phase];

  const planning = game.phase === PHASE.PLAN;
  const remaining = game.timeLeft();
  const ratio = Math.max(0, Math.min(1, remaining / (game.phaseDuration || 1)));
  el.timerFill.style.width = `${(ratio * 100).toFixed(1)}%`;
  el.timerText.textContent = planning
    ? `${(remaining / 1000).toFixed(1)}s to plan`
    : PHASE_TEXT[game.phase];
  el.timerWrap.classList.toggle("board__timer--danger", planning ? ratio < 0.34 : game.phase === PHASE.IMPACT);

  if (game.phase !== lastPhase) {
    lastPhase = game.phase;
    el.alt.textContent = game.describe();
  }
}

/* ------------------------------------------------------------------ *
 * Loop
 * ------------------------------------------------------------------ */

let last = performance.now();

function frame(now) {
  const dt = Math.min(64, now - last);
  last = now;
  game.update(dt);
  runBotSchedule();
  ambientChatter();
  renderer.draw(game, dt);
  updateHud();
  requestAnimationFrame(frame);
}

document.fonts?.ready.then(() => renderer.resize());
requestAnimationFrame(frame);

// Expose for debugging in the console.
window.ccr = { game, renderer, you, daily };
