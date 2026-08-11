/**
 * Persistent chatter profiles, keyed by YouTube channel ID.
 *
 * A JSON file rather than a database: the data is a few hundred rows of
 * counters, the project has zero runtime dependencies, and node:sqlite is
 * still a release candidate that would force the Node floor up from 20.
 *
 * Railway's filesystem is ephemeral, so real persistence needs a mounted
 * volume with DATA_DIR pointed at it. Without one the store degrades to
 * memory and says so, because a missing volume must never take the game down.
 *
 * Privacy: this writes viewer display names and channel IDs to disk. Nothing
 * else is stored, and deleting the file erases every record.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const FILE = "profiles.json";
const VERSION = 1;
const FLUSH_MS = 2000;

/** Default season id: half-year buckets, e.g. 2026-S2. */
export function currentSeason(date = new Date()) {
  return `${date.getUTCFullYear()}-S${date.getUTCMonth() < 6 ? 1 : 2}`;
}

export class ProfileStore {
  constructor({ dir = process.env.DATA_DIR || "./data", season = process.env.SEASON_ID || currentSeason() } = {}) {
    this.dir = dir;
    this.season = season;
    this.path = join(dir, FILE);
    this.mode = "file";
    this.error = null;
    this.timer = null;
    this.dirty = false;
    this.data = { version: VERSION, seasons: {} };

    this.load();
  }

  load() {
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (error) {
      this.degrade(`cannot create ${this.dir}: ${error.message}`);
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.seasons) this.data = parsed;
    } catch (error) {
      // A missing file is the normal first run. Anything else means the file is
      // unreadable or corrupt: keep the old file, start fresh in memory.
      if (error.code !== "ENOENT") this.degrade(`cannot read profiles: ${error.message}`);
    }
    if (!this.data.seasons[this.season]) this.data.seasons[this.season] = {};
  }

  degrade(reason) {
    if (this.mode === "memory") return;
    this.mode = "memory";
    this.error = reason;
    console.error(`Profile store running in memory: ${reason}`);
  }

  table() {
    if (!this.data.seasons[this.season]) this.data.seasons[this.season] = {};
    return this.data.seasons[this.season];
  }

  profile(channelId, name) {
    const table = this.table();
    if (!table[channelId]) {
      table[channelId] = {
        name, matches: 0, wins: 0, rounds: 0, bestRound: 0, streak: 0, bestStreak: 0, lastSeen: null,
      };
    }
    if (name) table[channelId].name = name;
    return table[channelId];
  }

  /**
   * Fold one finished round into a profile.
   * `survived` extends the streak; being hit ends it and closes the match.
   */
  recordRound(channelId, name, { survived, roundsSurvived }) {
    if (!channelId) return null;
    const p = this.profile(channelId, name);
    p.lastSeen = new Date().toISOString();
    if (survived) {
      p.rounds += 1;
      p.streak += 1;
      if (p.streak > p.bestStreak) p.bestStreak = p.streak;
      if (roundsSurvived > p.bestRound) p.bestRound = roundsSurvived;
    } else {
      p.streak = 0;
      p.matches += 1;
      if (roundsSurvived > p.bestRound) p.bestRound = roundsSurvived;
    }
    this.touch();
    return p;
  }

  recordWin(channelId, name, roundsSurvived) {
    if (!channelId) return null;
    const p = this.profile(channelId, name);
    p.wins += 1;
    p.matches += 1;
    p.lastSeen = new Date().toISOString();
    if (roundsSurvived > p.bestRound) p.bestRound = roundsSurvived;
    this.touch();
    return p;
  }

  /** Top N of the current season: wins first, then deepest round reached. */
  leaderboard(limit = 10) {
    return Object.entries(this.table())
      .map(([id, p]) => ({ id, ...p }))
      .sort((a, b) => b.wins - a.wins || b.bestRound - a.bestRound || b.rounds - a.rounds)
      .slice(0, limit)
      .map(({ id, name, wins, bestRound, rounds, bestStreak }) => ({
        name, wins, bestRound, rounds, bestStreak,
      }));
  }

  status() {
    return {
      storage: this.mode,
      season: this.season,
      profiles: Object.keys(this.table()).length,
      storageError: this.error,
    };
  }

  touch() {
    this.dirty = true;
    if (this.mode === "memory" || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_MS);
    this.timer.unref?.();
  }

  /** Atomic: write a temp file then rename, so a crash cannot truncate the real one. */
  flush() {
    if (!this.dirty || this.mode === "memory") return;
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.data), "utf8");
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch (error) {
      this.degrade(`cannot write profiles: ${error.message}`);
    }
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.flush();
  }
}
