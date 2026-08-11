# 瓦落とし — Chat Chat Revolution

A chat-controlled dodging game. Everyone on the board is a chatter. Each round the roof tiles,
bells and boulders pick their squares, you get a few seconds to count grid squares, and then
everything lands at once.

Play solo: <https://chat-chat-revolution-production.up.railway.app>

Today's shared board: add `?daily`. See [本日の瓦 — the Daily Kawara](#本日の瓦--the-daily-kawara).

Chat-controlled mode runs at `/live.html` once it is switched on. See [Live chat mode](#live-chat-mode).

No build step, no image assets, no runtime dependencies. Run it locally with:

```bash
npm start          # serves on http://localhost:4173
```

Then open <http://localhost:4173>. `server.js` is a zero-dependency static server that
respects `$PORT`, so the same command runs locally and on a host like Railway.

## How to play

- The board is lettered **A–K** across and numbered **1–7** down. Distance is countable, so
  chat lag never matters: you plan in squares, not in reflexes.
- During **Plot your path** type up to **5 steps** into the chat box:
  - `l` left, `r` right, `u` up, `d` down
  - `rrud`, `r r u d`, `r3u` and `right right up` all work
  - only messages made entirely of moves count, so `lol` will not walk you left twice
  - with no text field focused, arrow keys append a step and Enter sends it
- Your path previews live on the board: pink dots for each step, a box on the square you land on.
- Red squares marked **危** are where things land. Standing on one when the timer ends flattens you.
- From round 3 stone lanterns, bamboo and torii pillars block squares, so a straight line back and
  forth stops working.
- From round 4, with 6 or more players, one danger square may carry a **縁 en-mark**: an indigo ring
  with a headcount, like `2/4`. Land enough people on it and everyone standing there survives, and
  the eight squares around it are spared too. See [縁 En-marks](#縁-en-marks).
- The number of falling objects climbs every round, and the planning window shrinks from 6.2s to 2.8s.

Chatters are eliminated for the rest of the match when hit and keep heckling as spirits. You respawn
every round. The match ends when one is left standing, then everyone comes back.

Every round is guaranteed survivable: the generator verifies that every living player has a safe
square within 5 steps before the round starts.

## 縁 En-marks

A cooperative option layered on a solo game. One telegraphed square also carries a required
headcount; gather that many people on it and the tiles break around them, sheltering that square and
its eight neighbours.

The mark is always placed **on an existing hazard**, never on a safe square. That is what keeps the
fairness guarantee intact: the danger set is unchanged, the escape check behaves identically, and
ignoring the mark entirely stays a valid way to survive. An en-mark only ever adds an option.

It is never colour-only — the ring shape and the `committed/required` numerals carry the meaning on
their own, and the count updates live as chatters commit their paths.

## 本日の瓦 — the Daily Kawara

`/?daily` runs one shared board. Everyone who plays on a given date gets the same 30 rounds, the same
obstacles and the same starting square, so results are comparable.

- **Solo and scored once.** No bots, no respawn: being hit ends the attempt. Only the first attempt of
  a day counts; replays are marked as practice.
- **Streaks** are kept in `localStorage` and extend when you play on consecutive days. Nothing is sent
  to the server — there is no daily leaderboard.
- **Rollover is UTC**, so the board changes at the same instant worldwide.

Reproducibility is the whole feature, so it is a stronger guarantee than in live play. The board is
precomputed from the date seed alone, before anyone has moved: the live generator reads player
positions, so two players who moved differently would consume different random draws and drift onto
different boards. Fairness is likewise position-free — **every** square on the board must have a safe
square within 5 steps, so the player survives wherever they happen to stand. `npm run test:daily`
asserts both, including that a fresh Node process produces a byte-identical plan.

## Live chat mode

The game can be driven by a real YouTube live chat. Viewers type `l` `r` `u` `d` in the
stream chat and their character moves on the board.

```bash
npm run live                      # fake chat, no YouTube account needed
```

Open <http://localhost:4173/live.html>. A simulated audience joins and plays, so the whole
system is testable before you ever go live.

To connect a real broadcast:

```bash
export YOUTUBE_API_KEY=...        # Google Cloud > YouTube Data API v3 > API key
export YOUTUBE_VIDEO=...          # video ID or any watch/live/youtu.be URL
CHAT_SOURCE=youtube npm start
```

Only an API key is needed, not OAuth, because a public broadcast's chat is readable with a
key alone. The chat ID is resolved through `videos.list` (1 unit); the 100-unit `search.list`
endpoint is never called.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CHAT_SOURCE` | `off` | `off`, `mock` or `youtube` |
| `YOUTUBE_API_KEY` | — | Required when `CHAT_SOURCE=youtube` |
| `YOUTUBE_VIDEO` | — | Video ID or URL of the live broadcast |
| `YOUTUBE_QUOTA_BUDGET` | `9000` | Self-imposed daily unit ceiling |
| `DATA_DIR` | `./data` | Where the 番付 profile store writes. See [番付](#番付--the-season-board) |
| `SEASON_ID` | half-year, e.g. `2026-S2` | Overrides the season bucket |

### How the chat rules work

- **Joining** is implicit: a first move command seats you. Plain conversation never moves anyone.
- **Identity** is the YouTube channel ID, so changing your display name mid-match cannot steal
  another player's character.
- **Arriving mid-round** means sitting out that round and entering at the next one. Being hit by
  a tile puts you out until the next match.
- **Capacity** is 28 players on an 11x7 board. Extra viewers queue, and each new match frees a
  slice of seats (bots first, then idle players, then the longest-tenured) so a queue is never
  locked out forever.
- **The planning window runs 14.4s down to a 9s floor** in chat mode, because YouTube delivers
  messages in polled batches roughly every 5s and a shorter window would lock chatters out of
  every round. Solo play is unchanged: 6.2s down to 2.8s.
- **Feedback on the board** is a gold commit mark above anyone whose path is locked in for the
  round, so a chatter can see their command landed before the tiles do.

### 番付 — the season board

Live mode keeps per-chatter records across matches and shows the top of the season in the live view:
wins, deepest round, rounds survived and best streak. Identity is the YouTube channel ID, so a
display-name change does not split or steal a record. Seasons bucket by half-year unless `SEASON_ID`
says otherwise, and `/api/leaderboard` serves the top 25 as JSON.

Storage is a single JSON file under `DATA_DIR`, written atomically (temp file, then rename) so a
crash cannot truncate it. There is no database: the data is a few hundred rows of counters and the
project has zero runtime dependencies.

**Railway's filesystem is ephemeral**, so real persistence needs a mounted volume with `DATA_DIR`
pointed at it. Without one the store degrades to memory and the live view labels the season
*(not saved)* — a missing volume must never take the game down.

**Privacy:** this writes viewer display names and channel IDs to disk. Nothing else is stored,
channel IDs are never served over HTTP, and deleting the file erases every record.

### Quota

The default allocation is 10,000 units/day, resetting at midnight Pacific. Polling costs 1 unit
per call and the poller honours the `pollingIntervalMillis` YouTube returns, backing off to 12s
when chat is quiet. At a 5s interval that is roughly 720 units/hour, so a normal stream fits
comfortably. The poller stops itself at `YOUTUBE_QUOTA_BUDGET` so it can never drain the whole
project allocation.

Measured against a real broadcast: connecting and polling a live chat for 45s ingested 19 messages
for 16 quota units, at a 6s interval chosen by YouTube. `liveChatMessages.list` bills 1 unit per
call, matching other `list` methods. Watch `/api/status` on your own stream to confirm the rate.

`search.list` costs 100 units and is never called at runtime. Finding a broadcast by channel would
need it, which is why `YOUTUBE_VIDEO` is a video, not a channel.

## Layout

| Path | What it is |
| --- | --- |
| `index.html` | Page shell, HUD, chat panel, accessibility text |
| `styles.css` | Layout, theme tokens, responsive and reduced-motion rules |
| `src/config.js` | Board geometry, timings, palette, chatter names |
| `src/game.js` | Rules: phases, hazard generation, fairness check, en-marks, bot planning, move parser |
| `src/daily.js` | 本日の瓦: date-seeded round plan, local result and streak tracking |
| `src/rng.js` | Seeded PRNG (xmur3 + mulberry32) and the UTC date key |
| `src/render.js` | All the pixel art, drawn procedurally on canvas |
| `src/chat.js` | Chat log rendering |
| `src/main.js` | Wiring: input, HUD, bot chatter, frame loop |
| `live.html` / `src/live.js` | Live view: renders the server's game, no local input |
| `src/remote.js` | Adapts a server snapshot to the shape the renderer expects |
| `chat/bridge.js` | Authoritative game + chat intake + SSE broadcast |
| `chat/sources/youtube.js` | Quota-aware YouTube live chat poller |
| `chat/sources/mock.js` | Simulated audience for offline testing |
| `chat/store.js` | 番付: seasonal chatter profiles, atomically persisted JSON |
| `server.js` | Zero-dependency static server for local dev and deploys |
| `server.test.mjs` | Asserts `.env` and other private files stay unreachable over HTTP |
| `daily.test.mjs` | Asserts the daily board is reproducible and every cell can escape |
| `railway.json` | Deploy config: skips dev dependencies, starts `npm start` |
| `DESIGN.md` | Design read, thesis and accessibility notes |

## Checks

```bash
npm test            # everything below
npm run test:rules  # headless soak: ~950 rounds, rule invariants, move parser
npm run test:daily  # daily board determinism, escape guarantee, streak rules
npm run test:chat   # chat intake, capacity, seat rotation, profile store, YouTube poller
npm run test:server # private files stay unreachable, game files stay served
npm run shots       # Playwright screenshots of plan / late round / impact / game over / mobile
```

`server.js` hosts its own project directory, which is where `.env` lives, so dotfiles and
`node_modules` are refused over HTTP. `npm run test:server` is what keeps that true.

`npm run shots` needs the dev server running and `npx playwright install chromium` once.

## Deploy

```bash
railway up
```

Railway deploys from the local directory, so a `git push` alone does not redeploy. Connect the
GitHub repo in the Railway dashboard if you want pushes to deploy automatically.
