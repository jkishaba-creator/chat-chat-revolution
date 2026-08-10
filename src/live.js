/**
 * Live view: draws the server-authoritative game and the real chat feed.
 * There is no local input here. The only controller is the stream chat.
 */
import { Renderer } from "./render.js";
import { ChatPanel } from "./chat.js";
import { RemoteGame } from "./remote.js";
import { PHASE } from "./config.js";

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
  status: $("source-status"),
  commands: $("stat-commands"),
  waiting: $("stat-waiting"),
  quota: $("stat-quota"),
  log: $("chat-log"),
  announcer: $("announcer"),
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const game = new RemoteGame();
game.snapMotion = reducedMotion;
const renderer = new Renderer(el.canvas, { reducedMotion });
const chat = new ChatPanel({ log: el.log, announcer: el.announcer });

const PHASE_TEXT = {
  [PHASE.PLAN]: "Plot your path",
  [PHASE.LOCK]: "Paths locked",
  [PHASE.RESOLVE]: "Moving",
  [PHASE.IMPACT]: "Impact",
  [PHASE.BREAK]: "Next round incoming",
  [PHASE.GAMEOVER]: "Match over",
};

let connected = false;
let lastAnnounced = "";

function renderFeedEntry(entry) {
  chat.push({
    name: entry.name,
    body: entry.body,
    kind: entry.kind === "round" ? "system" : entry.kind,
    dead: Boolean(entry.dead),
  });
  if (entry.kind === "system" || entry.kind === "alert") {
    if (entry.body !== lastAnnounced) {
      lastAnnounced = entry.body;
      chat.announce(entry.body);
    }
  }
}

function applyStatus(status) {
  const parts = [];
  if (status.source === "youtube") {
    parts.push(status.connected ? "YouTube chat connected" : "YouTube chat disconnected");
    if (status.videoId) parts.push(status.videoId);
  } else if (status.source === "mock") {
    parts.push("Mock chat (no YouTube connection)");
  } else {
    parts.push("Chat source off");
  }
  if (status.error) parts.push(status.error);
  el.status.textContent = parts.join(" · ");

  el.commands.textContent = String(status.stats?.commands ?? 0);
  el.waiting.textContent = String(status.waiting ?? 0);
  el.quota.textContent = status.quotaLimit
    ? `${status.quotaUsed}/${status.quotaLimit}`
    : "n/a";
}

function updateHud() {
  el.round.textContent = String(Math.max(1, game.round));
  el.alive.textContent = String(game.alivePlayers().length);
  el.total.textContent = String(game.players.length);
  el.phase.textContent = game.phase === PHASE.GAMEOVER && game.winner
    ? `${game.winner.name} wins`
    : (PHASE_TEXT[game.phase] || "—");

  const planning = game.phase === PHASE.PLAN;
  const remaining = game.timeLeft();
  const ratio = Math.max(0, Math.min(1, remaining / (game.phaseDuration || 1)));
  el.timerFill.style.width = `${(ratio * 100).toFixed(1)}%`;
  el.timerText.textContent = connected
    ? (planning ? `${(remaining / 1000).toFixed(1)}s to plan` : PHASE_TEXT[game.phase])
    : "Reconnecting…";
  el.timerWrap.classList.toggle("board__timer--danger", planning && remaining < 2500);
}

function describeBoard() {
  const danger = game.hazards.slice(0, 10).map((h) => `${"ABCDEFGHIJK"[h.x]}${h.y + 1}`).join(", ");
  return `Round ${game.round}, ${PHASE_TEXT[game.phase] || game.phase}. `
    + `${game.alivePlayers().length} of ${game.players.length} standing. `
    + (danger ? `Danger cells ${danger}.` : "No danger yet.");
}

/* ---------------- transport ---------------- */

let stream = null;
let retryMs = 1000;

function connect() {
  stream = new EventSource("/api/stream");

  stream.addEventListener("hello", (event) => {
    const payload = JSON.parse(event.data);
    game.apply(payload.state);
    for (const entry of payload.feed) renderFeedEntry(entry);
    applyStatus(payload.status);
    connected = true;
    retryMs = 1000;
  });

  stream.addEventListener("state", (event) => {
    game.apply(JSON.parse(event.data));
    connected = true;
  });

  stream.addEventListener("chat", (event) => renderFeedEntry(JSON.parse(event.data)));
  stream.addEventListener("status", (event) => applyStatus(JSON.parse(event.data)));

  stream.onerror = () => {
    connected = false;
    stream.close();
    // Back off so a restarting server is not hammered by every open tab.
    setTimeout(connect, retryMs);
    retryMs = Math.min(15000, retryMs * 2);
  };
}

connect();

/* ---------------- frame loop ---------------- */

let last = performance.now();
let altAt = 0;

function frame(now) {
  const dt = Math.min(100, now - last);
  last = now;
  game.interpolate(dt);
  renderer.draw(game, dt);
  updateHud();
  if (now - altAt > 1500) {
    altAt = now;
    el.alt.textContent = describeBoard();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.ccrLive = { game, renderer };
