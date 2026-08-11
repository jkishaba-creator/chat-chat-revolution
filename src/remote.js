/**
 * Presents a server snapshot with the same surface the Renderer expects, so the
 * live view reuses the whole existing renderer instead of duplicating it.
 *
 * State arrives ~10 times a second. Between packets the positions are eased
 * locally, otherwise characters would visibly stutter at the packet rate.
 */
import { PHASE } from "./config.js";

export class RemoteGame {
  constructor() {
    this.phase = PHASE.BREAK;
    this.round = 0;
    this.players = [];
    this.hazards = [];
    this.obstacles = [];
    this.effects = [];
    this.enMark = null;
    this.shake = 0;
    this.winner = null;
    this.waiting = 0;
    this.humanId = null; // No local player in the live view.
    this.planDuration = 6200;
    this.phaseDuration = 1;
    this._timeLeft = 0;
    this.snapMotion = false;
    this.byId = new Map();
  }

  apply(state) {
    this.phase = state.phase;
    this.round = state.round;
    this.hazards = state.hazards;
    this.obstacles = state.obstacles;
    this.enMark = state.enMark;
    this.effects = state.effects;
    this.shake = state.shake;
    this.waiting = state.waiting;
    this.planDuration = state.planDuration || this.planDuration;
    this.phaseDuration = state.phaseDuration || 1;
    this._timeLeft = state.timeLeft;
    // The renderer reads winner.name.
    this.winner = state.winner ? { name: state.winner } : null;

    const next = [];
    for (const incoming of state.players) {
      const existing = this.byId.get(incoming.id);
      if (existing) {
        // Keep the eased drawing position; snap only on a big jump (respawn).
        const jumped = Math.abs(existing.x - incoming.x) > 2 || Math.abs(existing.y - incoming.y) > 2;
        Object.assign(existing, incoming);
        if (jumped) {
          existing.rx = incoming.x;
          existing.ry = incoming.y;
        }
        next.push(existing);
      } else {
        const fresh = { ...incoming, rx: incoming.x, ry: incoming.y };
        this.byId.set(incoming.id, fresh);
        next.push(fresh);
      }
    }
    const live = new Set(state.players.map((p) => p.id));
    for (const id of this.byId.keys()) if (!live.has(id)) this.byId.delete(id);
    this.players = next;
  }

  // Called every animation frame between state packets.
  interpolate(dt) {
    const k = this.snapMotion ? 1 : Math.min(1, dt / 90);
    for (const p of this.players) {
      p.rx += (p.x - p.rx) * k;
      p.ry += (p.y - p.ry) * k;
    }
    this._timeLeft = Math.max(0, this._timeLeft - dt);
    this.shake = Math.max(0, this.shake - dt / 220);
  }

  /* The three methods the renderer calls. */

  human() {
    return null;
  }

  timeLeft() {
    return this._timeLeft;
  }

  planProgress() {
    return Math.max(0, Math.min(1, this._timeLeft / (this.planDuration || 1)));
  }

  alivePlayers() {
    return this.players.filter((p) => p.alive);
  }

  // The server counts commitments; the live view just reports what it was sent.
  enMarkCommitted() {
    return this.enMark?.committed ?? 0;
  }
}
