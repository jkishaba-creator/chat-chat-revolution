/**
 * Deterministic pseudo-random numbers.
 *
 * The Daily Kawara gives every player the same board on a given date, which
 * only works if generation is reproducible. Math.random cannot be seeded, so
 * the game accepts an injectable rng and the daily path supplies this one.
 */

/** Hash a string to a 32-bit unsigned integer (xmur3), for seeding from a date. */
export function hashSeed(str) {
  let h = 1779033703 ^ String(str).length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** Mulberry32: a small, fast, well-distributed 32-bit PRNG. Public domain. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience: a seeded generator from any string, such as "ccr-2026-08-10". */
export function rngFrom(str) {
  return mulberry32(hashSeed(str));
}

/** UTC date key, so the daily rolls over at the same instant worldwide. */
export function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
