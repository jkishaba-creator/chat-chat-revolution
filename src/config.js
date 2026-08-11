// Board geometry (logical pixels; the canvas is drawn at 416x300 and scaled up).
export const COLS = 11;
export const ROWS = 7;
export const TILE = 32;
export const LOGICAL_W = 416;
export const LOGICAL_H = 300;
export const ARENA_X = (LOGICAL_W - COLS * TILE) / 2; // 32
export const ARENA_Y = 54;

export const MAX_MOVES = 5;
export const COL_LABELS = "ABCDEFGHIJK".split("");

export const PHASE = {
  PLAN: "plan",
  LOCK: "lock",
  RESOLVE: "resolve",
  IMPACT: "impact",
  BREAK: "break",
  GAMEOVER: "gameover",
};

export const TIMING = {
  lock: 380,
  step: 170,
  impact: 700,
  break: 1200,
  gameover: 6000,
};

// Solo play can shrink the planning window to reflex speed. Chat play cannot:
// YouTube delivers messages in polled batches, so the window must stay longer
// than one poll cycle or live chatters are locked out of every round.
export const PLAN_FLOOR_SOLO = 2800;
export const PLAN_FLOOR_CHAT = 9000;

// The window shrinks each round so pressure builds. The opening window scales
// with the floor, otherwise chat mode would sit at a flat 9s every round and
// lose that escalation entirely. Solo is unchanged: max(6200, 4480) = 6200.
export const planMs = (round, floor = PLAN_FLOOR_SOLO) => {
  const opening = Math.max(6200, floor * 1.6);
  return Math.max(floor, opening - (round - 1) * 320);
};

// The board is 11x7. Past this many live bodies it stops being readable and
// spawn cells run out, so extra chatters wait in a queue for the next match.
export const MAX_CHATTERS = 28;

// 縁 En-marks: a hazard square that spares everyone on it, and its neighbours,
// when enough players gather. Needs a crowd to be meaningful, and a couple of
// rounds of plain dodging first so the basic rule lands before the twist.
// 本日の瓦: one shared board per date. Capped because the daily is a single
// scored run, not an endurance match, and every round is precomputed up front.
export const DAILY_ROUNDS = 30;

export const EN_MARK_MIN_ROUND = 4;
export const EN_MARK_MIN_PLAYERS = 6;
export const EN_MARK_MIN_REQUIRED = 2;
export const EN_MARK_MAX_REQUIRED = 4;

export const PALETTE = {
  water: "#12244a",
  waterLight: "#1b3466",
  stone: "#5b6172",
  stoneDark: "#464c5c",
  wood: "#6b4230",
  woodDark: "#4a2c20",
  grid: "#d8b45c",
  gold: "#d8b45c",
  vermilion: "#e0483a",
  sakura: "#f2a8bd",
  paper: "#f4efe2",
  ink: "#141a26",
  bamboo: "#4f7a45",
  bambooDark: "#31512c",
  // 縁 En-mark ring. Indigo reads as "gather here" against the vermilion of
  // danger, and never competes with it for meaning.
  enMark: "#7fb3ff",
};

// Kimono / hair colours for characters.
export const SKINS = [
  { robe: "#e0483a", trim: "#f4efe2", hair: "#1b1b22" },
  { robe: "#3f6fd8", trim: "#d8b45c", hair: "#2a1c12" },
  { robe: "#4f9e5c", trim: "#f4efe2", hair: "#1b1b22" },
  { robe: "#8b5cd6", trim: "#f2a8bd", hair: "#4a2c20" },
  { robe: "#d8b45c", trim: "#141a26", hair: "#1b1b22" },
  { robe: "#f2a8bd", trim: "#8c2b22", hair: "#2a1c12" },
  { robe: "#2fa8a0", trim: "#f4efe2", hair: "#1b1b22" },
  { robe: "#f07a2a", trim: "#141a26", hair: "#4a2c20" },
  { robe: "#c8ccd8", trim: "#3f6fd8", hair: "#1b1b22" },
  { robe: "#7a1f2b", trim: "#d8b45c", hair: "#2a1c12" },
];

export const BOT_NAMES = [
  "KITSUNE99", "ramen_dad", "ShogunSam", "tanuki_tv", "HANABI", "mochi_mochi",
  "aoi_ame", "RONIN_77", "sakura_bot", "kappa_sensei", "YUKI", "TOFU_KING",
  "neko_neko", "DAIFUKU", "ZEN_MODE", "umeboshi", "genji_p", "OBI_WAN_KO",
  "shiba_inu", "matcha_ma", "HAYABUSA", "koi_no_yokan", "zenzen_ok", "BUSHIDO_B",
];

export const BOT_CHATTER = [
  "いくぞ", "no way", "gg", "rock C4 is mine", "counting squares…",
  "why do I always go left", "こわい", "trust the grid", "clutch", "run run run",
  "I ate a boulder", "lag diff", "one more round", "頑張れ", "ez",
];
