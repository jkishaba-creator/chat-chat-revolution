import {
  COLS, ROWS, TILE, ARENA_X, ARENA_Y, LOGICAL_W, LOGICAL_H,
  PHASE, PALETTE as C, COL_LABELS, TIMING,
} from "./config.js";

const ARENA_W = COLS * TILE;
const ARENA_H = ROWS * TILE;

export class Renderer {
  constructor(canvas, { reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.reducedMotion = reducedMotion;
    this.petals = Array.from({ length: 26 }, () => this.spawnPetal(true));
    this.waves = Array.from({ length: 40 }, () => ({
      x: Math.random() * LOGICAL_W,
      y: Math.random() * LOGICAL_H,
      w: 3 + Math.floor(Math.random() * 5),
      phase: Math.random() * Math.PI * 2,
    }));
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  spawnPetal(seed = false) {
    return {
      x: Math.random() * LOGICAL_W,
      y: seed ? Math.random() * LOGICAL_H : -6,
      vx: 4 + Math.random() * 10,
      vy: 6 + Math.random() * 12,
      sway: Math.random() * Math.PI * 2,
      size: Math.random() < 0.4 ? 2 : 1,
    };
  }

  resize() {
    const wrap = this.canvas.parentElement;
    const available = wrap ? wrap.clientWidth - 12 : LOGICAL_W;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.max(1, Math.min(4, Math.floor((available * dpr) / LOGICAL_W)));
    this.scale = scale;
    // Below this width the 8px nameplates turn to mush, so only yours is drawn.
    this.compact = available < 560;
    this.canvas.width = LOGICAL_W * scale;
    this.canvas.height = LOGICAL_H * scale;
  }

  /* --------------------------------------------------------------- */

  draw(game, dt) {
    const ctx = this.ctx;
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.textBaseline = "alphabetic";

    this.t = (this.t || 0) + dt;

    this.drawSky(game);
    ctx.save();
    if (game.shake > 0 && !this.reducedMotion) {
      const s = game.shake * 2.5;
      ctx.translate(Math.round((Math.random() - 0.5) * s), Math.round((Math.random() - 0.5) * s));
    }
    this.drawArena(game);
    this.drawGrid(game);
    this.drawTelegraphs(game);
    this.drawObstacles(game);
    this.drawActors(game);
    this.drawFalling(game);
    this.drawEffects(game);
    ctx.restore();
    this.drawPetals(dt);
    this.drawBanner(game);
  }

  rect(x, y, w, h, color) {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  pixelCircle(cx, cy, r, color) {
    for (let dy = -r; dy <= r; dy++) {
      const w = Math.floor(Math.sqrt(r * r - dy * dy));
      if (w <= 0) continue;
      this.rect(cx - w, cy + dy, w * 2, 1, color);
    }
  }

  text(str, x, y, { size = 7, color = C.paper, align = "center", outline = C.ink, weight = "" } = {}) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px "DotGothic16", monospace`.trim();
    ctx.textAlign = align;
    if (outline) {
      ctx.fillStyle = outline;
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) ctx.fillText(str, x + ox, y + oy);
    }
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  /* --------------------------------------------------------------- */

  drawSky() {
    const ctx = this.ctx;
    const grad = ctx.createLinearGradient(0, 0, 0, LOGICAL_H);
    grad.addColorStop(0, "#101d38");
    grad.addColorStop(0.55, "#0d1830");
    grad.addColorStop(1, "#0a1226");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, LOGICAL_W, LOGICAL_H);

    // Moon
    this.pixelCircle(LOGICAL_W - 50, 25, 14, "#f7f2e4");
    this.rect(LOGICAL_W - 56, 18, 5, 4, "#e4ddca");
    this.rect(LOGICAL_W - 46, 30, 4, 3, "#e4ddca");
    this.rect(LOGICAL_W - 45, 16, 3, 3, "#e4ddca");

    // Distant hills
    this.hill(40, 46, 70, 22, "#16233f");
    this.hill(120, 44, 96, 26, "#131f38");
    this.hill(250, 46, 120, 24, "#16233f");

    // Torii gate behind the courtyard
    this.torii(LOGICAL_W / 2, 44);

    // Water surrounding the platform
    this.drawWater();
  }

  hill(x, baseY, w, h, color) {
    for (let i = 0; i < h; i++) {
      const ratio = i / h;
      const width = Math.round(w * (1 - ratio * 0.82));
      this.rect(x + (w - width) / 2, baseY - i, width, 1, color);
    }
  }

  torii(cx, baseY) {
    const red = "#7d2a26";
    const top = baseY - 34;
    this.rect(cx - 34, top, 68, 4, red);
    this.rect(cx - 38, top - 4, 76, 3, "#8d332c");
    this.rect(cx - 26, top + 10, 52, 3, red);
    this.rect(cx - 22, top + 4, 5, baseY - top - 4, red);
    this.rect(cx + 17, top + 4, 5, baseY - top - 4, red);
  }

  drawWater() {
    const ctx = this.ctx;
    ctx.fillStyle = C.water;
    ctx.fillRect(0, ARENA_Y - 18, LOGICAL_W, ARENA_H + 44);
    // Ripple dashes
    for (const w of this.waves) {
      const y = ARENA_Y - 18 + ((w.y + (this.reducedMotion ? 0 : this.t * 0.004)) % (ARENA_H + 44));
      const x = (w.x + Math.sin(w.phase + this.t * 0.001) * 4) % LOGICAL_W;
      if (x > ARENA_X - 24 && x < ARENA_X + ARENA_W + 8 && y > ARENA_Y - 12 && y < ARENA_Y + ARENA_H + 12) continue;
      this.rect(x, y, w.w, 1, C.waterLight);
    }
  }

  drawArena() {
    // Stone base with a wooden lip, sitting in the water.
    this.rect(ARENA_X - 6, ARENA_Y - 6, ARENA_W + 12, ARENA_H + 16, C.woodDark);
    this.rect(ARENA_X - 4, ARENA_Y - 4, ARENA_W + 8, ARENA_H + 10, C.wood);
    this.rect(ARENA_X - 2, ARENA_Y - 2, ARENA_W + 4, ARENA_H + 4, C.stoneDark);
    this.rect(ARENA_X, ARENA_Y, ARENA_W, ARENA_H, C.stone);

    // Tatami-ish alternating slabs
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if ((x + y) % 2 === 0) {
          this.rect(ARENA_X + x * TILE, ARENA_Y + y * TILE, TILE, TILE, "#676d81");
        }
      }
    }

    // Faint sun disc painted on the floor
    const cx = ARENA_X + ARENA_W / 2;
    const cy = ARENA_Y + ARENA_H / 2;
    const ctx = this.ctx;
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = C.vermilion;
    ctx.beginPath();
    ctx.arc(cx, cy, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Corner lanterns on the wooden lip
    this.cornerLantern(ARENA_X - 4, ARENA_Y - 4);
    this.cornerLantern(ARENA_X + ARENA_W - 2, ARENA_Y - 4);
    this.cornerLantern(ARENA_X - 4, ARENA_Y + ARENA_H + 2);
    this.cornerLantern(ARENA_X + ARENA_W - 2, ARENA_Y + ARENA_H + 2);
  }

  cornerLantern(x, y) {
    const glow = this.reducedMotion ? 1 : 0.75 + Math.sin(this.t * 0.004 + x) * 0.25;
    this.rect(x, y, 6, 6, C.woodDark);
    this.rect(x + 1, y + 1, 4, 4, "#e8b95a");
    this.ctx.globalAlpha = 0.35 * glow;
    this.rect(x - 1, y - 1, 8, 8, "#e8b95a");
    this.ctx.globalAlpha = 1;
  }

  drawGrid(game) {
    const ctx = this.ctx;
    ctx.globalAlpha = 0.34;
    for (let x = 1; x < COLS; x++) this.rect(ARENA_X + x * TILE, ARENA_Y, 1, ARENA_H, C.grid);
    for (let y = 1; y < ROWS; y++) this.rect(ARENA_X, ARENA_Y + y * TILE, ARENA_W, 1, C.grid);
    ctx.globalAlpha = 1;

    // Counting guide: your own row and column stay lit so distance is countable.
    const me = game.human();
    const lit = me && me.alive ? { x: me.x, y: me.y } : null;
    if (lit) {
      ctx.globalAlpha = 0.16;
      this.rect(ARENA_X + lit.x * TILE, ARENA_Y, TILE, ARENA_H, C.sakura);
      this.rect(ARENA_X, ARENA_Y + lit.y * TILE, ARENA_W, TILE, C.sakura);
      ctx.globalAlpha = 1;
    }

    for (let x = 0; x < COLS; x++) {
      const on = lit && lit.x === x;
      this.text(COL_LABELS[x], ARENA_X + x * TILE + TILE / 2, ARENA_Y - 8, {
        size: on ? 9 : 8,
        color: on ? C.sakura : C.gold,
      });
    }
    for (let y = 0; y < ROWS; y++) {
      const on = lit && lit.y === y;
      this.text(String(y + 1), ARENA_X - 10, ARENA_Y + y * TILE + TILE / 2 + 3, {
        size: on ? 9 : 8,
        color: on ? C.sakura : C.gold,
      });
    }
  }

  /* --------------------------------------------------------------- */

  drawTelegraphs(game) {
    if (![PHASE.PLAN, PHASE.LOCK, PHASE.RESOLVE].includes(game.phase)) return;
    const ctx = this.ctx;
    const urgency = 1 - game.planProgress();
    const pulse = this.reducedMotion ? 0.65 : 0.45 + Math.abs(Math.sin(this.t * (0.004 + urgency * 0.006))) * 0.45;

    for (const h of game.hazards) {
      const px = ARENA_X + h.x * TILE;
      const py = ARENA_Y + h.y * TILE;

      ctx.globalAlpha = 0.22 * pulse + 0.12;
      this.rect(px + 1, py + 1, TILE - 2, TILE - 2, C.vermilion);
      ctx.globalAlpha = 1;

      // Corner brackets so the target reads even without colour.
      const b = 6;
      for (const [ox, oy, dx, dy] of [
        [1, 1, 1, 1], [TILE - 2, 1, -1, 1], [1, TILE - 2, 1, -1], [TILE - 2, TILE - 2, -1, -1],
      ]) {
        this.rect(px + ox + (dx < 0 ? -b + 1 : 0), py + oy, b, 1, C.vermilion);
        this.rect(px + ox, py + oy + (dy < 0 ? -b + 1 : 0), 1, b, C.vermilion);
      }

      // Growing shadow: how close the impact is.
      const grow = 4 + urgency * 9;
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = "#0a1020";
      ctx.beginPath();
      ctx.ellipse(px + TILE / 2, py + TILE / 2 + 4, grow, grow * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      this.text("危", px + TILE / 2, py + TILE / 2 + 4, { size: 11, color: C.vermilion, outline: "#2a0c0a" });
    }
  }

  drawObstacles(game) {
    for (const o of game.obstacles) {
      const px = ARENA_X + o.x * TILE;
      const py = ARENA_Y + o.y * TILE;
      this.shadow(px + TILE / 2, py + TILE - 6, 9);
      if (o.kind === "lantern") this.lantern(px, py);
      else if (o.kind === "bamboo") this.bamboo(px, py);
      else this.pillar(px, py);
    }
  }

  shadow(cx, cy, r) {
    const ctx = this.ctx;
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = "#0a1020";
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  lantern(px, py) {
    const cx = px + TILE / 2;
    const base = py + TILE - 6;
    this.rect(cx - 7, base - 3, 14, 3, "#3f4453");
    this.rect(cx - 5, base - 9, 10, 6, "#7b8194");
    this.rect(cx - 4, base - 16, 8, 7, "#8d93a6");
    this.rect(cx - 3, base - 15, 6, 5, "#f0c65a");
    this.rect(cx - 8, base - 20, 16, 4, "#5d6274");
    this.rect(cx - 9, base - 21, 18, 2, "#454a5b");
    this.rect(cx - 1, base - 24, 2, 3, "#5d6274");
  }

  bamboo(px, py) {
    const cx = px + TILE / 2;
    const base = py + TILE - 6;
    const stalks = [[-6, 20], [0, 26], [5, 17]];
    for (const [ox, h] of stalks) {
      this.rect(cx + ox, base - h, 3, h, C.bamboo);
      for (let s = 4; s < h; s += 6) this.rect(cx + ox, base - s, 3, 1, C.bambooDark);
    }
    this.rect(cx + 2, base - 26, 7, 2, C.bamboo);
    this.rect(cx - 12, base - 19, 7, 2, C.bamboo);
  }

  pillar(px, py) {
    const cx = px + TILE / 2;
    const base = py + TILE - 6;
    this.rect(cx - 6, base - 2, 12, 3, "#3f4453");
    this.rect(cx - 4, base - 22, 8, 20, "#8d332c");
    this.rect(cx - 4, base - 22, 3, 20, "#a03d34");
    this.rect(cx - 7, base - 26, 14, 4, "#5d2320");
  }

  /* --------------------------------------------------------------- */

  drawActors(game) {
    const sorted = [...game.players].sort((a, b) => a.ry - b.ry);
    for (const p of sorted) {
      const px = ARENA_X + p.rx * TILE;
      const py = ARENA_Y + p.ry * TILE;
      if (p.alive) {
        this.drawPath(game, p);
        this.shadow(px + TILE / 2, py + TILE - 6, 7);
        this.character(p, px, py, game);
      } else if (p.spectating) {
        this.ghost(p, px, py);
      }
    }
  }

  drawPath(game, p) {
    if (p.id !== game.humanId || !p.queue.length) return;
    if (![PHASE.PLAN, PHASE.LOCK].includes(game.phase)) return;
    const ctx = this.ctx;
    const blockedSet = new Set(game.obstacles.map((o) => `${o.x},${o.y}`));
    let x = p.x;
    let y = p.y;
    const dirs = { l: [-1, 0], r: [1, 0], u: [0, -1], d: [0, 1] };
    ctx.globalAlpha = 0.85;
    for (const mv of p.queue) {
      const [dx, dy] = dirs[mv];
      const nx = x + dx;
      const ny = y + dy;
      const ok = nx >= 0 && ny >= 0 && nx < COLS && ny < ROWS && !blockedSet.has(`${nx},${ny}`);
      if (ok) { x = nx; y = ny; }
      const cx = ARENA_X + x * TILE + TILE / 2;
      const cy = ARENA_Y + y * TILE + TILE / 2;
      this.rect(cx - 2, cy - 2, 4, 4, ok ? C.sakura : C.vermilion);
    }
    // Landing marker
    const cx = ARENA_X + x * TILE;
    const cy = ARENA_Y + y * TILE;
    ctx.globalAlpha = 0.9;
    this.rect(cx + 2, cy + 2, TILE - 4, 1, C.sakura);
    this.rect(cx + 2, cy + TILE - 3, TILE - 4, 1, C.sakura);
    this.rect(cx + 2, cy + 2, 1, TILE - 4, C.sakura);
    this.rect(cx + TILE - 3, cy + 2, 1, TILE - 4, C.sakura);
    ctx.globalAlpha = 1;
  }

  character(p, px, py, game) {
    const cx = px + TILE / 2;
    const base = py + TILE - 6;
    const skin = p.skin;
    const isYou = p.id === game.humanId;
    const bob = this.reducedMotion ? 0 : Math.round(Math.sin(this.t * 0.006 + p.rx) * 0.5);
    const b = base + bob;

    // Outline block
    this.rect(cx - 6, b - 20, 12, 20, "#12161f");
    // Legs
    this.rect(cx - 4, b - 4, 3, 4, "#2b2f3c");
    this.rect(cx + 1, b - 4, 3, 4, "#2b2f3c");
    // Robe
    this.rect(cx - 5, b - 13, 10, 10, skin.robe);
    this.rect(cx - 5, b - 7, 10, 2, skin.trim);
    this.rect(cx - 7, b - 13, 2, 7, skin.robe);
    this.rect(cx + 5, b - 13, 2, 7, skin.robe);
    // Head
    this.rect(cx - 4, b - 20, 8, 8, "#f0c9a0");
    this.rect(cx - 5, b - 22, 10, 4, skin.hair);
    this.rect(cx - 5, b - 19, 2, 4, skin.hair);
    this.rect(cx + 3, b - 19, 2, 4, skin.hair);
    // Eyes
    const eye = p.face >= 0 ? 0 : -1;
    this.rect(cx - 3 + eye, b - 17, 1, 2, "#141a26");
    this.rect(cx + 1 + eye, b - 17, 1, 2, "#141a26");

    if (p.bumped && game.phase === PHASE.RESOLVE) {
      this.text("!", cx + 8, b - 20, { size: 9, color: C.vermilion });
    }

    // Commit tick. In the live view nobody owns a path preview, so this is the
    // only on-board proof that a chatter's command was received before impact.
    // Sits beside the head, clear of the nameplate baseline at b - 25.
    if (p.queue.length && (game.phase === PHASE.PLAN || game.phase === PHASE.LOCK)) {
      this.rect(cx + 7, b - 17, 1, 2, C.ink);
      this.rect(cx + 8, b - 15, 1, 2, C.ink);
      this.rect(cx + 7, b - 18, 1, 2, C.gold);
      this.rect(cx + 8, b - 16, 1, 2, C.gold);
      this.rect(cx + 9, b - 20, 1, 4, C.gold);
    }

    if (this.compact && !isYou) return;
    const label = p.name.length > 12 ? `${p.name.slice(0, 11)}…` : p.name;
    this.text(label, cx, b - 25, {
      size: 8,
      color: isYou ? C.sakura : C.paper,
      outline: "#0a0f1a",
    });
    if (isYou) this.rect(cx - 1, b - 31, 2, 2, C.sakura);
  }

  ghost(p, px, py) {
    const ctx = this.ctx;
    const cx = px + TILE / 2;
    const base = py + TILE - 8;
    const drift = this.reducedMotion ? 0 : Math.sin(this.t * 0.003 + p.ry) * 2;
    ctx.globalAlpha = 0.45;
    this.rect(cx - 4, base - 10 + drift, 8, 8, "#9fd3e8");
    this.rect(cx - 3, base - 12 + drift, 6, 3, "#c9ecf7");
    this.rect(cx - 2, base - 8 + drift, 1, 2, "#0a1020");
    this.rect(cx + 1, base - 8 + drift, 1, 2, "#0a1020");
    this.text(p.name, cx, base - 15 + drift, { size: 7, color: "#9fb3d0", outline: "#0a0f1a" });
    ctx.globalAlpha = 1;
  }

  /* --------------------------------------------------------------- */

  drawFalling(game) {
    if (game.phase === PHASE.BREAK || game.phase === PHASE.GAMEOVER) {
      // Wreckage from the round that just landed.
      for (const h of game.hazards) {
        this.hazardSprite(h, ARENA_X + h.x * TILE, ARENA_Y + h.y * TILE);
      }
      return;
    }
    if (game.phase !== PHASE.IMPACT) return;
    const elapsed = TIMING.impact - game.timeLeft();
    const t = Math.min(1, elapsed / (TIMING.impact * 0.72));
    const eased = t * t;

    for (const h of game.hazards) {
      const px = ARENA_X + h.x * TILE;
      const py = ARENA_Y + h.y * TILE;
      const startY = ARENA_Y - 90;
      const y = startY + (py - startY) * eased;

      if (t < 1) {
        this.shadow(px + TILE / 2, py + TILE - 8, 6 + 8 * eased);
        this.hazardSprite(h, px, y);
      } else {
        this.hazardSprite(h, px, py);
        this.dust(px + TILE / 2, py + TILE - 6, (elapsed - TIMING.impact * 0.72) / (TIMING.impact * 0.28));
      }
    }
  }

  hazardSprite(h, px, py) {
    const cx = px + TILE / 2;
    const cy = py + TILE / 2;
    // Dark silhouette under each hazard so it separates from the stone floor.
    const ink = "#0f1420";
    if (h.type === "tile") {
      this.rect(cx - 12, cy - 8, 24, 15, ink);
    } else if (h.type === "bell") {
      this.rect(cx - 9, cy - 15, 18, 5, ink);
      this.rect(cx - 11, cy - 9, 22, 18, ink);
    } else {
      this.rect(cx - 11, cy - 9, 22, 18, ink);
      this.rect(cx - 13, cy - 5, 26, 12, ink);
    }

    if (h.type === "tile") {
      this.rect(cx - 11, cy - 5, 22, 10, "#2f3a4d");
      this.rect(cx - 11, cy - 7, 22, 3, "#43506a");
      this.rect(cx - 9, cy + 3, 18, 2, "#1d2533");
      this.rect(cx - 6, cy - 4, 3, 7, "#5a6480");
    } else if (h.type === "bell") {
      this.rect(cx - 8, cy - 8, 16, 12, "#6b6250");
      this.rect(cx - 10, cy + 4, 20, 4, "#4e4839");
      this.rect(cx - 6, cy - 11, 12, 3, "#7d7461");
      this.rect(cx - 2, cy - 14, 4, 3, "#4e4839");
      this.rect(cx - 6, cy - 5, 3, 8, "#8a8069");
    } else {
      this.rect(cx - 10, cy - 8, 20, 16, "#6d6f78");
      this.rect(cx - 12, cy - 4, 24, 10, "#6d6f78");
      this.rect(cx - 10, cy - 8, 8, 6, "#83858f");
      this.rect(cx + 2, cy + 1, 6, 5, "#55575f");
      this.rect(cx - 4, cy - 2, 3, 3, "#55575f");
    }
  }

  dust(cx, cy, t) {
    const ctx = this.ctx;
    const r = 6 + t * 22;
    ctx.globalAlpha = Math.max(0, 0.55 * (1 - t));
    ctx.strokeStyle = "#cdd4e2";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 0.4, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  drawEffects(game) {
    for (const e of game.effects) {
      const t = 1 - e.life / e.max;
      const cx = ARENA_X + e.x * TILE + TILE / 2;
      const cy = ARENA_Y + e.y * TILE + TILE / 2;
      if (e.kind === "splat") {
        const ctx = this.ctx;
        ctx.globalAlpha = Math.max(0, 1 - t);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const d = 4 + t * 14;
          this.rect(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.5, 2, 2, C.sakura);
        }
        this.text("×", cx, cy + 3, { size: 12, color: C.vermilion });
        ctx.globalAlpha = 1;
      }
    }
  }

  drawPetals(dt) {
    if (this.reducedMotion) return;
    const step = dt / 1000;
    for (const p of this.petals) {
      p.y += p.vy * step;
      p.x += Math.sin(p.sway + this.t * 0.002) * p.vx * step;
      if (p.y > LOGICAL_H + 4) Object.assign(p, this.spawnPetal(false));
      this.ctx.globalAlpha = 0.75;
      this.rect(p.x, p.y, p.size, p.size, C.sakura);
    }
    this.ctx.globalAlpha = 1;
  }

  drawBanner(game) {
    let jp = null;
    let en = null;
    if (game.phase === PHASE.GAMEOVER) {
      jp = game.winner ? "勝ち" : "全滅";
      en = game.winner ? `${game.winner.name} wins round ${game.round}` : "Everyone flattened";
    } else if (game.phase === PHASE.LOCK) {
      jp = "確定";
      en = "Paths locked";
    } else if (game.phase === PHASE.BREAK && game.round > 0) {
      jp = "生存";
      en = `Round ${game.round} survived`;
    }
    if (!jp) return;

    const ctx = this.ctx;
    const y = LOGICAL_H / 2 - 22;
    ctx.globalAlpha = 0.86;
    this.rect(0, y, LOGICAL_W, 44, "#0a1020");
    ctx.globalAlpha = 1;
    this.rect(0, y, LOGICAL_W, 1, C.gold);
    this.rect(0, y + 43, LOGICAL_W, 1, C.gold);

    this.pixelCircle(LOGICAL_W / 2 - 74, y + 22, 13, C.vermilion);

    this.text(jp, LOGICAL_W / 2, y + 22, { size: 18, color: C.paper });
    this.text(en, LOGICAL_W / 2, y + 36, { size: 9, color: C.gold, outline: null });
  }
}
