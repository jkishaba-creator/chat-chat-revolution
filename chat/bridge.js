/**
 * Chat bridge: owns the authoritative game and streams it to browsers.
 *
 * With live chat the browser can no longer be the source of truth, because
 * every viewer must see the same board. The server runs the simulation and
 * pushes state over Server-Sent Events; browsers only draw it.
 */
import { Game, parseMoves } from "../src/game.js";
import { PLAN_FLOOR_CHAT, BOT_NAMES } from "../src/config.js";

const TICK_MS = 50;
const STATE_HZ = 10; // State pushes per second.
const FEED_LIMIT = 40;

export class ChatBridge {
  constructor({ source, botFill = 6 } = {}) {
    this.source = source;
    this.clients = new Set();
    this.feed = [];
    this.seenMessageIds = new Set();
    this.seenOrder = [];
    this.stats = { messages: 0, commands: 0, joins: 0, ignored: 0 };
    // Overrides pushed by the source's onStatus callback. Starts empty so it
    // cannot mask what the source itself reports in status().
    this.sourceStatus = {};

    this.game = new Game({
      planFloor: PLAN_FLOOR_CHAT,
      onEvent: ({ type, text }) => this.pushFeed({ kind: type === "round" ? "system" : type, name: "SYSTEM", body: text }),
    });

    // A few bots so the board is never empty before viewers arrive. They are
    // replaced by real chatters as people join.
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    for (let i = 0; i < botFill; i++) {
      this.game.addPlayer(names[i % names.length], { bot: true, skill: 0.4 + Math.random() * 0.5 });
    }

    this.lastState = 0;
    this.lastTick = Date.now();
    this.timer = null;
  }

  /* ---------------- chat intake ---------------- */

  // YouTube can resend messages across pages, and a resent move would silently
  // overwrite a player's chosen path, so every message ID is used only once.
  isDuplicate(id) {
    if (!id) return false;
    if (this.seenMessageIds.has(id)) return true;
    this.seenMessageIds.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 5000) {
      this.seenMessageIds.delete(this.seenOrder.shift());
    }
    return false;
  }

  handleMessages(batch) {
    for (const msg of batch) {
      if (this.isDuplicate(msg.id)) continue;
      this.stats.messages += 1;

      const { moves, matched } = parseMoves(msg.text);
      if (!matched) {
        // Ordinary conversation: show it, but it must not move anyone.
        this.stats.ignored += 1;
        this.pushFeed({ kind: "user", name: msg.name, body: msg.text });
        continue;
      }

      const known = Boolean(this.game.findByKey(msg.channelId));
      const result = this.game.submitFromChat(msg.channelId, msg.name, moves);
      if (!known && result.player) {
        this.stats.joins += 1;
        this.pushFeed({ kind: "system", name: "SYSTEM", body: `${msg.name} joined the courtyard.` });
      }
      if (result.ok) this.stats.commands += 1;

      this.pushFeed({
        kind: "user",
        name: msg.name,
        body: msg.text,
        dead: result.player ? !result.player.alive : false,
        note: result.ok ? null : result.reason,
      });
    }
  }

  pushFeed(entry) {
    this.feed.push({ ...entry, at: Date.now() });
    if (this.feed.length > FEED_LIMIT) this.feed.shift();
    this.broadcast("chat", entry);
  }

  /* ---------------- state streaming ---------------- */

  snapshot() {
    const g = this.game;
    return {
      phase: g.phase,
      round: g.round,
      timeLeft: Math.round(g.timeLeft()),
      phaseDuration: g.phaseDuration,
      planDuration: g.planDuration,
      hazards: g.hazards.map((h) => ({ x: h.x, y: h.y, type: h.type })),
      obstacles: g.obstacles.map((o) => ({ x: o.x, y: o.y, kind: o.kind })),
      effects: g.effects.map((e) => ({ x: e.x, y: e.y, kind: e.kind, life: e.life, max: e.max })),
      shake: g.shake,
      winner: g.winner ? g.winner.name : null,
      waiting: g.waiting.length,
      players: g.players.map((p) => ({
        id: p.id,
        name: p.name,
        bot: p.bot,
        x: p.x, y: p.y, rx: p.rx, ry: p.ry,
        alive: p.alive,
        spectating: p.spectating,
        queue: p.queue,
        skin: p.skin,
        face: p.face,
        bumped: p.bumped,
      })),
    };
  }

  broadcast(event, data) {
    if (!this.clients.size) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      // A slow or dead client must never block the game loop.
      if (!res.writableEnded) res.write(payload);
    }
  }

  addClient(res) {
    this.clients.add(res);
    res.write(`event: hello\ndata: ${JSON.stringify({
      state: this.snapshot(),
      feed: this.feed,
      status: this.status(),
    })}\n\n`);
    return () => this.clients.delete(res);
  }

  /* ---------------- lifecycle ---------------- */

  async start() {
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);

    if (!this.source) return;
    try {
      await this.source.start(
        (batch) => this.handleMessages(batch),
        (status) => {
          this.sourceStatus = { ...this.sourceStatus, ...status };
          this.broadcast("status", this.status());
          if (status.error) {
            this.pushFeed({ kind: "alert", name: "SYSTEM", body: `Chat source: ${status.error}` });
          }
        },
      );
    } catch (error) {
      // The board keeps running without chat rather than leaving this bridge
      // half-started with an orphaned game loop nobody can stop.
      this.sourceStatus = { connected: false, error: error.message, fatal: true };
      this.pushFeed({ kind: "alert", name: "SYSTEM", body: `Chat source failed: ${error.message}` });
    }
  }

  tick() {
    const now = Date.now();
    const dt = Math.min(250, now - this.lastTick);
    this.lastTick = now;
    this.game.update(dt);

    if (now - this.lastState >= 1000 / STATE_HZ) {
      this.lastState = now;
      this.broadcast("state", this.snapshot());
    }
  }

  status() {
    return {
      ...(this.source ? this.source.status() : { source: "none", connected: false }),
      ...this.sourceStatus,
      viewers: this.clients.size,
      players: this.game.players.length,
      alive: this.game.alivePlayers().length,
      waiting: this.game.waiting.length,
      stats: this.stats,
    };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.source) this.source.stop();
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
